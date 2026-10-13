import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { HindsightAdapterError, HindsightMemoryAdapter, hindsightBankIdForProject } from "../../src/index.js";
import { WorkspaceSecurity } from "../../packages/security/src/index.js";
import type { AdapterContext, AuditRecord, RuntimeEvent } from "../../src/core/contracts.js";
import { SecurityEventMapper } from "../../src/core/security-event-mapper.js";

type StoredMemory = {
  id: string;
  text: string;
  document_id?: string;
  metadata?: Record<string, string>;
  mentioned_at: string;
};

class FakeHindsightClient {
  readonly calls: Array<{ operation: string; bankId: string; details?: unknown }> = [];
  readonly destructiveCalls: string[] = [];
  private readonly banks = new Map<string, StoredMemory[]>();
  private nextId = 1;

  async retainBatch(bankId: string, items: readonly { content: string; documentId?: string; metadata?: Record<string, string> }[], options?: { operationId?: string }) {
    this.calls.push({ operation: "retainBatch", bankId, details: structuredClone({ items, options }) });
    const bank = this.banks.get(bankId) ?? [];
    for (const item of items) {
      bank.push({
        id: `memory-${this.nextId++}`,
        text: item.content,
        ...(item.documentId ? { document_id: item.documentId } : {}),
        ...(item.metadata ? { metadata: { ...item.metadata } } : {}),
        mentioned_at: "2026-10-13T10:00:00.000Z",
      });
    }
    this.banks.set(bankId, bank);
    return { items_count: items.length, operation_id: options?.operationId };
  }

  async recall(bankId: string, query: string) {
    this.calls.push({ operation: "recall", bankId, details: { query } });
    return {
      results: (this.banks.get(bankId) ?? []).filter((item) => item.text.toLowerCase().includes(query.toLowerCase())),
    };
  }

  async reflect(bankId: string, query: string) {
    this.calls.push({ operation: "reflect", bankId, details: { query } });
    return { text: `reflection for ${bankId}: ${query}` };
  }

  count(bankId: string): number {
    return this.banks.get(bankId)?.length ?? 0;
  }
}

async function harness(t: TestContext, { memoryApproval = "approved" as "approved" | "denied" } = {}) {
  const parent = await mkdtemp(path.join(os.tmpdir(), "dumb-bot-security-memory-"));
  const workspace = path.join(parent, "workspace");
  await mkdir(workspace);
  await writeFile(path.join(workspace, "facts.txt"), "The internal project codename is cedar; credential is secret-123.\n");
  await writeFile(path.join(parent, "outside.txt"), "must never enter memory");
  t.after(() => rm(parent, { recursive: true, force: true }));

  const projectId = "project-cross-package";
  const sessionId = "session-cross-package";
  const runId = "run-cross-package";
  const events: RuntimeEvent[] = [];
  const audits: AuditRecord[] = [];
  const securityEvents: unknown[] = [];
  const securityPrompts: unknown[] = [];
  const memoryPrompts: unknown[] = [];
  const mapper = new SecurityEventMapper();
  const client = new FakeHindsightClient();

  const security = await WorkspaceSecurity.create({
    workspaceRoot: workspace,
    requestApproval: async (prompt) => {
      securityPrompts.push(structuredClone(prompt));
      return true;
    },
    emit: async (event) => {
      securityEvents.push(structuredClone(event));
      const mapped = mapper.map(event, { runId });
      audits.push(mapped.auditRecord);
      events.push(mapped.runtimeEvent);
    },
  });

  const context: AdapterContext = {
    projectId,
    sessionId,
    runId,
    policy: { defaultAccess: "read-only", writesRequireApproval: true },
    requestApproval: async (request) => {
      memoryPrompts.push(structuredClone(request));
      return {
        status: memoryApproval,
        approvalId: `memory-approval-${memoryPrompts.length}`,
        decidedAt: "2026-10-13T10:01:00.000Z",
        ...(memoryApproval === "denied" ? { reason: "integration test denial" } : {}),
      };
    },
    audit: async (record) => { audits.push(structuredClone(record)); },
    emit: async (event) => { events.push(structuredClone(event)); },
  };
  const memory = new HindsightMemoryAdapter({
    client,
    redact: (text) => text.replaceAll("secret-123", "[redacted]"),
  });

  return {
    parent,
    workspace,
    projectId,
    sessionId,
    runId,
    security,
    memory,
    context,
    client,
    events,
    audits,
    securityEvents,
    securityPrompts,
    memoryPrompts,
  };
}

