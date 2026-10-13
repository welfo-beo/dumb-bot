import assert from "node:assert/strict";
import { test } from "node:test";
import { SecurityEventMapper } from "../../src/core/security-event-mapper.ts";

test("maps package approval request/resolution to the existing core event names", () => {
  const mapper = new SecurityEventMapper();
  const requested = mapper.map({
    type: "approval.requested",
    requestId: "approval-1",
    sessionId: "session-1",
    capability: "workspace.write",
    resource: "document-7",
    reason: "write requested",
    createdAt: "2026-10-13T00:00:00.000Z",
  }, { runId: "run-1" });
  assert.equal(requested.runtimeEvent.type, "approval.requested");
  assert.equal(requested.auditRecord.outcome, "approval_requested");

  const resolved = mapper.map({ type: "approval.resolved", requestId: "approval-1", approved: false, decidedAt: "2026-10-13T00:00:01.000Z" }, { runId: "run-2" });
  assert.equal(resolved.runtimeEvent.type, "approval.denied");
  assert.equal(resolved.auditRecord.runId, "run-1");
  assert.equal(resolved.auditRecord.outcome, "denied");
  assert.throws(() => mapper.map({ type: "approval.resolved", requestId: "unknown", approved: true, decidedAt: "2026-10-13T00:00:02.000Z" }, { runId: "run-2" }), /unmatched/);
});

test("maps capability events to generic adapter operation events", () => {
  const mapper = new SecurityEventMapper();
  const result = mapper.map({ type: "capability.executed", sessionId: "session-2", capability: "workspace.read", resource: "file-3", timestamp: "2026-10-13T00:00:00.000Z" }, { runId: "run-3" });
  assert.equal(result.runtimeEvent.type, "adapter.operation.completed");
  assert.equal(result.auditRecord.access, "read");
  assert.equal(result.auditRecord.outcome, "succeeded");
  assert.equal(result.auditRecord.adapterId, "security.workspace");
  assert.equal(result.auditRecord.operation, "workspace.read");
  assert.equal(result.auditRecord.sessionId, "session-2");
  assert.equal(result.auditRecord.runId, "run-3");
  assert.equal(result.auditRecord.metadata?.resource, "file-3");
  assert.equal(result.auditRecord.occurredAt, "2026-10-13T00:00:00.000Z");
});

test("maps denied and failed package operations to core failures with safe audit metadata", () => {
  const mapper = new SecurityEventMapper();
  const denied = mapper.map({
    type: "capability.denied",
    sessionId: "session-4",
    capability: "workspace.write",
    resource: "<outside-workspace>",
    errorCode: "SECURITY_DENIED",
    timestamp: "2026-10-13T00:00:01.000Z",
  }, { runId: "run-4" });
  assert.equal(denied.runtimeEvent.type, "adapter.operation.failed");
  assert.equal(denied.runtimeEvent.errorCode, "SECURITY_DENIED");
  assert.equal(denied.auditRecord.outcome, "failed");
  assert.equal(denied.auditRecord.metadata?.errorCode, "SECURITY_DENIED");

  const failed = mapper.map({
    type: "capability.failed",
    sessionId: "session-5",
    capability: "command.execute",
    resource: "command",
    approvalRequestId: "approval-5",
    errorCode: "COMMAND_FAILED",
    timestamp: "2026-10-13T00:00:02.000Z",
  }, { runId: "run-5" });
  assert.equal(failed.runtimeEvent.type, "adapter.operation.failed");
  assert.equal(failed.runtimeEvent.operation, "command.execute");
  assert.equal(failed.runtimeEvent.errorCode, "COMMAND_FAILED");
  assert.equal(failed.auditRecord.access, "write");
  assert.equal(failed.auditRecord.outcome, "failed");
  assert.equal(failed.auditRecord.approvalId, "approval-5");
  assert.equal(failed.auditRecord.metadata?.errorCode, "COMMAND_FAILED");
  assert.equal(failed.auditRecord.sessionId, "session-5");
  assert.equal(failed.auditRecord.runId, "run-5");
  assert.equal(failed.auditRecord.occurredAt, "2026-10-13T00:00:02.000Z");
});
