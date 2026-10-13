import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentSession, CreateAgentSessionOptions, CreateAgentSessionResult, ResourceLoader } from "@earendil-works/pi-coding-agent";
import { ComponentRegistry } from "../../src/core/registry.ts";
import { SessionNotFoundError, selectSessionManager, startPiSession, type PiResourceLoaderOptions, type SessionManagerApi } from "../../src/core/session.ts";
import type { SessionManager } from "@earendil-works/pi-coding-agent";

function fakeApi(calls: string[], sessionFile?: string): SessionManagerApi {
  const resolvedSessionFile = arguments.length >= 2 ? sessionFile : "/tmp/pi-session.jsonl";
  const manager = {} as SessionManager;
  return {
    create: (cwd, dir) => { calls.push(`create:${cwd}:${dir ?? ""}`); return manager; },
    continueRecent: (cwd, dir) => { calls.push(`continue:${cwd}:${dir ?? ""}`); return manager; },
    findById: (cwd, id, dir) => { calls.push(`find:${cwd}:${id}:${dir ?? ""}`); return resolvedSessionFile; },
    open: (path, dir, cwd) => { calls.push(`open:${path}:${dir ?? ""}:${cwd ?? ""}`); return manager; },
  };
}

test("new and continue select Pi's native session managers", () => {
  const calls: string[] = [];
  selectSessionManager({ cwd: "/tmp/project" }, fakeApi(calls));
  selectSessionManager({ cwd: "/tmp/project", sessionDir: "/tmp/sessions", selection: { mode: "continue" } }, fakeApi(calls));
  assert.equal(calls[0], "create:/tmp/project:");
  assert.equal(calls[1], "continue:/tmp/project:/tmp/sessions");
});

test("resume opens only an exact Pi session id and fails when it is absent", () => {
  const calls: string[] = [];
  selectSessionManager({ cwd: "/tmp/project", selection: { mode: "resume", sessionId: "session-7" } }, fakeApi(calls));
  assert.deepEqual(calls, ["find:/tmp/project:session-7:", "open:/tmp/pi-session.jsonl::/tmp/project"]);
  const missing = fakeApi([], undefined);
  assert.throws(() => selectSessionManager({ cwd: "/tmp/project", selection: { mode: "resume", sessionId: "missing" } }, missing), SessionNotFoundError);
});

test("startup loads registered extensions and binds them to the Pi session", async () => {
  const calls: string[] = [];
  const api = fakeApi(calls);
  const registry = new ComponentRegistry();
  registry.registerExtension({ id: "test.extension", path: "./extensions/test.ts", capabilities: ["session.state"] });
  const resourceLoader = { reload: async () => { calls.push("reload"); } } as unknown as ResourceLoader;
  const fakeSession = {
    sessionId: "session-8",
    sessionFile: "/tmp/session-8.jsonl",
    model: undefined,
    bindExtensions: async (bindings: { mode?: string }) => { calls.push(`bind:${bindings.mode}`); },
    dispose: () => { calls.push("dispose"); },
    prompt: async () => undefined,
    subscribe: () => () => undefined,
  } as unknown as AgentSession;
  const createAgentSession = async (options: CreateAgentSessionOptions) => {
    assert.ok(options.sessionManager);
    assert.equal(options.noTools, "builtin", "Pi built-in read/bash/edit/write tools must remain disabled");
    calls.push("create-session");
    return { session: fakeSession } as CreateAgentSessionResult;
  };
  const managed = await startPiSession({ projectId: "project-1", cwd: "/tmp/project", registry }, {
    sessionManagerApi: api,
    createResourceLoader: (options: PiResourceLoaderOptions) => {
      assert.deepEqual(options.additionalExtensionPaths, ["/tmp/project/extensions/test.ts"]);
      return resourceLoader;
    },
    createAgentSession,
  });
  assert.equal(managed.sessionId, "session-8");
  assert.deepEqual(calls.slice(-3), ["reload", "create-session", "bind:print"]);
  managed.dispose();
  managed.dispose();
  assert.equal(calls.filter((call) => call === "dispose").length, 1);
});
