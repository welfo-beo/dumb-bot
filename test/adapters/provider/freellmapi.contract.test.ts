import { strict as assert } from "node:assert";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { test, afterEach } from "node:test";
import { FreeLLMAPIError, FreeLLMAPIProvider } from "../../../src/adapters/provider/freellmapi/index.ts";

const secret = `contract-${randomUUID()}`;
const servers: Server[] = [];

async function fakeServer(handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => { await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))); });

function provider(baseUrl: string, timeoutMs = 300) { return new FreeLLMAPIProvider({ baseUrl, apiKey: secret, defaultModel: "free-model", timeoutMs }); }

test("contract: GET /v1/models sends bearer auth and returns model list", async () => {
  const base = await fakeServer((req, res) => {
    assert.equal(req.url, "/v1/models");
    assert.equal(req.headers.authorization, `Bearer ${secret}`);
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ object: "list", data: [{ id: "free-model", object: "model" }] }));
  });
  const result = await provider(base).listModels();
  assert.equal(result.data[0].id, "free-model");
});

test("contract: streaming SSE aggregates text and fragmented tool calls", async () => {
  const base = await fakeServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"id":"c1","model":"free-model","choices":[{"delta":{"content":"Hello "}}]}\n\n');
    res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"get_"}}]}}]}\n\n');
    res.write('data: {"choices":[{"delta":{"content":"world","tool_calls":[{"index":0,"function":{"name":"weather","arguments":"{\\"city\\":\\"Paris\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n');
    res.end("data: [DONE]\n\n");
  });
  const result = await provider(base).complete({ messages: [{ role: "user", content: "hi" }], tools: [{ type: "function", function: { name: "get_weather", parameters: {} } }], stream: true });
  assert.ok("content" in result);
  assert.equal(result.content, "Hello world");
  assert.equal(result.toolCalls[0].function?.name, "get_weather");
  assert.equal(result.toolCalls[0].function?.arguments, '{"city":"Paris"}');
  assert.equal(result.finishReason, "tool_calls");
});

test("contract: authentication and rate-limit errors are typed and redact credentials", async () => {
  for (const status of [401, 403, 429]) {
    const base = await fakeServer((_req, res) => { res.writeHead(status, status === 429 ? { "retry-after": "2" } : {}); res.end(`Bearer ${secret}`); });
    try { await provider(base).listModels(); assert.fail("expected error"); } catch (error) {
      assert(error instanceof FreeLLMAPIError);
      assert.equal(error.code, status === 429 ? "rate_limited" : "authentication");
      assert(!error.message.includes(secret)); assert(!JSON.stringify(error).includes(secret));
      if (status === 429) assert.equal(error.retryAfterMs, 2000);
    }
  }
});

test("contract: timeout aborts a hanging provider request", async () => {
  const base = await fakeServer(() => { /* intentionally never responds */ });
  try { await provider(base, 30).listModels(); assert.fail("expected timeout"); } catch (error) { assert(error instanceof FreeLLMAPIError); assert.equal(error.code, "timeout"); }
});

test("contract: non-stream JSON completion preserves tool calls", async () => {
  const base = await fakeServer((_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ id: "c2", choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [{ id: "call_2", type: "function", function: { name: "lookup", arguments: "{}" } }] } }] })); });
  const result = await provider(base).complete({ messages: [{ role: "user", content: "lookup" }] });
  assert.ok("choices" in result);
  assert.equal(result.choices[0].message?.tool_calls?.[0].function?.name, "lookup");
});

test("config: rejects invalid values without echoing credentials", () => {
  const assertSafeConfigError = (config: ConstructorParameters<typeof FreeLLMAPIProvider>[0]) => {
    assert.throws(() => new FreeLLMAPIProvider(config), (error: unknown) => {
      assert(error instanceof Error);
      assert(!error.message.includes(secret));
      assert(!JSON.stringify(error).includes(secret));
      return true;
    });
  };

  assertSafeConfigError({ baseUrl: `https://user:${secret}@models.example.test/v1`, apiKey: secret });
  assertSafeConfigError({ baseUrl: "not-a-url", apiKey: secret });
  assertSafeConfigError({ baseUrl: "https://models.example.test", apiKey: "   " });
  assertSafeConfigError({ baseUrl: "https://models.example.test", apiKey: secret, timeoutMs: 0 });
  assertSafeConfigError({ baseUrl: "https://models.example.test", apiKey: secret, defaultModel: " " });
});

test("mock health check: normalizes /v1 and redacts authentication failures", async () => {
  let requestedUrl = "";
  const audits: unknown[] = [];
  const events: unknown[] = [];
  const modelProvider = new FreeLLMAPIProvider({
    baseUrl: "https://models.example.test/v1/",
    apiKey: secret,
    fetch: async (input, init) => {
      requestedUrl = String(input);
      assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${secret}`);
      return new Response(`upstream says Bearer ${secret}`, { status: 401 });
    },
  });

  try {
    await modelProvider.listModels({ sessionId: "s1", runId: "r1", audit: (record) => { audits.push(record); }, emit: (event) => { events.push(event); } });
    assert.fail("expected mock authentication failure");
  } catch (error) {
    assert(error instanceof FreeLLMAPIError);
    assert.equal(error.code, "authentication");
    assert(!error.message.includes(secret));
    assert(!JSON.stringify(error).includes(secret));
  }
  assert.equal(requestedUrl, "https://models.example.test/v1/models");
  assert(!JSON.stringify(audits).includes(secret));
  assert(!JSON.stringify(events).includes(secret));
});
