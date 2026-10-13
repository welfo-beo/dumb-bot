import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionToolContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AdapterContext } from "../../src/core/contracts.js";
import type { HindsightClient, HindsightMemoryAdapterOptions } from "../../packages/memory-hindsight/src/index.js";
import { HindsightAdapterError, HindsightMemoryAdapter } from "../../packages/memory-hindsight/src/index.js";
import { ComponentRegistry } from "../../src/core/registry.js";
import { modelConfigurationHint, setupHindsightForCli } from "../../src/cli.js";
import hindsightExtension from "../../src/extensions/hindsight/extension.js";
import { getHindsightRuntimeBinding } from "../../src/extensions/hindsight/runtime.js";

type ClientCall = {
  readonly operation: "recall" | "reflect" | "retainBatch";
  readonly bankId: string;
  readonly details?: unknown;
};
type RegisteredTool = ToolDefinition<any, any, any>;

class FakeHindsightClient implements HindsightClient {
  readonly calls: ClientCall[] = [];

  async recall(bankId: string, query: string) {
    this.calls.push({ operation: "recall", bankId, details: { query } });
    return {
      results: [{ id: "memory-1", text: "A safe remembered fact", mentioned_at: "2026-10-13T10:00:00.000Z" }],
    };
  }

  async reflect(bankId: string, query: string) {
    this.calls.push({ operation: "reflect", bankId, details: { query } });
    return { text: `Local reflection for: ${query}` };
  }

  async retainBatch(
    bankId: string,
    items: Parameters<HindsightClient["retainBatch"]>[1],
    options?: Parameters<HindsightClient["retainBatch"]>[2],
  ) {
    this.calls.push({
      operation: "retainBatch",
      bankId,
      details: { items: structuredClone(items), operationId: options?.operationId },
    });
    return { items_count: items.length, operation_id: options?.operationId };
  }
}

function makeToolContext(
  options: {
    readonly hasUI: boolean;
    readonly mode?: "tui" | "rpc" | "json" | "print";
    readonly confirm?: (title: string, message: string, options?: { signal?: AbortSignal }) => Promise<boolean>;
  },
): ExtensionToolContext {
  const ui = options.hasUI && options.confirm
    ? { confirm: async (title: string, message: string, dialogOptions?: { signal?: AbortSignal }) => options.confirm!(title, message, dialogOptions) }
    : undefined;
  return {
    hasUI: options.hasUI,
    mode: options.mode ?? (options.hasUI ? "tui" : "print"),
    ui,
    sessionManager: { getSessionId: () => "session-cli-integration" },
  } as unknown as ExtensionToolContext;
}

