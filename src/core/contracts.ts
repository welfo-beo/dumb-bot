// Shared integration contract v0.2 for dumb-bot.
// Pi is the only runtime; adapters/extensions must not create another agent loop.

export type AdapterAccess = "read" | "write";

export interface AdapterCapabilities {
  readonly read: boolean;
  readonly write: boolean;
  readonly streaming?: boolean;
  readonly resume?: boolean;
  readonly cancel?: boolean;
  readonly approval?: boolean;
}

export interface ApprovalRequest {
  readonly adapterId: string;
  readonly operation: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly summary: string;
}

export type ApprovalDecision =
  | { readonly status: "approved"; readonly approvalId: string; readonly decidedAt: string }
  | { readonly status: "denied"; readonly approvalId: string; readonly decidedAt: string; readonly reason?: string };

export interface AuditRecord {
  readonly adapterId: string;
  readonly operation: string;
  readonly access: AdapterAccess;
  readonly outcome: "succeeded" | "failed" | "approval_requested" | "approved" | "denied";
  readonly sessionId: string;
  readonly runId: string;
  readonly approvalId?: string;
  /** Safe metadata only: never include credentials, raw prompts, or unredacted memory content. */
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
  readonly occurredAt: string;
}

export type RuntimeEvent =
  | { readonly type: "approval.requested"; readonly request: ApprovalRequest }
  | { readonly type: "approval.granted"; readonly request: ApprovalRequest; readonly decision: ApprovalDecision }
  | { readonly type: "approval.denied"; readonly request: ApprovalRequest; readonly decision: ApprovalDecision }
  | { readonly type: "adapter.operation.completed"; readonly adapterId: string; readonly operation: string; readonly access: AdapterAccess; readonly sessionId: string; readonly runId: string }
  | { readonly type: "adapter.operation.failed"; readonly adapterId: string; readonly operation: string; readonly access: AdapterAccess; readonly sessionId: string; readonly runId: string; readonly errorCode: string };

export interface AdapterContext {
  /** Stable project/workspace identity; memory banks must be isolated by this value. */
  readonly projectId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly signal?: AbortSignal;
  /** Default is read-only; every write requires an explicit approval before side effects. */
  readonly policy: { readonly defaultAccess: "read-only"; readonly writesRequireApproval: true };
  requestApproval(request: ApprovalRequest): Promise<ApprovalDecision>;
  audit(record: AuditRecord): Promise<void>;
  emit(event: RuntimeEvent): Promise<void>;
}

export interface MemoryRecord {
  readonly id: string;
  readonly text: string;
  readonly source?: string;
  readonly createdAt: string;
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}

export interface MemoryWriteItem {
  /** Caller must redact sensitive content before handing it to an adapter. */
  readonly text: string;
  readonly source?: string;
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}

export interface MemoryRecallInput {
  /** Requested bank within this project; adapters must enforce project isolation. */
  readonly bankId: string;
  readonly query: string;
  readonly limit?: number;
}

export interface MemoryReflectInput {
  /** Requested bank within this project; adapters must enforce project isolation. */
  readonly bankId: string;
  readonly query: string;
  readonly evidence?: readonly MemoryRecord[];
}

export interface MemoryRetainInput {
  /** Requested bank within this project; adapters must enforce project isolation. */
  readonly bankId: string;
  readonly items: readonly MemoryWriteItem[];
  /** Required for retry-safe writes. */
  readonly idempotencyKey: string;
}

export interface MemoryRetainReceipt {
  readonly accepted: number;
  readonly operationId?: string;
}

export interface MemoryForgetInput {
  /** Requested bank within this project; adapters must enforce project isolation. */
  readonly bankId: string;
  /** Exact memory IDs only; an implementation must never widen this to a bank-wide delete. */
  readonly memoryIds: readonly string[];
  /** Required for retry-safe writes. */
  readonly idempotencyKey: string;
}

export interface MemoryForgetReceipt {
  readonly deleted: number;
}

export interface MemoryAdapter {
  readonly id: string;
  readonly capabilities: AdapterCapabilities & {
    readonly recall: boolean;
    readonly reflect: boolean;
    readonly retain: boolean;
    readonly forget: boolean;
  };
  recall(input: MemoryRecallInput, context: AdapterContext): Promise<readonly MemoryRecord[]>;
  reflect(input: MemoryReflectInput, context: AdapterContext): Promise<string>;
  /** Must request approval and emit audit records before any write; denied requests must have no side effects. */
  retain(input: MemoryRetainInput, context: AdapterContext): Promise<MemoryRetainReceipt>;
  /** Always present; unsupported adapters must declare forget: false and fail closed without side effects. */
  forget(input: MemoryForgetInput, context: AdapterContext): Promise<MemoryForgetReceipt>;
}
