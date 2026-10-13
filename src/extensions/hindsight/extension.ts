import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import {
  HindsightAdapterError,
  type HindsightMemoryAdapter,
} from "../../../packages/memory-hindsight/src/index.js";
import type {
  AdapterContext,
  ApprovalDecision,
  ApprovalRequest,
  AuditRecord,
  MemoryRetainInput,
} from "../../core/contracts.js";
import type {
  ExtensionAPI,
  ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { getHindsightRuntimeBinding } from "./runtime.js";

const AUDIT_ENTRY_TYPE = "dumb-bot-hindsight-audit";
const EVENT_ENTRY_TYPE = "dumb-bot-hindsight-event";

const RecallParameters = Type.Object({
  bankId: Type.String({ minLength: 1, description: "Logical bank name within this project." }),
  query: Type.String({ minLength: 1, description: "What to search for in project memory." }),
  limit: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum number of memories to return." })),
}, { additionalProperties: false });

const ReflectParameters = Type.Object({
  bankId: Type.String({ minLength: 1, description: "Logical bank name within this project." }),
  query: Type.String({ minLength: 1, description: "Question to synthesize from project memory." }),
}, { additionalProperties: false });

const RetainParameters = Type.Object({
  bankId: Type.String({ minLength: 1, description: "Logical bank name within this project." }),
  items: Type.Array(Type.Object({
    text: Type.String({ minLength: 1, description: "Memory text to retain." }),
    source: Type.Optional(Type.String({ description: "Optional source/context label." })),
  }, { additionalProperties: false }), { minItems: 1 }),
}, { additionalProperties: false });

type ApprovalFactory = (request: ApprovalRequest) => Promise<ApprovalDecision>;

function makeAdapterContext(
  pi: ExtensionAPI,
  ctx: ExtensionToolContext,
  projectId: string,
  toolCallId: string,
  signal: AbortSignal | undefined,
  requestApproval: ApprovalFactory,
): AdapterContext {
  return {
    projectId,
    sessionId: ctx.sessionManager.getSessionId(),
    runId: toolCallId.trim() || randomUUID(),
    signal,
    policy: Object.freeze({ defaultAccess: "read-only", writesRequireApproval: true }),
    requestApproval,
    audit: async (record: AuditRecord) => {
      // Adapter audit payloads are safe metadata only; never persist tool inputs or credentials here.
      pi.appendEntry(AUDIT_ENTRY_TYPE, record);
    },
    emit: async (event) => {
      // Keep contract events in Pi's own session log, outside model context.
      pi.appendEntry(EVENT_ENTRY_TYPE, event);
    },
  };
}

function resultText(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2) ?? String(value);
}

function errorResult(error: unknown) {
  if (error instanceof HindsightAdapterError) {
    return {
      content: [{ type: "text" as const, text: `Hindsight operation failed (${error.code}): ${error.message}` }],
      details: undefined,
      isError: true,
    };
  }
  return {
    content: [{ type: "text" as const, text: "Hindsight operation failed (UPSTREAM_ERROR)." }],
    details: undefined,
    isError: true,
  };
}

function makeApproval(
  ctx: ExtensionToolContext,
  input: MemoryRetainInput,
  signal: AbortSignal | undefined,
): ApprovalFactory {
  return async (request) => {
    if (ctx.mode !== "tui" || !ctx.hasUI || typeof ctx.ui?.confirm !== "function") {
      throw new Error("Interactive TUI approval UI is unavailable");
    }
    const items = input.items.map((item, index) => {
      const source = item.source ? ` (source: ${item.source})` : "";
      return `${index + 1}. ${item.text}${source}`;
    });
    const message = [
      request.summary,
      `Logical bank: ${input.bankId}`,
      "",
      "Exact memory content to send:",
      ...items,
      "",
      "Approve this external memory write?",
    ].join("\n");
    const approved = await ctx.ui.confirm("Approve Hindsight memory write", message, { signal });
    if (signal?.aborted) {
      throw new Error("Approval dialog was cancelled");
    }
    return {
      status: approved ? "approved" : "denied",
      approvalId: randomUUID(),
      decidedAt: new Date().toISOString(),
    };
  };
}

export default function hindsightExtension(pi: ExtensionAPI): void {
  const binding = getHindsightRuntimeBinding();
  pi.registerCommand("hindsight", {
    description: "Show Hindsight memory adapter status",
    handler: async (_args, ctx) => {
      if (!binding) {
        ctx.ui.notify("Hindsight memory is disabled. Set HINDSIGHT_BASE_URL before starting dumb-bot.", "warning");
        return;
      }
      ctx.ui.notify("Hindsight is enabled: recall/reflect are read-only; retain requires UI approval; forget is disabled.", "info");
    },
  });
  if (!binding) return;

  const { adapter, projectId } = binding;
  registerRecall(pi, adapter, projectId);
  registerReflect(pi, adapter, projectId);
  registerRetain(pi, adapter, projectId);
}

function registerRecall(pi: ExtensionAPI, adapter: HindsightMemoryAdapter, projectId: string): void {
  pi.registerTool({
    name: "hindsight_recall",
    label: "Hindsight recall",
    description: "Search this project's Hindsight memory bank. This is read-only.",
    promptSnippet: "Recall relevant memories from this project's Hindsight bank.",
    parameters: RecallParameters,
    execute: async (toolCallId, params, signal, _onUpdate, ctx) => {
      try {
        const context = makeAdapterContext(pi, ctx, projectId, toolCallId, signal, async () => {
          throw new Error("No write approval is available for read-only operations");
        });
        const memories = await adapter.recall(params, context);
        return { content: [{ type: "text", text: resultText(memories) }], details: undefined };
      } catch (error) {
        return errorResult(error);
      }
    },
  });
}

function registerReflect(pi: ExtensionAPI, adapter: HindsightMemoryAdapter, projectId: string): void {
  pi.registerTool({
    name: "hindsight_reflect",
    label: "Hindsight reflect",
    description: "Synthesize an answer from this project's Hindsight memory bank. This is read-only.",
    promptSnippet: "Synthesize an answer from relevant memories in this project's Hindsight bank.",
    parameters: ReflectParameters,
    execute: async (toolCallId, params, signal, _onUpdate, ctx) => {
      try {
        const context = makeAdapterContext(pi, ctx, projectId, toolCallId, signal, async () => {
          throw new Error("No write approval is available for read-only operations");
        });
        const reflection = await adapter.reflect(params, context);
        return { content: [{ type: "text", text: reflection }], details: undefined };
      } catch (error) {
        return errorResult(error);
      }
    },
  });
}

function registerRetain(pi: ExtensionAPI, adapter: HindsightMemoryAdapter, projectId: string): void {
  pi.registerTool({
    name: "hindsight_retain",
    label: "Hindsight retain",
    description: "Request approval to retain memory items in this project's Hindsight bank. No remote write occurs unless the user approves in the UI.",
    promptSnippet: "Ask the user to approve before retaining these memories in Hindsight.",
    parameters: RetainParameters,
    execute: async (toolCallId, params, signal, _onUpdate, ctx) => {
      try {
        const input: MemoryRetainInput = {
          bankId: params.bankId,
          items: params.items,
          idempotencyKey: toolCallId,
        };
        const context = makeAdapterContext(
          pi,
          ctx,
          projectId,
          toolCallId,
          signal,
          makeApproval(ctx, input, signal),
        );
        const receipt = await adapter.retain(input, context);
        return { content: [{ type: "text", text: resultText(receipt) }], details: undefined };
      } catch (error) {
        return errorResult(error);
      }
    },
  });
}
