import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { applyXyLock, readXyLock, removeXyLock, writeXyLock, xyLockFromSetup } from "./cnc-xy-state.mjs";

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
  assert.throws(() => applyXyLock({}, lock, { MPos: "0.000,0.000,-22.759,0.000" }), /origin does not match this controller session/);
});
