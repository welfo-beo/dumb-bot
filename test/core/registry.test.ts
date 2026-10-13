import assert from "node:assert/strict";
import { test } from "node:test";
import { ComponentRegistry } from "../../src/core/registry.ts";

test("registry stores adapter capabilities and extension paths", () => {
  const registry = new ComponentRegistry();
  const provider = { id: "provider.fake", capabilities: { read: true, write: false, streaming: true } };
  registry.registerAdapter("provider", provider);
  registry.registerExtension({ id: "extension.fake", path: "/tmp/fake-extension.ts", capabilities: ["session.state"] });
  assert.equal(registry.requireAdapter<typeof provider>(provider.id).capabilities.streaming, true);
  assert.deepEqual(registry.getExtensionPaths(), ["/tmp/fake-extension.ts"]);
});

test("registry rejects duplicate IDs and malformed capabilities", () => {
  const registry = new ComponentRegistry();
  registry.registerExtension({ id: "same-id", path: "/tmp/a.ts", capabilities: [] });
  assert.throws(() => registry.registerAdapter("tool", { id: "same-id", capabilities: { read: true } }), /already registered/);
  assert.throws(() => registry.registerAdapter("tool", { id: "bad", capabilities: { write: "yes" } }), /must be a boolean/);
});