function textOf(result: Awaited<ReturnType<RegisteredTool["execute"]>>): string {
  return result.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

test("CLI setup binds one adapter to Pi tools; reads work and writes fail closed without approval", async (t) => {
  const registry = new ComponentRegistry();
  const client = new FakeHindsightClient();
  const statusMessages: string[] = [];
  let createdAdapter: HindsightMemoryAdapter | undefined;
  let receivedOptions: HindsightMemoryAdapterOptions | undefined;
  const unbind = setupHindsightForCli(registry, {
    projectId: "project-cli-integration",
    baseUrl: "https://hindsight.invalid",
    apiKey: "local-test-key",
    createAdapter: (options) => {
      receivedOptions = options;
      createdAdapter = new HindsightMemoryAdapter({ ...options, client });
      return createdAdapter;
    },
    onEnabled: (message) => statusMessages.push(message),
    onDisabled: (message) => statusMessages.push(message),
  });
  t.after(unbind);

  const registration = registry.listExtensions().find(({ id }) => id === "extension.hindsight-memory");
  assert.ok(registration, "CLI must register the Hindsight extension for Pi to load");
  assert.match(registration.path, /src\/extensions\/hindsight\/extension\.ts$/);
  assert.deepEqual(registration.capabilities, ["memory.recall", "memory.reflect", "memory.retain"]);
  const registeredAdapter = registry.requireAdapter<HindsightMemoryAdapter>("hindsight").instance;
  assert.equal(registeredAdapter, createdAdapter, "CLI registry retains the factory's sole adapter instance");
  assert.equal(getHindsightRuntimeBinding()?.adapter, registeredAdapter, "the extension binding shares the CLI adapter instance");
  assert.equal(getHindsightRuntimeBinding()?.projectId, "project-cli-integration");
  assert.deepEqual(receivedOptions, {
    baseUrl: "https://hindsight.invalid",
    apiKey: "local-test-key",
  });
  assert.equal(statusMessages.length, 1);
  assert.match(statusMessages[0], /forget remains disabled/);

  const tools = new Map<string, RegisteredTool>();
  const commands = new Set<string>();
  const sessionEntries: Array<{ type: string; data: unknown }> = [];
  const pi = {
    registerTool: (tool: RegisteredTool) => tools.set(tool.name, tool),
    registerCommand: (name: string) => commands.add(name),
    appendEntry: (type: string, data: unknown) => sessionEntries.push({ type, data }),
  } as unknown as ExtensionAPI;
  hindsightExtension(pi);

  assert.deepEqual([...tools.keys()].sort(), [
    "hindsight_recall",
    "hindsight_reflect",
    "hindsight_retain",
  ]);
  assert.equal(tools.has("hindsight_forget"), false, "forget must not be registered as a Pi tool");
  assert.equal(commands.has("hindsight"), true);
  assert.equal(registeredAdapter.capabilities.forget, false);

  const invoke = async (name: string, id: string, params: unknown, ctx: ExtensionToolContext, signal?: AbortSignal) => {
    const tool = tools.get(name);
    assert.ok(tool, `expected registered tool ${name}`);
    return tool.execute(id, params, signal, undefined, ctx);
  };

  const readContext = makeToolContext({ hasUI: true, confirm: async () => true });
  const recall = await invoke("hindsight_recall", "read-1", {
    bankId: "notes",
    query: "safe fact",
    limit: 3,
  }, readContext);
  const reflect = await invoke("hindsight_reflect", "read-2", {
    bankId: "notes",
    query: "summarize notes",
  }, readContext);
  assert.equal(recall.isError, undefined);
  assert.match(textOf(recall), /A safe remembered fact/);
  assert.equal(reflect.isError, undefined);
  assert.match(textOf(reflect), /Local reflection for: summarize notes/);
  assert.deepEqual(client.calls.map(({ operation }) => operation), ["recall", "reflect"]);
  assert.equal(sessionEntries.filter(({ type }) => type === "dumb-bot-hindsight-audit").length, 2);

  const confirmations: Array<{ title: string; message: string }> = [];
  const approvedContext = makeToolContext({
    hasUI: true,
    confirm: async (title, message) => {
      confirmations.push({ title, message });
      return true;
    },
  });
  const approved = await invoke("hindsight_retain", "approved-write", {
    bankId: "notes",
    items: [{ text: "approved-path", source: "integration-test" }],
  }, approvedContext);
  assert.equal(approved.isError, undefined);
  assert.match(textOf(approved), /"accepted": 1/);
  assert.equal(confirmations.length, 1);
  assert.match(confirmations[0].title, /Approve Hindsight/);
  assert.match(confirmations[0].message, /Logical bank: notes/);
  assert.match(confirmations[0].message, /Exact memory content to send:/);
  assert.match(confirmations[0].message, /approved-path/);
  assert.match(confirmations[0].message, /Approve this external memory write\?/);
  const approvedCall = client.calls.at(-1);
  assert.equal(approvedCall?.operation, "retainBatch");
  assert.match(JSON.stringify(approvedCall?.details), /approved-path/);

  const callsBeforeDenied = client.calls.length;
  const denied = await invoke("hindsight_retain", "denied-write", {
    bankId: "notes",
    items: [{ text: "denied-path" }],
  }, makeToolContext({ hasUI: true, confirm: async () => false }));
  assert.equal(denied.isError, true);
  assert.match(textOf(denied), /APPROVAL_DENIED/);
  assert.equal(client.calls.length, callsBeforeDenied, "denying UI approval must prevent the Hindsight write");

  const callsBeforeNoUi = client.calls.length;
  const noUi = await invoke("hindsight_retain", "no-ui-write", {
    bankId: "notes",
    items: [{ text: "no-ui-path" }],
  }, makeToolContext({ hasUI: false }));
  assert.equal(noUi.isError, true);
  assert.match(textOf(noUi), /APPROVAL_UNAVAILABLE/);
  assert.equal(client.calls.length, callsBeforeNoUi, "missing UI must fail closed without a Hindsight write");

  const callsBeforeRpc = client.calls.length;
  const rpcWithUi = await invoke("hindsight_retain", "rpc-write", {
    bankId: "notes",
    items: [{ text: "rpc-path" }],
  }, makeToolContext({ hasUI: true, mode: "rpc", confirm: async () => true }));
  assert.equal(rpcWithUi.isError, true);
  assert.match(textOf(rpcWithUi), /APPROVAL_UNAVAILABLE/);
  assert.equal(client.calls.length, callsBeforeRpc, "non-interactive RPC mode must not approve external writes");

  const callsBeforeCancel = client.calls.length;
  const cancelController = new AbortController();
  const cancelled = await invoke("hindsight_retain", "cancelled-write", {
    bankId: "notes",
    items: [{ text: "cancelled-path" }],
  }, makeToolContext({
    hasUI: true,
    confirm: async (_title, _message, dialogOptions) => {
      assert.equal(dialogOptions?.signal, cancelController.signal);
      cancelController.abort();
      return false;
    },
  }), cancelController.signal);
  assert.equal(cancelled.isError, true);
  assert.match(textOf(cancelled), /APPROVAL_UNAVAILABLE/);
  assert.equal(client.calls.length, callsBeforeCancel, "canceling the consent dialog must prevent the Hindsight write");

  const auditLogText = JSON.stringify(sessionEntries);
  assert.equal(auditLogText.includes("approved-path"), false, "approval content must not be persisted into Pi audit/session entries");
  assert.equal(auditLogText.includes("local-test-key"), false, "credentials must never enter Pi audit/session entries");

  assert.deepEqual(client.calls.map(({ operation }) => operation), ["recall", "reflect", "retainBatch"]);
  assert.equal(sessionEntries.filter(({ type }) => type === "dumb-bot-hindsight-event").length, 14);
});

test("retain fails closed when the adapter context has no approval provider", async () => {
  const client = new FakeHindsightClient();
  const adapter = new HindsightMemoryAdapter({
    baseUrl: "https://hindsight.invalid",
    client,
  });
  const context = {
    projectId: "project-no-approval-context",
    sessionId: "session-no-approval-context",
    runId: "run-no-approval-context",
    policy: { defaultAccess: "read-only", writesRequireApproval: true },
    audit: async () => undefined,
    emit: async () => undefined,
  } as unknown as AdapterContext;

  await assert.rejects(adapter.retain({
    bankId: "notes",
    idempotencyKey: "no-approval-context",
    items: [{ text: "must not be sent" }],
  }, context), (error: unknown) => error instanceof HindsightAdapterError && error.code === "APPROVAL_UNAVAILABLE");
  assert.deepEqual(client.calls, [], "missing approval context must have zero remote side effects");
});

test("missing Hindsight URL gives an actionable hint without constructing an adapter or exposing a key", () => {
  const registry = new ComponentRegistry();
  const messages: string[] = [];
  const secret = "must-not-appear-in-cli-output";
  let factoryCalled = false;
  const unbind = setupHindsightForCli(registry, {
    projectId: "project-missing-config",
    baseUrl: "  ",
    apiKey: secret,
    createAdapter: () => {
      factoryCalled = true;
      throw new Error(secret);
    },
    onDisabled: (message) => messages.push(message),
  });

  unbind();
  assert.equal(factoryCalled, false);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /HINDSIGHT_BASE_URL/);
  assert.match(messages[0], /HINDSIGHT_API_KEY/);
  assert(!messages[0].includes(secret));
});

test("invalid Hindsight config and missing model prompts stay actionable and redacted", () => {
  const registry = new ComponentRegistry();
  const messages: string[] = [];
  const secret = "must-not-appear-in-diagnostics";
  const unbind = setupHindsightForCli(registry, {
    projectId: "project-invalid-config",
    baseUrl: `https://user:${secret}@hindsight.example.test`,
    apiKey: secret,
    onDisabled: (message) => messages.push(message),
  });
  unbind();
  assert.match(messages[0], /HINDSIGHT_BASE_URL/);
  assert(!messages[0].includes(secret));

  const hint = modelConfigurationHint(undefined);
  assert.ok(hint);
  assert.match(hint, /\/login/);
  assert.match(hint, /\/model/);
  assert(!hint.includes(secret));
  assert.equal(modelConfigurationHint({ provider: "openai", id: "model-a" }), undefined);
});
