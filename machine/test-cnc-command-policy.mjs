import assert from "node:assert/strict";
import test from "node:test";
import { commandRejectionReason } from "./cnc-command-policy.mjs";

const now = Date.parse("2026-09-28T23:30:00.000Z");
const started = now - 10_000;

test("accepts one fresh command created after bridge startup", () => {
  assert.equal(commandRejectionReason({ action: "jog", createdAt: "2026-09-28T23:29:55.000Z" }, { nowMs: now, agentStartedAtMs: started }), "");
});

test("rejects a command queued before this bridge process", () => {
  assert.match(commandRejectionReason({ action: "jog", createdAt: "2026-09-28T23:29:30.000Z" }, { nowMs: now, agentStartedAtMs: started }), /before this bridge process started/);
});

test("rejects stale, malformed, and future-dated commands", () => {
  assert.match(commandRejectionReason({ action: "jog", createdAt: "2026-09-28T23:29:00.000Z" }, { nowMs: now, agentStartedAtMs: now - 120_000 }), /older than 30 seconds/);
  assert.match(commandRejectionReason({ action: "jog" }, { nowMs: now, agentStartedAtMs: started }), /missing or invalid/);
  assert.match(commandRejectionReason({ action: "jog", createdAt: "2026-09-28T23:30:06.000Z" }, { nowMs: now, agentStartedAtMs: started }), /in the future/);
});

test("allows only run controls while a carve is active", () => {
  const fresh = "2026-09-28T23:29:55.000Z";
  assert.match(commandRejectionReason({ action: "jog", createdAt: fresh }, { nowMs: now, agentStartedAtMs: started, activeProgram: true }), /only Pause, Resume, or Stop/);
  for (const action of ["pause", "resume", "stop"]) {
    assert.equal(commandRejectionReason({ action, createdAt: fresh }, { nowMs: now, agentStartedAtMs: started, activeProgram: true }), "");
  }
});

