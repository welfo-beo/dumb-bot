import { describe, expect, it } from "vitest";
import type { AdapterContext, ApprovalDecision, AuditRecord, RuntimeEvent } from "../../../src/core/contracts.js";
import {
  HindsightAdapterError,
  HindsightMemoryAdapter,
  HindsightRestClient,
  hindsightBankIdForProject,
  type HindsightClient,
  type HindsightRetainItem,
} from "../../../src/index.js";
import {
  HindsightAdapterError as PackageHindsightAdapterError,
  HindsightMemoryAdapter as PackageHindsightMemoryAdapter,
} from "../../../packages/memory-hindsight/src/index.js";

type FakeCall = { op: string; bank: string; details?: unknown };

class FakeClient implements HindsightClient {
  readonly calls: FakeCall[] = [];

  async recall(bank: string, query: string, options?: { maxTokens?: number; signal?: AbortSignal }) {
    this.calls.push({ op: "recall", bank, details: { query, options } });
    return { results: [{ id: "m1", text: "safe fact", created_at: "2025-01-01T00:00:00Z" }] };
  }

  async reflect(bank: string, query: string, options?: { context?: string; budget?: "low" | "mid" | "high"; includeFacts?: boolean; signal?: AbortSignal }) {
    this.calls.push({ op: "reflect", bank, details: { query, options } });
    return { text: `reflection:${bank}` };
  }

  async retainBatch(
    bank: string,
    items: readonly HindsightRetainItem[],
    options?: { async?: boolean; operationId?: string; signal?: AbortSignal },
  ) {
    this.calls.push({ op: "retainBatch", bank, details: { items: structuredClone(items), options } });
    return { items_count: items.length, operation_id: options?.operationId };
  }
}

function context(decision: ApprovalDecision): {
  context: AdapterContext;
  audits: AuditRecord[];
  events: RuntimeEvent[];
  get approvalCount(): number;
} {
  const audits: AuditRecord[] = [];
  const events: RuntimeEvent[] = [];
  let approvalCount = 0;
  return {
    audits,
    events,
    get approvalCount() { return approvalCount; },
    context: {
      projectId: "project-a",
      sessionId: "session-1",
      runId: "run-1",
      policy: { defaultAccess: "read-only", writesRequireApproval: true },
      audit: async (audit) => { audits.push(audit); },
      emit: async (event) => { events.push(event); },
      requestApproval: async () => { approvalCount += 1; return decision; },
    },
  };
}

