import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CAPABILITIES,
  CommandTimeoutError,
  SecurityError,
  WorkspaceSecurity,
} from "../src/index.js";

async function fixture(t, { approve } = {}) {
  const parent = await mkdtemp(path.join(os.tmpdir(), "dumb-bot-security-"));
  const workspace = path.join(parent, "workspace");
  await mkdir(workspace);
  await writeFile(path.join(workspace, "hello.txt"), "hello workspace\n");
  const events = [];
  const security = await WorkspaceSecurity.create({
    workspaceRoot: workspace,
    requestApproval: approve,
    emit: async (event) => events.push(structuredClone(event)),
  });
  t.after(() => rm(parent, { recursive: true, force: true }));
  return { parent, workspace, security, events };
}

test("workspace reads are allowed by default and produce a safe execution event", async (t) => {
  const { security, events } = await fixture(t);
  assert.equal(await security.readFile({ sessionId: "s1", path: "hello.txt" }), "hello workspace\n");
  assert.deepEqual(events, [{
    type: "capability.executed",
    sessionId: "s1",
    capability: CAPABILITIES.read,
    resource: "hello.txt",
    timestamp: events[0].timestamp,
  }]);
  assert.ok(Number.isFinite(Date.parse(events[0].timestamp)));
});

test("writes and commands are denied when no explicit approval provider exists", async (t) => {
  const { workspace, security, events } = await fixture(t);
  await assert.rejects(
    security.writeFile({ sessionId: "s1", path: "new.txt", data: "must not persist" }),
    (error) => error instanceof SecurityError && error.code === "APPROVAL_DENIED",
  );
  await assert.rejects(
    security.executeCommand({ sessionId: "s1", command: process.execPath, args: ["-e", "process.exit(0)"] }),
    (error) => error instanceof SecurityError && error.code === "APPROVAL_DENIED",
  );
  await assert.rejects(readFile(path.join(workspace, "new.txt")), { code: "ENOENT" });
  assert.equal(events.filter((event) => event.type === "approval.requested").length, 2);
  assert.deepEqual(events.filter((event) => event.type === "approval.resolved").map((event) => event.approved), [false, false]);
  assert.equal(events.filter((event) => event.type === "capability.denied").length, 2);
  assert.equal(events.some((event) => event.type === "capability.executed"), false);
});

test("lexical traversal, absolute escapes and symlink escapes are denied before side effects", async (t) => {
  const { parent, workspace, security, events } = await fixture(t);
  const outsideFile = path.join(parent, "outside.txt");
  await writeFile(outsideFile, "untouched");
  await symlink(outsideFile, path.join(workspace, "escape-link.txt"));

  await assert.rejects(security.readFile({ sessionId: "s1", path: "../outside.txt" }), SecurityError);
  await assert.rejects(security.readFile({ sessionId: "s1", path: outsideFile }), SecurityError);
  await assert.rejects(security.readFile({ sessionId: "s1", path: "escape-link.txt" }), SecurityError);
  await assert.rejects(security.writeFile({ sessionId: "s1", path: "../outside.txt", data: "bad" }), SecurityError);
  await assert.rejects(security.writeFile({ sessionId: "s1", path: "escape-link.txt", data: "bad" }), SecurityError);
  await assert.rejects(
    security.executeCommand({ sessionId: "s1", command: process.execPath, cwd: ".." }),
    SecurityError,
  );
  assert.equal(await readFile(outsideFile, "utf8"), "untouched");
  assert.equal(events.filter((event) => event.type === "approval.requested").length, 0);
  assert.ok(events.filter((event) => event.type === "capability.denied").every((event) => event.resource === "<outside-workspace>"));
});

test("an approved write is requested before the side effect and resolved once", async (t) => {
  const order = [];
  const { workspace, events } = await fixture(t, {
    approve: async (prompt) => {
      order.push(`approval:${prompt.capability}`);
      assert.equal(prompt.details.path, "created.txt");
      return true;
    },
  });
  const security = await WorkspaceSecurity.create({
    workspaceRoot: workspace,
    requestApproval: async (prompt) => {
      order.push(`approval:${prompt.capability}`);
      return true;
    },
    emit: async (event) => {
      events.push(structuredClone(event));
      if (event.type === "approval.requested") order.push("requested-event");
    },
  });

  await security.writeFile({ sessionId: "s2", path: "created.txt", data: "approved" });
  assert.equal(await readFile(path.join(workspace, "created.txt"), "utf8"), "approved");
  assert.deepEqual(order, ["requested-event", `approval:${CAPABILITIES.write}`]);
  assert.equal(events.filter((event) => event.type === "approval.resolved" && event.approved).length, 1);
  assert.equal(events.filter((event) => event.type === "capability.executed" && event.capability === CAPABILITIES.write).length, 1);
});

