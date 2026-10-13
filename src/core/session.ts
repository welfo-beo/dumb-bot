import { resolve } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  type AgentSession,
  type CreateAgentSessionOptions,
  type CreateAgentSessionResult,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import { ComponentRegistry } from "./registry.js";

export type PiResourceLoaderOptions = ConstructorParameters<typeof DefaultResourceLoader>[0];
export type PiExtensionBindings = Parameters<AgentSession["bindExtensions"]>[0];

export type SessionSelection =
  | { readonly mode: "new" }
  | { readonly mode: "continue" }
  | { readonly mode: "resume"; readonly sessionId: string };

export type SessionManagerApi = Pick<typeof SessionManager, "create" | "continueRecent" | "findById" | "open">;

export interface SelectSessionManagerOptions {
  readonly cwd: string;
  readonly sessionDir?: string;
  readonly selection?: SessionSelection;
}

export class SessionNotFoundError extends Error {
  readonly sessionId: string;
  constructor(sessionId: string) {
    super(`Pi session not found: ${sessionId}`);
    this.name = "SessionNotFoundError";
    this.sessionId = sessionId;
  }
}

/** Selects Pi's own persistent JSONL session manager; there is no parallel transcript store. */
export function selectSessionManager(
  options: SelectSessionManagerOptions,
  api: SessionManagerApi = SessionManager,
): SessionManager {
  const cwd = resolve(options.cwd);
  const sessionDir = options.sessionDir ? resolve(options.sessionDir) : undefined;
  const selection = options.selection ?? { mode: "new" as const };

  if (selection.mode === "continue") return api.continueRecent(cwd, sessionDir);
  if (selection.mode === "resume") {
    const sessionId = selection.sessionId.trim();
    if (!sessionId) throw new TypeError("sessionId is required to resume a session");
    const sessionFile = api.findById(cwd, sessionId, sessionDir);
    if (!sessionFile) throw new SessionNotFoundError(sessionId);
    return api.open(sessionFile, sessionDir, cwd);
  }
  return api.create(cwd, sessionDir);
}

export interface StartPiSessionOptions {
  readonly projectId: string;
  readonly cwd?: string;
  readonly sessionDir?: string;
  readonly agentDir?: string;
  readonly selection?: SessionSelection;
  readonly registry: ComponentRegistry;
  readonly extensionBindings?: PiExtensionBindings;
}

export interface SessionDependencies {
  readonly sessionManagerApi?: SessionManagerApi;
  readonly createResourceLoader?: (options: PiResourceLoaderOptions) => ResourceLoader;
  readonly createAgentSession?: (options: CreateAgentSessionOptions) => Promise<CreateAgentSessionResult>;
}

export class ManagedPiSession {
  private disposed = false;

  constructor(
    readonly projectId: string,
    readonly session: AgentSession,
  ) {}

  get sessionId(): string {
    return this.session.sessionId;
  }

  get sessionFile(): string | undefined {
    return this.session.sessionFile;
  }

  prompt(text: string): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("Pi session is disposed"));
    return this.session.prompt(text);
  }

  subscribe(listener: Parameters<AgentSession["subscribe"]>[0]): () => void {
    return this.session.subscribe(listener);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.session.dispose();
  }
}

/** Creates or recovers one Pi session, loads registered extensions, and binds their lifecycle. */
export async function startPiSession(
  options: StartPiSessionOptions,
  dependencies: SessionDependencies = {},
): Promise<ManagedPiSession> {
  if (!options.projectId.trim()) throw new TypeError("projectId is required");
  const cwd = resolve(options.cwd ?? process.cwd());
  const agentDir = resolve(options.agentDir ?? getAgentDir());
  const sessionManager = selectSessionManager({
    cwd,
    sessionDir: options.sessionDir,
    selection: options.selection,
  }, dependencies.sessionManagerApi);
  const extensionPaths = options.registry.getExtensionPaths().map((path) => resolve(cwd, path));
  const loaderOptions: PiResourceLoaderOptions = { cwd, agentDir, additionalExtensionPaths: [...extensionPaths] };
  const resourceLoader = dependencies.createResourceLoader?.(loaderOptions)
    ?? new DefaultResourceLoader(loaderOptions);

  await resourceLoader.reload();
  const create = dependencies.createAgentSession ?? createAgentSession;
  let result: CreateAgentSessionResult | undefined;
  try {
    result = await create({ cwd, agentDir, sessionManager, resourceLoader, noTools: "builtin" });
    await result.session.bindExtensions(options.extensionBindings ?? { mode: "print" });
    return new ManagedPiSession(options.projectId, result.session);
  } catch (error) {
    result?.session.dispose();
    throw error;
  }
}
