/** OpenAI-compatible FreeLLMAPI provider adapter.
 *
 * This module is deliberately a transport adapter only: it calls the provider
 * API and never starts an agent loop or owns session state.
 */

export type ProviderErrorCode =
  | "authentication"
  | "rate_limited"
  | "timeout"
  | "aborted"
  | "http_error"
  | "invalid_response";

export class FreeLLMAPIError extends Error {
  readonly code: ProviderErrorCode;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(code: ProviderErrorCode, message: string, options: { status?: number; retryAfterMs?: number } = {}) {
    super(message);
    this.name = "FreeLLMAPIError";
    this.code = code;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export interface ProviderConfig {
  /** Example: https://api.example.test (the /v1 suffix is optional). */
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly defaultModel?: string;
  readonly timeoutMs?: number;
  readonly organization?: string;
  readonly fetch?: typeof globalThis.fetch;
}

export interface ProviderContext {
  readonly sessionId: string;
  readonly runId: string;
  readonly signal?: AbortSignal;
  readonly audit?: (record: ProviderAuditRecord) => Promise<void> | void;
  readonly emit?: (event: ProviderEvent) => Promise<void> | void;
}

export interface ProviderAuditRecord {
  readonly adapterId: "provider.freellmapi";
  readonly operation: string;
  readonly access: "read" | "write";
  readonly outcome: "succeeded" | "failed";
  readonly sessionId: string;
  readonly runId: string;
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
  readonly occurredAt: string;
}

export type ProviderEvent =
  | { readonly type: "adapter.operation.completed"; readonly adapterId: "provider.freellmapi"; readonly operation: string; readonly access: "read" | "write"; readonly sessionId: string; readonly runId: string }
  | { readonly type: "adapter.operation.failed"; readonly adapterId: "provider.freellmapi"; readonly operation: string; readonly access: "read" | "write"; readonly sessionId: string; readonly runId: string; readonly errorCode: ProviderErrorCode };

export interface ModelInfo { readonly id: string; readonly object?: string; readonly created?: number; readonly owned_by?: string; readonly [key: string]: unknown }
export interface ModelsResponse { readonly object?: string; readonly data: readonly ModelInfo[] }
export interface ChatMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content?: string | null;
  readonly name?: string;
  readonly tool_call_id?: string;
  readonly tool_calls?: readonly ToolCall[];
}
export interface ToolDefinition { readonly type: "function"; readonly function: { readonly name: string; readonly description?: string; readonly parameters?: unknown } }
export interface ToolCall { readonly id?: string; readonly type?: "function"; readonly function?: { readonly name?: string; readonly arguments?: string } }
export interface ChatCompletionRequest {
  readonly model?: string;
  readonly messages: readonly ChatMessage[];
  readonly tools?: readonly ToolDefinition[];
  readonly tool_choice?: unknown;
  readonly temperature?: number;
  readonly max_tokens?: number;
  readonly stream?: boolean;
  readonly [key: string]: unknown;
}
export interface ChatCompletionChoice { readonly index: number; readonly message?: ChatMessage; readonly delta?: Partial<ChatMessage>; readonly finish_reason?: string | null }
export interface ChatCompletionResponse { readonly id?: string; readonly object?: string; readonly model?: string; readonly choices: readonly ChatCompletionChoice[]; readonly usage?: Record<string, number> }
export interface StreamResult { readonly id?: string; readonly model?: string; readonly content: string; readonly toolCalls: readonly ToolCall[]; readonly finishReason?: string | null; readonly usage?: Record<string, number> }

export class FreeLLMAPIProvider {
  readonly id = "provider.freellmapi" as const;
  readonly capabilities = { read: true, write: false, streaming: true, resume: false, cancel: true, approval: false } as const;
  private readonly config: ProviderConfig;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly baseUrl: string;

