// A latched `moving` flag must not be able to make recovery unreachable.
//
// THE DEAD END THIS LOCKS DOWN: on 2026-10-01 the live daemon's /health reported
// moving:true and reconnecting:true while job.state was "idle" and the last
// controller status was <Idle|MPos:0.000,0.000,0.000|FS:0,0> -- nothing was
// moving anywhere. That flag is not cosmetic: hazardousOperationActive() consults
// it, so it suppressed auto-reconnect, and index.html disabled the one "Retry
// connection" control on health.moving. The result was a latched frame incident
// with no jog, no probe, no Start and no way back except restarting the bridge.
//
// These are source-level checks on purpose. Driving a real daemon into a hung
// controller await is exactly the condition that cannot be reproduced reliably,
// which is why the defect survived; the invariants below are what make it
// recoverable regardless of how the flag got stuck.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const daemon = readFileSync(new URL("./cnc-daemon.mjs", import.meta.url), "utf8");
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

test("the motion flag is only ever set through the watchdog-aware setter", () => {
  // A raw `moving = true` anywhere would bypass movingSince and become
  // permanently unclearable, which is the original bug.
  const raw = daemon.split("\n").filter((line) => /\bmoving = (true|false)\b/.test(line) && !/^let controller,/.test(line));
  assert.deepEqual(raw, [], `raw motion assignments must go through setMoving: ${raw.join(" | ")}`);
  assert.match(daemon, /const setMoving = \(active, reason = ""\) => \{/);
  assert.match(daemon, /movingSince = moving \? Date\.now\(\) : 0;/);
});

test("every operation that sets the flag also names itself, for the journal", () => {
  for (const match of daemon.matchAll(/setMoving\(true([^)]*)\)/g)) {
    assert.match(match[1], /^, "[^"]+"$/, `setMoving(true${match[1]}) must carry an operation reason`);
  }
});

test("a stale flag is cleared ONLY when the machine is provably not moving", () => {
  const body = daemon.slice(daemon.indexOf("const staleMotionReason"), daemon.indexOf("const clearStaleMotionFlag"));
  // Never clear while a job is running or paused: a real program may run 20 h, so
  // elapsed time alone must never be sufficient.
  assert.match(body, /\["running", "paused"\]\.includes\(job\.state\)\) return "";/);
  // Require the controller to have last reported a genuinely stopped machine.
  assert.match(body, /status\.state !== "Idle"/);
  assert.match(body, /String\(status\.FS \|\| ""\) !== "0,0"/);
  assert.match(body, /status\.Pn/);
  // And require a grace period far longer than any single command timeout.
  assert.match(daemon, /const STALE_MOTION_GRACE_MS = 120_000;/);
  assert.match(body, /Date\.now\(\) - movingSince < STALE_MOTION_GRACE_MS\) return "";/);
});

test("clearing a stale flag is journalled, never silent", () => {
  const body = daemon.slice(daemon.indexOf("const clearStaleMotionFlag"), daemon.indexOf("const clearStaleMotionFlag") + 500);
  assert.match(body, /recordEvent\("controller\.stale_motion_flag_cleared"/);
});

test("health() releases a stale flag BEFORE deciding whether to auto-reconnect", () => {
  // hazardousOperationActive() consults `moving`, so checking reconnection first
  // would leave the flag suppressing recovery for as long as it stayed latched.
  const body = daemon.slice(daemon.indexOf("const health = () => {"), daemon.indexOf("const observe = async"));
  const cleared = body.indexOf("clearStaleMotionFlag()");
  const reconnect = body.indexOf("void recoverIdleConnection()");
  assert.ok(cleared > -1, "health must run the motion-flag watchdog");
  assert.ok(reconnect > -1 && cleared < reconnect, "the watchdog must run before the auto-reconnect test");
});

test("the Retry connection control is not deadened by a motion flag while offline", () => {
  const region = html.slice(html.indexOf("button.textContent='Retry connection'"), html.indexOf("cncMachineAction('reconnect_verify'"));
  // When disconnected, `moving` cannot describe real motion.
  assert.match(region, /health\.connected!==false/);
  // A genuinely running or paused job must still block it.
  assert.match(region, /\['running','paused'\]\.indexOf\(String\(\(health\.job\|\|\{\}\)\.state\|\|''\)\)!==-1/);
  assert.match(region, /button\.disabled=CNC_COMMAND_IN_FLIGHT\|\|!CNC\.agent\|\|runningJob\|\|\(!!health\.moving&&health\.connected!==false\)/);
});