test("command timeout terminates the process and is recorded as a failure", async (t) => {
  const { security, events } = await fixture(t, { approve: async () => true });
  await assert.rejects(
    security.executeCommand({
      sessionId: "s3",
      command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 5000)"],
      timeoutMs: 40,
    }),
    (error) => error instanceof CommandTimeoutError && error.code === "COMMAND_TIMEOUT",
  );
  assert.equal(events.filter((event) => event.type === "approval.requested").length, 1);
  assert.equal(events.filter((event) => event.type === "approval.resolved" && event.approved).length, 1);
  assert.equal(events.filter((event) => event.type === "capability.failed" && event.capability === CAPABILITIES.execute).length, 1);
  assert.equal(events.find((event) => event.type === "capability.failed").errorCode, "COMMAND_TIMEOUT");
  assert.equal(events.some((event) => event.type === "capability.executed" && event.capability === CAPABILITIES.execute), false);
});

test("approval callback cannot mutate the command after reviewing it", async (t) => {
  const { security } = await fixture(t, {
    approve: async (prompt) => {
      assert.equal(prompt.details.command, process.execPath);
      try {
        prompt.details.args[1] = "process.stdout.write('changed')";
      } catch {
        // Frozen prompt data is expected in strict-mode ES modules.
      }
      return true;
    },
  });
  const result = await security.executeCommand({
    sessionId: "s6",
    command: process.execPath,
    args: ["-e", "process.stdout.write('original')"],
  });
  assert.equal(result.stdout, "original");
});

test("secrets in file contents and command arguments never enter audit events", async (t) => {
  const secret = "sk-live-DO_NOT_WRITE_TO_AUDIT-123456";
  const { workspace, events } = await fixture(t, { approve: async () => true });
  const security = await WorkspaceSecurity.create({
    workspaceRoot: workspace,
    requestApproval: async () => true,
    emit: async (event) => events.push(structuredClone(event)),
  });

  await security.writeFile({ sessionId: "s4", path: "private.txt", data: secret });
  const result = await security.executeCommand({
    sessionId: "s4",
    command: process.execPath,
    args: ["-e", "process.stdout.write(process.argv[1])", secret],
  });
  assert.equal(result.stdout, secret);
  assert.equal(await readFile(path.join(workspace, "private.txt"), "utf8"), secret);
  assert.equal(JSON.stringify(events).includes(secret), false);
  assert.ok(events.every((event) => !("details" in event)));
  assert.ok(events.filter((event) => event.type === "approval.requested").every((event) => event.reason && event.resource));
});

test("denied approval cannot be reused for a later operation", async (t) => {
  let calls = 0;
  const { security, workspace } = await fixture(t, { approve: async () => ++calls > 1 });
  await assert.rejects(security.writeFile({ sessionId: "s5", path: "first.txt", data: "no" }), /not approved/);
  await security.writeFile({ sessionId: "s5", path: "second.txt", data: "yes" });
  await assert.rejects(readFile(path.join(workspace, "first.txt")), { code: "ENOENT" });
  assert.equal(await readFile(path.join(workspace, "second.txt"), "utf8"), "yes");
  assert.equal(calls, 2);
});

test("approval provider errors fail closed and never leak credentials or operation content into events", async (t) => {
  const secret = "sk-test-approval-provider-canary-825a";
  const payload = `private file body ${secret}`;
  const { parent, workspace, security, events } = await fixture(t, {
    approve: async () => { throw new Error(`private provider failure ${secret}`); },
  });
  const sentinel = path.join(parent, "command-ran.txt");

  await assert.rejects(
    security.writeFile({ sessionId: "s7", path: "private.txt", data: payload }),
    (error) => error instanceof SecurityError && error.code === "APPROVAL_DENIED",
  );
  await assert.rejects(
    security.executeCommand({
      sessionId: "s7",
      command: process.execPath,
      args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, ${JSON.stringify(secret)})`],
    }),
    (error) => error instanceof SecurityError && error.code === "APPROVAL_DENIED",
  );

  await assert.rejects(readFile(path.join(workspace, "private.txt")), { code: "ENOENT" });
  await assert.rejects(readFile(sentinel), { code: "ENOENT" });
  assert.equal(events.filter((event) => event.type === "approval.requested").length, 2);
  assert.deepEqual(events.filter((event) => event.type === "approval.resolved").map((event) => event.approved), [false, false]);
  assert.equal(events.some((event) => event.type === "capability.executed"), false);
  const serializedEvents = JSON.stringify(events);
  assert.equal(serializedEvents.includes(secret), false);
  assert.equal(serializedEvents.includes(payload), false);
  assert.equal(serializedEvents.includes("private provider failure"), false);
  assert.ok(events.every((event) => !("details" in event)));
});
