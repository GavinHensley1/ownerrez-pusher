import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { claimCommand, completeCommand, readCommandLedger } from "./cnc-command-ledger.mjs";

test("persistent ledger claims a physical command before execution", () => {
  const path = join(mkdtempSync(join(tmpdir(), "cnc-ledger-")), "ledger.json");
  const first = claimCommand(path, { id: "cmd-1", action: "probe_tool" }, "2026-09-27T12:00:00.000Z");
  assert.equal(first.claimed, true);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const second = claimCommand(path, { id: "cmd-1", action: "probe_tool" });
  assert.equal(second.claimed, false);
  assert.equal(second.entry.status, "inflight");
  assert.equal(second.terminal, false);
});

test("terminal result is replayable after process restart instead of repeating motion", () => {
  const path = join(mkdtempSync(join(tmpdir(), "cnc-ledger-")), "ledger.json");
  claimCommand(path, { id: "cmd-2", action: "jog" });
  completeCommand(path, "cmd-2", "ready", "jog complete");
  const replay = claimCommand(path, { id: "cmd-2", action: "jog" });
  assert.equal(replay.claimed, false);
  assert.equal(replay.terminal, true);
  assert.equal(replay.entry.message, "jog complete");
  assert.equal(readCommandLedger(path).entries.length, 1);
});

test("inflight command stays uncertain after restart and cannot execute twice", () => {
  const path = join(mkdtempSync(join(tmpdir(), "cnc-ledger-")), "ledger.json");
  claimCommand(path, { id: "cmd-3", action: "start" });
  const replay = claimCommand(path, { id: "cmd-3", action: "start" });
  assert.equal(replay.entry.status, "inflight");
  completeCommand(path, "cmd-3", "uncertain", "Bridge restarted while command outcome was unknown");
  assert.equal(claimCommand(path, { id: "cmd-3", action: "start" }).entry.status, "uncertain");
});
