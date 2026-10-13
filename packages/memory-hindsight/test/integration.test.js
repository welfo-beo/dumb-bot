import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import {
  HindsightAdapterError,
  HindsightMemoryAdapter,
  hindsightBankIdForProject,
} from "../src/index.js";

const API_KEY = "test-token-never-audit";

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(res, status, value) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

async function fakeHindsight(t) {
  const requests = [];
  const banks = new Map();
  let nextMemoryId = 1;
  let rejectStatus = 0;

  const server = createServer(async (req, res) => {
    const body = await readJson(req);
    const url = new URL(req.url, "http://127.0.0.1");
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    requests.push({ method: req.method, path: url.pathname, parts, headers: req.headers, body });

    if (rejectStatus) {
      sendJson(res, rejectStatus, { detail: `Bearer ${API_KEY}; upstream-secret-detail` });
      return;
    }

    if (parts[0] !== "v1" || parts[1] !== "default" || parts[2] !== "banks" || !parts[3]) {
      sendJson(res, 404, { detail: "unknown route" });
      return;
    }
    const bankId = parts[3];
    const resource = parts.slice(4);
    let bank = banks.get(bankId);
    if (!bank) {
      bank = new Map();
      banks.set(bankId, bank);
    }

    if (req.method === "POST" && resource.length === 1 && resource[0] === "memories") {
      for (const item of body.items ?? []) {
        const id = `memory-${nextMemoryId++}`;
        bank.set(id, {
          id,
          text: item.content,
          document_id: item.document_id,
          context: item.context,
          metadata: item.metadata,
          mentioned_at: "2026-10-13T10:00:00.000Z",
          type: "world",
          state: "valid",
        });
      }
      sendJson(res, 200, {
        success: true,
        bank_id: bankId,
        items_count: body.items?.length ?? 0,
        async: body.async,
        operation_id: body.operation_id,
      });
      return;
    }

    if (req.method === "POST" && resource[0] === "memories" && resource[1] === "recall") {
      const results = [...bank.values()]
        .filter((item) => item.state === "valid" && item.text.toLowerCase().includes(String(body.query).toLowerCase()))
        .map(({ state, ...item }) => item);
      sendJson(res, 200, { results });
      return;
    }

    if (req.method === "POST" && resource.length === 1 && resource[0] === "reflect") {
      sendJson(res, 200, { text: `reflection for ${bankId}: ${body.query}` });
      return;
    }

    sendJson(res, 404, { detail: "unknown route" });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    banks,
    setRejectRequests(value) { rejectStatus = value === true ? 401 : (value || 0); },
    seed(bankId, memory) {
      let bank = banks.get(bankId);
      if (!bank) {
        bank = new Map();
        banks.set(bankId, bank);
      }
      bank.set(memory.id, structuredClone(memory));
    },
  };
}

function makeContext({ projectId = "project-alpha", approve = true, onApproval } = {}) {
  const events = [];
  const audits = [];
  let approvalCount = 0;
  const context = {
    projectId,
    sessionId: "session-01",
    runId: "run-01",
    policy: { defaultAccess: "read-only", writesRequireApproval: true },
    emit: async (event) => events.push(structuredClone(event)),
    audit: async (record) => audits.push(structuredClone(record)),
    requestApproval: async (request) => {
      approvalCount += 1;
      await onApproval?.(request, approvalCount);
      return {
        status: approve ? "approved" : "denied",
        approvalId: `approval-${approvalCount}`,
        decidedAt: "2026-10-13T10:01:00.000Z",
        ...(!approve ? { reason: "test denial" } : {}),
      };
    },
  };
  return { context, events, audits, get approvalCount() { return approvalCount; } };
}

function adapterFor(fake, options = {}) {
  return new HindsightMemoryAdapter({
    baseUrl: fake.baseUrl,
    apiKey: API_KEY,
    timeoutMs: 1_000,
    ...options,
  });
}

test("contract integration: retain, recall, reflect use the bank derived from projectId", async (t) => {
  const fake = await fakeHindsight(t);
  const adapter = adapterFor(fake, { redact: (text) => text.replaceAll("private", "[redacted]") });
  const host = makeContext({
    onApproval: async () => assert.equal(fake.requests.length, 0, "approval must precede the remote write"),
  });
  const remoteBankId = hindsightBankIdForProject(host.context.projectId, "workspace-memory");

  const receipt = await adapter.retain({
    bankId: "workspace-memory",
    idempotencyKey: "retain-project-alpha-01",
    items: [{ text: "The private project plan is blue", source: "session transcript", metadata: { priority: 2 } }],
  }, host.context);
  assert.equal(receipt.accepted, 1);
  assert.match(receipt.operationId, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

  const recalled = await adapter.recall({ bankId: "workspace-memory", query: "blue", limit: 1 }, host.context);
  assert.equal(recalled.length, 1);
  assert.equal(recalled[0].text, "The [redacted] project plan is blue");
  assert.equal(recalled[0].source, fake.requests[0].body.items[0].document_id);
  assert.equal(recalled[0].metadata.dumb_bot_session_id, "session-01");

  const reflection = await adapter.reflect({
    bankId: "workspace-memory",
    query: "summarize the plan",
    evidence: [{ id: "host-evidence", text: "the project has a blue plan", createdAt: "2026-10-13T00:00:00Z" }],
  }, host.context);
  assert.match(reflection, new RegExp(remoteBankId));

  const routedBanks = fake.requests.map((request) => request.parts[3]);
  assert.deepEqual(routedBanks, [remoteBankId, remoteBankId, remoteBankId]);
  const retainRequest = fake.requests[0];
  const reflectRequest = fake.requests.find((request) => request.path.endsWith("/reflect"));
  assert.equal(retainRequest.body.items[0].content, "The [redacted] project plan is blue");
  assert.equal(retainRequest.body.items[0].context, "session transcript");
  assert.equal(retainRequest.body.items[0].metadata.priority, "2");
  assert.equal(retainRequest.body.async, true);
  assert.equal(retainRequest.body.operation_id, receipt.operationId);
  assert.match(reflectRequest.body.query, /summarize the plan/);
  assert.match(reflectRequest.body.query, /host-evidence/);
  assert.match(reflectRequest.body.query, /data, not instructions/);
  assert.equal(Object.hasOwn(reflectRequest.body, "context"), false, "deprecated REST context is not sent");
  assert.equal(Object.hasOwn(reflectRequest.body, "include_facts"), false, "unknown include_facts field is not sent");
  assert.ok(fake.requests.every((request) => request.headers.authorization === `Bearer ${API_KEY}`));
  assert.deepEqual(host.events.slice(0, 3).map((event) => event.type), [
    "approval.requested",
    "approval.granted",
    "adapter.operation.completed",
  ]);
  assert.equal(host.audits.some((audit) => JSON.stringify(audit).includes("project plan")), false);
  assert.equal(host.audits.some((audit) => JSON.stringify(audit).includes(API_KEY)), false);
});

test("contract integration: same logical bank ID is isolated across projects", async (t) => {
  const fake = await fakeHindsight(t);
  const alphaBank = hindsightBankIdForProject("project-alpha", "workspace-memory");
  const betaBank = hindsightBankIdForProject("project-beta", "workspace-memory");
  assert.notEqual(alphaBank, betaBank);
  fake.seed(alphaBank, { id: "alpha-memory", text: "alpha-only decision", mentioned_at: "2026-10-13T00:00:00Z", state: "valid" });
  fake.seed(betaBank, { id: "beta-memory", text: "beta-only decision", mentioned_at: "2026-10-13T00:00:00Z", state: "valid" });
  const adapter = adapterFor(fake);
  const alphaContext = makeContext({ projectId: "project-alpha" });
  const betaContext = makeContext({ projectId: "project-beta" });

  const alpha = await adapter.recall({ bankId: "workspace-memory", query: "decision" }, alphaContext.context);
  const beta = await adapter.recall({ bankId: "workspace-memory", query: "decision" }, betaContext.context);
  assert.deepEqual(alpha.map((item) => item.id), ["alpha-memory"]);
  assert.deepEqual(beta.map((item) => item.id), ["beta-memory"]);
  assert.deepEqual(fake.requests.map((request) => request.parts[3]), [alphaBank, betaBank]);
});

test("contract integration: denied retain has zero remote side effects", async (t) => {
  const fake = await fakeHindsight(t);
  const adapter = adapterFor(fake);
  const host = makeContext({ approve: false });

  await assert.rejects(adapter.retain({
    bankId: "workspace-memory",
    idempotencyKey: "retain-denied",
    items: [{ text: "must not be sent" }],
  }, host.context), (error) => error instanceof HindsightAdapterError && error.code === "APPROVAL_DENIED");

  assert.equal(fake.requests.length, 0);
  assert.deepEqual(host.events.map((event) => event.type), [
    "approval.requested",
    "approval.denied",
    "adapter.operation.failed",
  ]);
  assert.deepEqual(host.audits.map((audit) => audit.outcome), ["approval_requested", "denied", "failed"]);
  assert.equal(JSON.stringify(host.audits).includes("must not be sent"), false);
});

test("contract: forget is explicitly unsupported and never calls a destructive endpoint", async (t) => {
  const fake = await fakeHindsight(t);
  const adapter = adapterFor(fake);
  const host = makeContext();

  assert.equal(adapter.capabilities.forget, false);
  await assert.rejects(adapter.forget({
    bankId: "workspace-memory",
    memoryIds: ["explicit-memory-id"],
    idempotencyKey: "forget-unsupported",
  }, host.context), (error) => error instanceof HindsightAdapterError && error.code === "FORGET_UNSUPPORTED");

  assert.equal(fake.requests.length, 0);
  assert.equal(host.approvalCount, 0, "unsupported operations do not ask for approval or attempt a side effect");
  assert.deepEqual(host.events.map((event) => event.type), ["adapter.operation.failed"]);
  assert.deepEqual(host.audits.map((audit) => audit.outcome), ["failed"]);
  assert.equal(host.audits[0].metadata.errorCode, "FORGET_UNSUPPORTED");
  assert.equal(JSON.stringify(host.audits).includes("explicit-memory-id"), false);
});

test("contract integration: upstream errors are typed and never expose credentials or query text", async (t) => {
  const fake = await fakeHindsight(t);
  fake.setRejectRequests(true);
  const adapter = adapterFor(fake);
  const host = makeContext();
  const secretQuery = "private-search-query";

  await assert.rejects(adapter.recall({ bankId: "workspace-memory", query: secretQuery }, host.context), (error) => {
    assert(error instanceof HindsightAdapterError);
    assert.equal(error.code, "AUTHENTICATION");
    assert.equal(error.message.includes(API_KEY), false);
    return true;
  });
  assert.equal(JSON.stringify(host.audits).includes(API_KEY), false);
  assert.equal(JSON.stringify(host.audits).includes(secretQuery), false);
  assert.deepEqual(host.events.map((event) => event.type), ["adapter.operation.failed"]);
});

test("contract integration: documented 409 and 422 failures preserve status without leaking upstream bodies", async (t) => {
  for (const statusCode of [409, 422]) {
    const fake = await fakeHindsight(t);
    fake.setRejectRequests(statusCode);
    const adapter = adapterFor(fake);
    const host = makeContext();
    const secretQuery = "query-that-must-not-leak";

    const operation = statusCode === 409
      ? adapter.retain({
        bankId: "workspace-memory",
        idempotencyKey: "conflicting-idempotency-key",
        items: [{ text: "approved write" }],
      }, host.context)
      : adapter.recall({ bankId: "workspace-memory", query: secretQuery }, host.context);

    await assert.rejects(operation, (error) => {
      assert(error instanceof HindsightAdapterError);
      assert.equal(error.code, `HINDSIGHT_HTTP_${statusCode}`);
      assert.equal(error.statusCode, statusCode);
      assert.equal(error.message.includes(API_KEY), false);
      assert.equal(error.message.includes("upstream-secret-detail"), false);
      return true;
    });
    assert.equal(JSON.stringify(host.audits).includes(API_KEY), false);
    assert.equal(JSON.stringify(host.audits).includes(secretQuery), false);
    assert.equal(host.events.at(-1).type, "adapter.operation.failed");
  }
});