describe("HindsightMemoryAdapter", () => {
  it("re-exports the exact package implementation and error class from the root entry", () => {
    expect(HindsightMemoryAdapter).toBe(PackageHindsightMemoryAdapter);
    expect(HindsightAdapterError).toBe(PackageHindsightAdapterError);
  });

  it("declares exact capabilities and maps each project/bank pair to an isolated opaque bank", async () => {
    const client = new FakeClient();
    const h = context({ status: "approved", approvalId: "a", decidedAt: new Date().toISOString() });
    const adapter = new HindsightMemoryAdapter({ client });

    expect(adapter.capabilities).toMatchObject({
      read: true,
      write: true,
      recall: true,
      reflect: true,
      retain: true,
      forget: false,
      approval: true,
    });
    await adapter.recall({ bankId: "user-bank", query: "fact" }, h.context);
    expect(client.calls[0].bank).toBe(hindsightBankIdForProject("project-a", "user-bank"));
    expect(client.calls[0].bank).not.toContain("project-a");
    expect(hindsightBankIdForProject("project-a", "user-bank")).not.toBe(
      hindsightBankIdForProject("project-b", "user-bank"),
    );
  });

  it("requests approval before async redacted retain and records the shared audit/event lifecycle", async () => {
    const client = new FakeClient();
    const h = context({ status: "approved", approvalId: "approval-1", decidedAt: new Date().toISOString() });
    const adapter = new HindsightMemoryAdapter({ client, redact: (text) => text.replace(/secret/gi, "[REDACTED]") });

    const receipt = await adapter.retain({ bankId: "b", idempotencyKey: "idem-1", items: [{ text: "secret fact" }] }, h.context);

    const retainCall = client.calls[0];
    expect(retainCall.op).toBe("retainBatch");
    expect(retainCall.details).toMatchObject({
      items: [{ content: "[REDACTED] fact", metadata: { dumb_bot_session_id: "session-1", dumb_bot_run_id: "run-1" } }],
      options: { async: true, operationId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/) },
    });
    expect(receipt).toMatchObject({ accepted: 1, operationId: expect.any(String) });
    expect(h.events.map((event) => event.type)).toEqual([
      "approval.requested", "approval.granted", "adapter.operation.completed",
    ]);
    expect(h.audits.map((audit) => audit.outcome)).toEqual(["approval_requested", "approved", "succeeded"]);
    expect(h.audits.at(-1)).toMatchObject({
      adapterId: "hindsight",
      operation: "retain",
      approvalId: "approval-1",
      metadata: { itemCount: 1, accepted: 1 },
    });
    expect(JSON.stringify(h.audits)).not.toContain("secret fact");
  });

  it("uses the exact approval-denied code and makes no remote retain call", async () => {
    const client = new FakeClient();
    const h = context({ status: "denied", approvalId: "approval-denied", decidedAt: new Date().toISOString(), reason: "no" });
    const adapter = new HindsightMemoryAdapter({ client });

    await expect(adapter.retain({ bankId: "b", idempotencyKey: "idem-1", items: [{ text: "fact" }] }, h.context))
      .rejects.toMatchObject({ code: "APPROVAL_DENIED" });
    expect(client.calls).toHaveLength(0);
    expect(h.approvalCount).toBe(1);
    expect(h.events.map((event) => event.type)).toEqual([
      "approval.requested", "approval.denied", "adapter.operation.failed",
    ]);
    expect(h.audits.map((audit) => audit.outcome)).toEqual(["approval_requested", "denied", "failed"]);
    expect(h.audits.at(-1)).toMatchObject({ metadata: { errorCode: "APPROVAL_DENIED" } });
  });

  it("rejects invalid logical banks before any remote call", async () => {
    const client = new FakeClient();
    const h = context({ status: "approved", approvalId: "a", decidedAt: new Date().toISOString() });
    const adapter = new HindsightMemoryAdapter({ client });

    await expect(adapter.recall({ bankId: " ", query: "q" }, h.context)).rejects.toBeInstanceOf(TypeError);
    expect(client.calls).toHaveLength(0);
    expect(h.audits).toHaveLength(0);
  });

  it("fails forget closed with FORGET_UNSUPPORTED, an audit, and zero remote side effects", async () => {
    const client = new FakeClient();
    const h = context({ status: "approved", approvalId: "a", decidedAt: new Date().toISOString() });
    const adapter = new HindsightMemoryAdapter({ client });

    expect(adapter.capabilities.forget).toBe(false);
    await expect(adapter.forget({ bankId: "b", memoryIds: ["memory-1"], idempotencyKey: "forget-1" }, h.context))
      .rejects.toMatchObject({ code: "FORGET_UNSUPPORTED" });
    expect(client.calls).toHaveLength(0);
    expect(h.approvalCount).toBe(0);
    expect(h.events).toEqual([expect.objectContaining({
      type: "adapter.operation.failed",
      operation: "forget",
      errorCode: "FORGET_UNSUPPORTED",
    })]);
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]).toMatchObject({
      adapterId: "hindsight",
      operation: "forget",
      access: "write",
      outcome: "failed",
      metadata: { memoryCount: 1, errorCode: "FORGET_UNSUPPORTED" },
    });
    expect(JSON.stringify(h.audits)).not.toContain("memory-1");
  });

  it("validates Hindsight configuration without echoing URL credentials", () => {
    const secret = "hindsight-config-secret";
    for (const options of [
      { baseUrl: `https://user:${secret}@hindsight.example.test`, apiKey: secret },
      { baseUrl: "not-a-url", apiKey: secret },
      { baseUrl: "https://hindsight.example.test", apiKey: secret, timeoutMs: 0 },
    ]) {
      let thrown: unknown;
      try {
        new HindsightRestClient(options);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).not.toContain(secret);
      expect(JSON.stringify(thrown)).not.toContain(secret);
    }
  });

  it("keeps mock 401 response details and API keys out of Hindsight errors and audit", async () => {
    const secret = "hindsight-runtime-secret";
    const h = context({ status: "approved", approvalId: "a", decidedAt: new Date().toISOString() });
    const adapter = new HindsightMemoryAdapter({
      baseUrl: "https://hindsight.example.test",
      apiKey: secret,
      fetchImpl: async (_input, init) => {
        expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${secret}`);
        return new Response(`upstream detail Bearer ${secret}`, { status: 401 });
      },
    });

    try {
      await adapter.recall({ bankId: "notes", query: "safe query" }, h.context);
      throw new Error("expected mock authentication failure");
    } catch (error) {
      expect(error).toMatchObject({ code: "AUTHENTICATION" });
      expect((error as Error).message).not.toContain(secret);
      expect(JSON.stringify(error)).not.toContain(secret);
    }
    expect(JSON.stringify(h.audits)).not.toContain(secret);
    expect(JSON.stringify(h.events)).not.toContain(secret);
    expect(h.audits.at(-1)).toMatchObject({ metadata: { errorCode: "AUTHENTICATION" } });
  });
});