test("security boundary, core event mapping, and approved memory retain compose without changing contracts", async (t) => {
  const h = await harness(t);

  await h.security.writeFile({ sessionId: h.sessionId, path: "approved.txt", data: "approved local write" });
  const facts = await h.security.readFile({ sessionId: h.sessionId, path: "facts.txt" });
  assert.match(facts as string, /cedar/);

  const receipt = await h.memory.retain({
    bankId: "project-notes",
    idempotencyKey: "cross-package-retain-01",
    items: [{ text: facts as string, source: "workspace:facts.txt" }],
  }, h.context);
  assert.equal(receipt.accepted, 1);

  const recalled = await h.memory.recall({ bankId: "project-notes", query: "cedar" }, h.context);
  assert.equal(recalled.length, 1);
  assert.match(recalled[0].text, /\[redacted\]/);
  assert.equal(recalled[0].text.includes("secret-123"), false);

  const bankId = hindsightBankIdForProject(h.projectId, "project-notes");
  const otherProjectContext: AdapterContext = { ...h.context, projectId: "project-cross-package-other" };
  const otherProjectRecords = await h.memory.recall({ bankId: "project-notes", query: "cedar" }, otherProjectContext);
  assert.deepEqual(otherProjectRecords, [], "a different project must not see this project's bank");
  assert.notEqual(h.client.calls.at(-1)?.bankId, bankId, "project IDs must map to different remote banks");
  assert.deepEqual(h.client.calls.map((call) => call.operation), ["retainBatch", "recall", "recall"]);
  assert.deepEqual(h.client.calls.map((call) => call.bankId), [bankId, bankId, hindsightBankIdForProject(otherProjectContext.projectId, "project-notes")]);
  const retainCall = h.client.calls[0];
  assert.equal((retainCall.details as { items: Array<{ content: string }> }).items[0].content.includes("secret-123"), false);
  assert.equal(h.securityPrompts.length, 1, "the workspace write uses the security package's one-operation approval gate");
  assert.equal(h.memoryPrompts.length, 1, "memory retain uses its own explicit approval gate");
  assert.deepEqual(h.audits.filter((audit) => audit.adapterId === "security.workspace").map((audit) => audit.outcome), [
    "approval_requested", "approved", "succeeded", "succeeded",
  ]);
  assert.ok(h.audits.some((audit) => audit.adapterId === "hindsight" && audit.outcome === "approval_requested"));
  assert.ok(h.audits.some((audit) => audit.adapterId === "hindsight" && audit.outcome === "approved"));
  assert.deepEqual(
    h.audits.filter((audit) => audit.adapterId === "hindsight").map(({ operation, outcome }) => [operation, outcome]),
    [
      ["retain", "approval_requested"], ["retain", "approved"], ["retain", "succeeded"],
      ["recall", "succeeded"], ["recall", "succeeded"],
    ],
    "root-exported Hindsight adapter keeps the shared audit lifecycle",
  );
  assert.equal(h.audits.find((audit) => audit.adapterId === "hindsight" && audit.operation === "retain" && audit.outcome === "succeeded")?.approvalId,
    "memory-approval-1");

  assert.deepEqual(h.events.map((event) => event.type), [
    "approval.requested",
    "approval.granted",
    "adapter.operation.completed",
    "adapter.operation.completed",
    "approval.requested",
    "approval.granted",
    "adapter.operation.completed",
    "adapter.operation.completed",
    "adapter.operation.completed",
  ]);
  assert.equal(h.events[0].type, "approval.requested");
  assert.equal(h.events[0].request.runId, h.runId);
  assert.equal(h.securityEvents.some((event) => typeof event === "object" && event !== null && "type" in event && event.type === "approval.resolved"), true);
  assert.equal(h.events.some((event) => (event.type as string) === "approval.resolved"), false,
    "package-local security events do not leak into the core event vocabulary");
  assert.equal(JSON.stringify(h.audits).includes("secret-123"), false);
  assert.equal(JSON.stringify(h.audits).includes("The internal project"), false);
  assert.equal(JSON.stringify(h.audits).includes("credential"), false);
  assert.equal(await readFile(path.join(h.workspace, "approved.txt"), "utf8"), "approved local write");
});