  constructor(config: ProviderConfig) {
    let parsedBaseUrl: URL;
    try {
      parsedBaseUrl = new URL(config.baseUrl);
    } catch {
      throw new TypeError("baseUrl must be an absolute HTTP(S) URL without credentials");
    }
    if (!["http:", "https:"].includes(parsedBaseUrl.protocol) || parsedBaseUrl.username || parsedBaseUrl.password || parsedBaseUrl.search || parsedBaseUrl.hash) {
      throw new TypeError("baseUrl must be an absolute HTTP(S) URL without credentials, query, or fragment");
    }

    const apiKey = typeof config.apiKey === "string" ? config.apiKey.trim() : "";
    if (!apiKey) throw new TypeError("apiKey is required");
    const timeoutMs = config.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
      throw new RangeError("timeoutMs must be an integer from 1 to 120000");
    }
    if (config.defaultModel !== undefined && (typeof config.defaultModel !== "string" || !config.defaultModel.trim())) {
      throw new TypeError("defaultModel must be a non-empty string when provided");
    }
    if (config.organization !== undefined && (typeof config.organization !== "string" || !config.organization.trim())) {
      throw new TypeError("organization must be a non-empty string when provided");
    }

    const fetchImpl = config.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== "function") throw new TypeError("fetch must be a function");
    const basePath = parsedBaseUrl.pathname.replace(/\/+$/, "").replace(/\/v1$/i, "");
    const baseUrl = `${parsedBaseUrl.origin}${basePath}`;
    this.config = {
      ...config,
      baseUrl,
      apiKey,
      timeoutMs,
      ...(config.defaultModel === undefined ? {} : { defaultModel: config.defaultModel.trim() }),
      ...(config.organization === undefined ? {} : { organization: config.organization.trim() }),
    };
    this.fetchImpl = fetchImpl;
    this.baseUrl = baseUrl;
  }

  async listModels(context?: ProviderContext): Promise<ModelsResponse> {
    return this.request("models", "/v1/models", undefined, context) as Promise<ModelsResponse>;
  }

  async complete(request: ChatCompletionRequest, context?: ProviderContext): Promise<ChatCompletionResponse | StreamResult> {
    const body = { ...request, model: request.model ?? this.config.defaultModel };
    if (!body.model) throw new TypeError("model is required");
    const operation = body.stream ? "chat.completions.stream" : "chat.completions.create";
    if (body.stream) return this.stream(body, context, operation);
    return this.request(operation, "/v1/chat/completions", body, context) as Promise<ChatCompletionResponse>;
  }

  private async request(operation: string, path: string, body: object | undefined, context?: ProviderContext): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    const signal = combineSignals(controller.signal, context?.signal);
    try {
      const response = await this.fetchImpl(this.url(path), { method: body ? "POST" : "GET", headers: this.headers(), body: body ? JSON.stringify(body) : undefined, signal });
      if (!response.ok) throw await this.errorFromResponse(response);
      let parsed: unknown;
      try { parsed = await response.json(); } catch { throw new FreeLLMAPIError("invalid_response", "Provider returned invalid JSON"); }
      if (!parsed || typeof parsed !== "object") throw new FreeLLMAPIError("invalid_response", "Provider returned an invalid response");
      await this.record(operation, "succeeded", context);
      return parsed;
    } catch (error) {
      const normalized = this.normalizeError(error, controller.signal, context?.signal);
      await this.record(operation, "failed", context, normalized.code);
      throw normalized;
    } finally { clearTimeout(timer); }
  }

  private async stream(body: ChatCompletionRequest, context: ProviderContext | undefined, operation: string): Promise<StreamResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    const signal = combineSignals(controller.signal, context?.signal);
    try {
      const response = await this.fetchImpl(this.url("/v1/chat/completions"), { method: "POST", headers: this.headers(), body: JSON.stringify({ ...body, stream: true }), signal });
      if (!response.ok) throw await this.errorFromResponse(response);
      if (!response.body) throw new FreeLLMAPIError("invalid_response", "Provider returned no SSE body");
      const result = await parseSse(response.body);
      await this.record(operation, "succeeded", context);
      return result;
    } catch (error) {
      const normalized = this.normalizeError(error, controller.signal, context?.signal);
      await this.record(operation, "failed", context, normalized.code);
      throw normalized;
    } finally { clearTimeout(timer); }
  }

  private headers(): Record<string, string> { return { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${this.config.apiKey}`, ...(this.config.organization ? { "openai-organization": this.config.organization } : {}) }; }
  private url(path: string): string { return `${this.baseUrl}${path.startsWith("/v1") ? path : `/v1${path}`}`; }
  private async errorFromResponse(response: Response): Promise<FreeLLMAPIError> {
    const retry = response.headers.get("retry-after");
    const retryAfterMs = retry && /^\d+(\.\d+)?$/.test(retry) ? Number(retry) * 1000 : undefined;
    if (response.status === 401 || response.status === 403) return new FreeLLMAPIError("authentication", "Provider authentication failed", { status: response.status });
    if (response.status === 429) return new FreeLLMAPIError("rate_limited", "Provider rate limit exceeded", { status: 429, retryAfterMs });
    return new FreeLLMAPIError("http_error", `Provider request failed with HTTP ${response.status}`, { status: response.status });
  }
  private normalizeError(error: unknown, timedOut: AbortSignal, callerSignal?: AbortSignal): FreeLLMAPIError {
    if (error instanceof FreeLLMAPIError) return error;
    if (callerSignal?.aborted) return new FreeLLMAPIError("aborted", "Provider request aborted");
    if (timedOut.aborted) return new FreeLLMAPIError("timeout", "Provider request timed out");
    return new FreeLLMAPIError("http_error", "Provider request failed");
  }
  private async record(operation: string, outcome: "succeeded" | "failed", context?: ProviderContext, errorCode?: ProviderErrorCode): Promise<void> {
    if (!context) return;
    const access = "read" as const;
    const base = { adapterId: this.id, operation, access, sessionId: context.sessionId, runId: context.runId };
    const record: ProviderAuditRecord = { ...base, outcome, occurredAt: new Date().toISOString(), ...(errorCode ? { metadata: { errorCode } } : {}) };
    await context.audit?.(record);
    await context.emit?.(outcome === "succeeded" ? { type: "adapter.operation.completed", ...base } : { type: "adapter.operation.failed", ...base, errorCode: errorCode ?? "http_error" });
  }
}

function combineSignals(primary: AbortSignal, secondary?: AbortSignal): AbortSignal {
  if (!secondary) return primary;
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (primary.aborted || secondary.aborted) abort();
  else { primary.addEventListener("abort", abort, { once: true }); secondary.addEventListener("abort", abort, { once: true }); }
  return controller.signal;
}

async function parseSse(body: ReadableStream<Uint8Array>): Promise<StreamResult> {
  const reader = body.getReader(); const decoder = new TextDecoder(); let buffer = "";
  let id: string | undefined; let model: string | undefined; let content = ""; let finishReason: string | null | undefined; let usage: Record<string, number> | undefined;
  const calls = new Map<number, ToolCall>();
  type StreamToolCall = ToolCall & { index?: number };
  type StreamChunk = {
    id?: string;
    model?: string;
    usage?: Record<string, number>;
    choices?: Array<{
      delta?: { content?: string | null; tool_calls?: StreamToolCall[] };
      finish_reason?: string | null;
    }>;
  };
  const consume = (raw: string) => {
    for (const line of raw.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let chunk: StreamChunk;
      try { chunk = JSON.parse(data) as StreamChunk; }
      catch { throw new FreeLLMAPIError("invalid_response", "Provider returned invalid SSE data"); }
      id ??= chunk.id;
      model ??= chunk.model;
      usage ??= chunk.usage;
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      content += choice.delta?.content ?? "";
      finishReason = choice.finish_reason ?? finishReason;
      for (const call of choice.delta?.tool_calls ?? []) {
        const index = call.index ?? 0;
        const old = calls.get(index) ?? {};
        calls.set(index, {
          id: call.id ?? old.id,
          type: "function",
          function: {
            name: (old.function?.name ?? "") + (call.function?.name ?? ""),
            arguments: (old.function?.arguments ?? "") + (call.function?.arguments ?? ""),
          },
        });
      }
    }
  };
  while (true) { const next = await reader.read(); if (next.done) { buffer += decoder.decode(); consume(buffer); break; } buffer += decoder.decode(next.value, { stream: true }); const parts = buffer.split(/\n\n|\r\n\r\n/); buffer = parts.pop() ?? ""; for (const part of parts) consume(part); }
  return { id, model, content, toolCalls: [...calls.values()], finishReason, usage };
}
