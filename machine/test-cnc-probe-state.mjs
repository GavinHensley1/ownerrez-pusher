import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { applyProbeLock, assertLockedProbeZJog, calibrationFromSetup, machinePosition, positionContinuous, readProbeLock, removeProbeLock, validateProbeLock, writeProbeLock } from "./cnc-probe-state.mjs";

const setup = { probeThickness: 12.1, bedSurfaceMPos: -21.084, stockSurfaceMPos: -14.859, stockThicknessMm: 6.225, safetyFloorMm: 0.8, maxCutDepthMm: 5.425, zOriginMPos: -14.859, updatedAt: "2026-09-25T20:17:08.489Z", probeLockedAt: "2026-09-25T20:20:00.000Z" };
const status = { MPos: "-116.685,0.000,0.241,0.000" };

test("probe lock validates, persists privately, and restores on continuous coordinates", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "cnc-probe-lock-")), file = path.join(root, "state.json");
  try {
    const lock = calibrationFromSetup(setup, status, "2026-09-25T20:20:00.000Z");
    assert.equal(lock.lockedAt, setup.probeLockedAt);
    writeProbeLock(file, lock);
    assert.equal((statSync(file).mode & 0o777).toString(8), "600");
    assert.equal(JSON.parse(readFileSync(file, "utf8")).maxCutDepthMm, 5.425);
    const target = { xyReady: false };
    applyProbeLock(target, readProbeLock(file), status);
    assert.equal(target.probeLocked, true);
    assert.equal(target.stockThicknessMm, 6.225);
    removeProbeLock(file);
    assert.equal(readProbeLock(file), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("probe lock rejects power-cycle coordinate discontinuity and malformed depth", () => {
  const lock = calibrationFromSetup(setup, status);
  assert.equal(positionContinuous(lock.lastKnownMPos, machinePosition(status)), true);
  assert.throws(() => applyProbeLock({}, lock, { MPos: "0.000,0.000,0.000,0.000" }), /do not match this controller session/);
  assert.throws(() => validateProbeLock({ ...lock, maxCutDepthMm: 6 }), /maximum cut depth is invalid/);
});

test("probe lock restores after ordinary movement when G54 Z origin is unchanged", () => {
  const lock = calibrationFromSetup(setup, status);
  const target = {};
  applyProbeLock(target, lock, { MPos: "-154.410,108.923,-14.900,0.000" }, 0.05, { X: -207.685, Y: -25, Z: -14.859 });
  assert.equal(target.probeLocked, true);
  assert.equal(target.zOriginMPos, -14.859);
});

test("probe lock rejects a changed G54 Z origin", () => {
  const lock = calibrationFromSetup(setup, status);
  assert.throws(() => applyProbeLock({}, lock, { MPos: "-154.410,108.923,-14.900,0.000" }, 0.05, { X: -207.685, Y: -25, Z: -20 }), /Z origin does not match/);
});

test("locked probe rejects Z motion below the protected floor", () => {
  const locked = { ...setup, probeLocked: true };
  assert.deepEqual(assertLockedProbeZJog(locked, { MPos: "-116.685,0.000,-14.859,0.000" }, -5).target, -19.859);
  assert.throws(() => assertLockedProbeZJog(locked, { MPos: "-116.685,0.000,-14.859,0.000" }, -6), /exceeds locked probe range/);
});
