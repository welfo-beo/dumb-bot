import { ComponentRegistry } from "./registry.js";
import { startPiSession, type ManagedPiSession, type SessionSelection, type SessionDependencies } from "./session.js";

export interface StartRuntimeOptions {
  readonly projectId: string;
  readonly cwd?: string;
  readonly sessionDir?: string;
  readonly agentDir?: string;
  readonly selection?: SessionSelection;
}

/** Owns exactly one Pi session and delegates all agent-loop behavior to Pi. */
export class DumbBotRuntime {
  private active?: ManagedPiSession;

  constructor(
    readonly registry = new ComponentRegistry(),
    private readonly dependencies: SessionDependencies = {},
  ) {}

  get session(): ManagedPiSession | undefined {
    return this.active;
  }

  async start(options: StartRuntimeOptions): Promise<ManagedPiSession> {
    if (this.active) throw new Error("runtime already has an active Pi session");
    this.active = await startPiSession({ ...options, registry: this.registry }, this.dependencies);
    return this.active;
  }

  stop(): void {
    this.active?.dispose();
    this.active = undefined;
  }
}
