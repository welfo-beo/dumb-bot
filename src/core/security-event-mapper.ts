import type { SecurityEvent } from "../../packages/security/src/index.js";
import type { AdapterAccess, ApprovalDecision, ApprovalRequest, AuditRecord, RuntimeEvent } from "./contracts.js";

const ADAPTER_ID = "security.workspace";

interface PendingApproval {
  readonly request: ApprovalRequest;
  readonly capability: string;
  readonly resource: string;
}

export interface SecurityEventScope {
  readonly runId: string;
}

export interface MappedSecurityEvent {
  readonly runtimeEvent: RuntimeEvent;
  readonly auditRecord: AuditRecord;
}

function accessFor(capability: string): AdapterAccess {
  return capability === "workspace.read" ? "read" : "write";
}

/** Maps the workspace package's local events into the one shared core event vocabulary. */
export class SecurityEventMapper {
  private readonly pending = new Map<string, PendingApproval>();

  map(event: SecurityEvent, scope: SecurityEventScope): MappedSecurityEvent {
    if (event.type === "approval.requested") {
      const request: ApprovalRequest = {
        adapterId: ADAPTER_ID,
        operation: event.capability,
        sessionId: event.sessionId,
        runId: scope.runId,
        summary: event.reason,
      };
      this.pending.set(event.requestId, { request, capability: event.capability, resource: event.resource });
      return {
        runtimeEvent: { type: "approval.requested", request },
        auditRecord: this.audit(request, "write", "approval_requested", event.createdAt, {
          capability: event.capability,
          resource: event.resource,
        }),
      };
    }

    if (event.type === "approval.resolved") {
      const pending = this.pending.get(event.requestId);
      if (!pending) throw new Error(`unmatched security approval resolution: ${event.requestId}`);
      this.pending.delete(event.requestId);
      const decision: ApprovalDecision = event.approved
        ? { status: "approved", approvalId: event.requestId, decidedAt: event.decidedAt }
        : { status: "denied", approvalId: event.requestId, decidedAt: event.decidedAt, reason: "rejected by approver" };
      const access = accessFor(pending.capability);
      return {
        runtimeEvent: event.approved
          ? { type: "approval.granted", request: pending.request, decision }
          : { type: "approval.denied", request: pending.request, decision },
        auditRecord: this.audit(pending.request, access, event.approved ? "approved" : "denied", event.decidedAt, {
          capability: pending.capability,
          resource: pending.resource,
        }, event.requestId),
      };
    }

    const access = accessFor(event.capability);
    const failed = event.type !== "capability.executed";
    const errorCode = event.type === "capability.denied"
      ? event.errorCode ?? "CAPABILITY_DENIED"
      : event.type === "capability.failed"
        ? event.errorCode
        : undefined;
    const request: ApprovalRequest = {
      adapterId: ADAPTER_ID,
      operation: event.capability,
      sessionId: event.sessionId,
      runId: scope.runId,
      summary: event.type === "capability.executed" ? "Workspace capability executed" : "Workspace capability failed",
    };
    return {
      runtimeEvent: !failed
        ? { type: "adapter.operation.completed", adapterId: ADAPTER_ID, operation: event.capability, access, sessionId: event.sessionId, runId: scope.runId }
        : { type: "adapter.operation.failed", adapterId: ADAPTER_ID, operation: event.capability, access, sessionId: event.sessionId, runId: scope.runId, errorCode: errorCode ?? "OPERATION_FAILED" },
      auditRecord: this.audit(request, access, failed ? "failed" : "succeeded", event.timestamp, {
        capability: event.capability,
        resource: event.resource,
        ...(errorCode ? { errorCode } : {}),
      }, event.approvalRequestId),
    };
  }

  private audit(
    request: ApprovalRequest,
    access: AdapterAccess,
    outcome: AuditRecord["outcome"],
    occurredAt: string,
    metadata: Readonly<Record<string, string | number | boolean>>,
    approvalId?: string,
  ): AuditRecord {
    return {
      adapterId: ADAPTER_ID,
      operation: request.operation,
      access,
      outcome,
      sessionId: request.sessionId,
      runId: request.runId,
      ...(approvalId ? { approvalId } : {}),
      metadata,
      occurredAt,
    };
  }
}
