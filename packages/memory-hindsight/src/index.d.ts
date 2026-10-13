import type {
  AdapterContext,
  MemoryAdapter,
  MemoryRecord,
  MemoryRecallInput,
  MemoryReflectInput,
  MemoryRetainInput,
  MemoryRetainReceipt,
  MemoryForgetInput,
  MemoryForgetReceipt,
} from "../../../src/core/contracts";

export class HindsightAdapterError extends Error {
  readonly code: string;
  readonly statusCode?: number;
  readonly deletedCount?: number;
  readonly failedCount?: number;
  constructor(code: string, message: string, options?: {
    statusCode?: number;
    deletedCount?: number;
    failedCount?: number;
  });
}

export interface HindsightRetainItem {
  readonly content: string;
  readonly context?: string;
  readonly timestamp?: string | Date;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly documentId?: string;
  readonly tags?: readonly string[];
}

export interface HindsightClient {
  retainBatch(
    bankId: string,
    items: readonly HindsightRetainItem[],
    options?: { async?: boolean; operationId?: string; signal?: AbortSignal },
  ): Promise<{ readonly items_count?: number; readonly operation_id?: string }>;
  recall(
    bankId: string,
    query: string,
    options?: { maxTokens?: number; signal?: AbortSignal },
  ): Promise<{ readonly results: readonly Record<string, unknown>[] }>;
  reflect(
    bankId: string,
    query: string,
    options?: { budget?: "low" | "mid" | "high"; maxTokens?: number; signal?: AbortSignal },
  ): Promise<{ readonly text: string }>;
}

export interface HindsightRestClientOptions {
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

export class HindsightRestClient implements HindsightClient {
  constructor(options: HindsightRestClientOptions);
  retainBatch(
    bankId: string,
    items: readonly HindsightRetainItem[],
    options?: { async?: boolean; operationId?: string; signal?: AbortSignal },
  ): Promise<{ readonly items_count?: number; readonly operation_id?: string }>;
  recall(
    bankId: string,
    query: string,
    options?: { maxTokens?: number; signal?: AbortSignal },
  ): Promise<{ readonly results: readonly Record<string, unknown>[] }>;
  reflect(
    bankId: string,
    query: string,
    options?: { budget?: "low" | "mid" | "high"; maxTokens?: number; signal?: AbortSignal },
  ): Promise<{ readonly text: string }>;
}

export interface HindsightMemoryAdapterOptions extends Partial<HindsightRestClientOptions> {
  readonly client?: HindsightClient;
  readonly recallMaxTokens?: number;
  /** Optional final redaction hook; callers remain responsible for core input redaction. */
  readonly redact?: (text: string) => string;
}

export declare function hindsightBankIdForProject(projectId: string, bankId: string): string;

export class HindsightMemoryAdapter implements MemoryAdapter {
  readonly id: string;
  readonly capabilities: MemoryAdapter["capabilities"] & { readonly forget: false };
  constructor(options: HindsightMemoryAdapterOptions);
  recall(input: MemoryRecallInput, context: AdapterContext): Promise<readonly MemoryRecord[]>;
  reflect(input: MemoryReflectInput, context: AdapterContext): Promise<string>;
  retain(input: MemoryRetainInput, context: AdapterContext): Promise<MemoryRetainReceipt>;
  /** Rejects every request until Hindsight supports confirmed exact per-ID deletion. */
  forget(input: MemoryForgetInput, context: AdapterContext): Promise<MemoryForgetReceipt>;
}
