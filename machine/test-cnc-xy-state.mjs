import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { applyXyLock, planXyPowerCycleRecovery, readXyLock, removeXyLock, writeXyLock, xyLockFromSetup } from "./cnc-xy-state.mjs";

const setup = { xyReady: true, xyOriginMPos: { X: -207.685, Y: -25, Z: -22.759 }, xyLockedAt: "2026-09-25T20:41:23.226Z" };
const status = { MPos: "-207.685,-25.000,-22.759,0.000" };

test("X/Y lock persists privately and survives Z-only changes", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "cnc-xy-lock-")), file = path.join(root, "state.json");
  try {
    const lock = xyLockFromSetup(setup, status);
    writeXyLock(file, lock);
    assert.equal((statSync(file).mode & 0o777).toString(8), "600");
    const target = { xyReady: false };
    applyXyLock(target, readXyLock(file), { MPos: "-207.685,-25.000,-10.000,0.000" });
    assert.equal(target.xyReady, true);
    assert.deepEqual({ X: target.xyOriginMPos.X, Y: target.xyOriginMPos.Y }, { X: -207.685, Y: -25 });
    removeXyLock(file);
    assert.equal(readXyLock(file), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("X/Y lock restores after ordinary machine movement when G54 origin is unchanged", () => {
  const lock = xyLockFromSetup(setup, status);
  const target = { xyReady: false };
  applyXyLock(target, lock, { MPos: "-154.410,108.923,-41.698,0.000" }, 0.05, { X: -207.685, Y: -25, Z: -41.6 });
  assert.equal(target.xyReady, true);
  assert.deepEqual({ X: target.xyOriginMPos.X, Y: target.xyOriginMPos.Y }, { X: -207.685, Y: -25 });
});

test("X/Y lock rejects a changed G54 origin even if the cutter is elsewhere", () => {
  const lock = xyLockFromSetup(setup, status);
  assert.throws(() => applyXyLock({}, lock, { MPos: "-154.410,108.923,-41.698,0.000" }, 0.05, { X: -200, Y: -25, Z: -41.6 }), /origin does not match/);
});

test("X/Y lock rejects a coordinate reset", () => {
  const lock = xyLockFromSetup(setup, status);
  assert.throws(() => applyXyLock({}, lock, { MPos: "0.000,0.000,-22.759,0.000" }), /coordinates reset to zero/);
  const originZeroLock = { version: 1, locked: true, xyOriginMPos: { X: 0, Y: 0 }, lastKnownMPos: { X: 243.4, Y: 5.029 }, lockedAt: "2026-09-26T19:32:20.244Z" };
  assert.throws(() => applyXyLock({}, originZeroLock, { MPos: "0.000,0.000,10.000,0.000" }, 0.05, { X: 0, Y: 0, Z: -13.531 }), /coordinates reset to zero/);
});

test("power-cycle recovery rebases the saved work position without motion", () => {
  const lock = { version: 1, locked: true, xyOriginMPos: { X: 0, Y: 0 }, lastKnownMPos: { X: 243.4, Y: 5.029 }, lockedAt: "2026-09-26T19:32:20.244Z", source: "Project guarded front-left X/Y origin" };
  const plan = planXyPowerCycleRecovery(lock, { MPos: "0.000,0.000,0.000,0.000" }, { X: 0, Y: 0, Z: -13.531 });
  assert.deepEqual(plan.savedWorkPosition, { X: 243.4, Y: 5.029 });
  assert.deepEqual(plan.rebasedOriginMPos, { X: -243.4, Y: -5.029 });
  assert.throws(() => planXyPowerCycleRecovery(lock, { MPos: "1.000,0.000,0.000,0.000" }, { X: 0, Y: 0, Z: -13.531 }), /before any post-reset X\/Y movement/);
});

test("repeated power cycles accept the saved persistent G54 origin and rebase the latest work position", () => {
  const lock = { version: 1, locked: true, xyOriginMPos: { X: -243.4, Y: -5.029 }, lastKnownMPos: { X: -118.25, Y: 20.5 }, lockedAt: "2026-09-27T17:06:40.396Z", source: "Project guarded front-left X/Y origin" };
  const plan = planXyPowerCycleRecovery(lock, { MPos: "0.000,0.000,10.000,0.000" }, { X: -243.4, Y: -5.029, Z: -13.531 });
  assert.deepEqual(plan.savedWorkPosition, { X: 125.15, Y: 25.529 });
  assert.deepEqual(plan.rebasedOriginMPos, { X: -125.15, Y: -25.529 });
  assert.throws(() => planXyPowerCycleRecovery(lock, { MPos: "0.000,0.000,10.000,0.000" }, { X: -200, Y: -5.029, Z: -13.531 }), /do not match the saved project or reset state/);
});

test("five consecutive power cycles preserve the same durable project X/Y frame", () => {
  const expectedWork = { X: 125.15, Y: 25.529 };
  let lock = { version: 1, locked: true, xyOriginMPos: { X: -243.4, Y: -5.029 }, lastKnownMPos: { X: -118.25, Y: 20.5 }, lockedAt: "2026-09-27T17:06:40.396Z", source: "Project guarded front-left X/Y origin" };
  for (let cycle = 0; cycle < 5; cycle += 1) {
    const plan = planXyPowerCycleRecovery(lock, { MPos: `0.000,0.000,${10 + cycle}.000,0.000` }, { X: lock.xyOriginMPos.X, Y: lock.xyOriginMPos.Y, Z: -13.531 });
    assert.deepEqual(plan.savedWorkPosition, expectedWork);
    assert.deepEqual(plan.rebasedOriginMPos, { X: -expectedWork.X, Y: -expectedWork.Y });
    lock = { ...lock, xyOriginMPos: plan.rebasedOriginMPos, lastKnownMPos: { X: 0, Y: 0 } };
  }
});