test("unsafe workspace reads, denied memory writes, and unsupported forget all fail closed", async (t) => {
  const h = await harness(t, { memoryApproval: "denied" });

  await assert.rejects(
    h.security.readFile({ sessionId: h.sessionId, path: "../outside.txt" }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "PATH_OUTSIDE_WORKSPACE",
  );
  assert.equal(h.client.calls.length, 0, "an inaccessible workspace file cannot trigger a Hindsight request");
  assert.ok(h.events.some((event) => event.type === "adapter.operation.failed" && event.errorCode === "PATH_OUTSIDE_WORKSPACE"));
  assert.ok(h.audits.some((audit) => audit.adapterId === "security.workspace" && audit.outcome === "failed" &&
    audit.metadata?.errorCode === "PATH_OUTSIDE_WORKSPACE"));

  await assert.rejects(h.memory.retain({
    bankId: "project-notes",
    idempotencyKey: "cross-package-retain-denied",
    items: [{ text: "safe test input" }],
  }, h.context), (error: unknown) => error instanceof HindsightAdapterError && error.code === "APPROVAL_DENIED");
  assert.equal(h.client.calls.length, 0, "denied retain has zero remote side effects");
  const deniedRetainAudits = h.audits.filter((audit) => audit.adapterId === "hindsight" && audit.operation === "retain");
  assert.deepEqual(deniedRetainAudits.map((audit) => audit.outcome), ["approval_requested", "denied", "failed"]);
  assert.equal(deniedRetainAudits.at(-1)?.metadata?.errorCode, "APPROVAL_DENIED");
  assert.equal(deniedRetainAudits[1].approvalId, "memory-approval-1");

  assert.equal(h.memory.capabilities.forget, false);
  const bankId = hindsightBankIdForProject(h.projectId, "project-notes");
  const memoriesBeforeForget = h.client.count(bankId);
  await assert.rejects(h.memory.forget({
    bankId: "project-notes",
    memoryIds: ["explicit-memory-id"],
    idempotencyKey: "cross-package-forget-unsupported",
  }, h.context), (error: unknown) => error instanceof HindsightAdapterError && error.code === "FORGET_UNSUPPORTED");
  assert.equal(h.client.calls.length, 0, "unsupported forget does not call a Hindsight endpoint");
  assert.deepEqual(h.client.destructiveCalls, []);
  assert.equal(h.client.count(bankId), memoriesBeforeForget, "forget must not delete documents or the bank");
  assert.equal(h.memoryPrompts.length, 1, "denied retain asks once; unsupported forget never asks for approval");
  assert.equal(h.events.some((event) => event.type === "adapter.operation.failed" && event.errorCode === "FORGET_UNSUPPORTED"), true);
  assert.ok(h.audits.some((audit) => audit.adapterId === "hindsight" && audit.operation === "forget" &&
    audit.outcome === "failed" && audit.metadata?.errorCode === "FORGET_UNSUPPORTED"));
  assert.equal(JSON.stringify(h.audits).includes("explicit-memory-id"), false);
  assert.equal(JSON.stringify(h.audits).includes("outside.txt"), false);
});

test("workspace approval prompts, runtime events, and audits exclude file payloads and credentials", async (t) => {
  const h = await harness(t);
  const secret = "sk-test-local-write-canary-40c2";
  const payload = `private local document body; credential=${secret}`;

  await h.security.writeFile({ sessionId: h.sessionId, path: "approved-local.txt", data: payload });

  const serializedPrompts = JSON.stringify(h.securityPrompts);
  const serializedEvents = JSON.stringify({ packageEvents: h.securityEvents, runtimeEvents: h.events });
  const serializedAudits = JSON.stringify(h.audits);
  for (const projection of [serializedPrompts, serializedEvents, serializedAudits]) {
    assert.equal(projection.includes(secret), false);
    assert.equal(projection.includes(payload), false);
  }
  assert.equal(serializedPrompts.includes("approved-local.txt"), true, "the approval can identify the target resource");
  assert.equal(await readFile(path.join(h.workspace, "approved-local.txt"), "utf8"), payload);
});
