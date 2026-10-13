export type Capability = "workspace.read" | "workspace.write" | "command.execute";

export interface ApprovalRequestedEvent {
  readonly type: "approval.requested";
  readonly requestId: string;
  readonly sessionId: string;
  readonly capability: Capability;
  readonly resource: string;
  readonly reason: string;
  readonly createdAt: string;
}

export interface ApprovalResolvedEvent {
  readonly type: "approval.resolved";
  readonly requestId: string;
  readonly approved: boolean;
  readonly decidedAt: string;
}

export type CapabilityEvent =
  | {
      readonly type: "capability.denied";
      readonly sessionId: string;
      readonly capability: Capability;
      readonly resource: string;
      readonly errorCode?: string;
      readonly approvalRequestId?: string;
      readonly timestamp: string;
    }
  | {
      readonly type: "capability.executed";
      readonly sessionId: string;
      readonly capability: Capability;
      readonly resource: string;
      readonly approvalRequestId?: string;
      readonly timestamp: string;
    }
  | {
      readonly type: "capability.failed";
      readonly sessionId: string;
      readonly capability: Capability;
      readonly resource: string;
      readonly errorCode: string;
      readonly approvalRequestId?: string;
      readonly timestamp: string;
    };

export type SecurityEvent = ApprovalRequestedEvent | ApprovalResolvedEvent | CapabilityEvent;
export type SecurityEventSink = (event: SecurityEvent) => void | Promise<void>;

export interface ApprovalPrompt {
  readonly requestId: string;
  readonly sessionId: string;
  readonly capability: Capability;
  readonly resource: string;
  readonly reason: string;
  readonly createdAt: string;
  /** Sensitive operation detail for the approval UI only; never emitted to the audit sink. */
  readonly details: Readonly<Record<string, unknown>>;
}

export type ApprovalProvider = (prompt: ApprovalPrompt) => boolean | Promise<boolean>;

export interface WorkspaceSecurityOptions {
  readonly workspaceRoot: string;
  readonly emit: SecurityEventSink;
  /** Omission means every write/command request is denied. */
  readonly requestApproval?: ApprovalProvider;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

export interface ReadFileInput {
  readonly sessionId: string;
  readonly path: string;
  readonly encoding?: string | "buffer";
}

export interface WriteFileInput {
  readonly sessionId: string;
  readonly path: string;
  readonly data: string | Uint8Array;
}

export interface ExecuteCommandInput {
  readonly sessionId: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export declare const CAPABILITIES: Readonly<{
  read: "workspace.read";
  write: "workspace.write";
  execute: "command.execute";
}>;

export declare class SecurityError extends Error {
  readonly code: string;
  constructor(code: string, message?: string);
}

export declare class CommandTimeoutError extends SecurityError {
  readonly timeoutMs: number;
  constructor(timeoutMs: number);
}

export declare class CommandExitError extends SecurityError {
  readonly exitCode: number | null;
  readonly signal?: string;
  constructor(exitCode: number | null, signal?: string | null);
}

export declare class OutputLimitError extends SecurityError {}

export declare class WorkspaceSecurity {
  static create(options: WorkspaceSecurityOptions): Promise<WorkspaceSecurity>;
  readFile(input: ReadFileInput): Promise<string | Uint8Array>;
  writeFile(input: WriteFileInput): Promise<void>;
  executeCommand(input: ExecuteCommandInput): Promise<CommandResult>;
}
