import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { contextMessages, latestMarkerIsActive } from "../../../src/extensions/adhd/context-compat.ts";

const ACTIVE = "i-have-adhd-rules";
const DISABLED = "i-have-adhd-disabled";

test("context marker uses the newest custom marker", () => {
  assert.equal(latestMarkerIsActive([
    { type: "custom_message", customType: ACTIVE },
    { type: "custom_message", customType: DISABLED },
    { type: "custom_message", customType: ACTIVE },
  ], ACTIVE, DISABLED), true);
  assert.equal(latestMarkerIsActive([
    { role: "custom", customType: ACTIVE },
    { role: "custom", customType: DISABLED },
  ], ACTIVE, DISABLED), false);
});

test("ordinary messages cannot activate or disable the marker", () => {
  assert.equal(latestMarkerIsActive([
    { role: "user", customType: ACTIVE },
    { type: "message", customType: DISABLED },
  ], ACTIVE, DISABLED), false);
});

test("context compatibility prefers Pi session context and fails open", () => {
  const messages = [{ role: "custom", customType: ACTIVE }];
  assert.equal(contextMessages({ buildSessionContext: () => ({ messages }) }), messages);
  assert.deepEqual(contextMessages({ buildSessionContext: () => { throw new Error("compaction race"); } }), []);
  assert.deepEqual(contextMessages({ buildContextEntries: () => [{ type: "custom_message", customType: ACTIVE }] }), [{ type: "custom_message", customType: ACTIVE }]);
});

test("extension exposes only Pi command/flag/events and reinjects after compaction", () => {
  const source = readFileSync(join(process.cwd(), "src/extensions/adhd/extension.ts"), "utf8");
  for (const token of ["registerFlag(\"adhd\"", "registerCommand(\"i-have-adhd\"", "pi.on(\"session_compact\"", "pi.on(\"session_start\"", "pi.on(\"session_tree\"", "pi.sendMessage", "triggerTurn: false", "appendEntry(STATE_ENTRY_TYPE"]) {
    assert.ok(source.includes(token), `missing ${token}`);
  }
  assert.ok(!source.includes("createAgent") && !source.includes("agentLoop"), "extension must not create a second agent loop");
});
