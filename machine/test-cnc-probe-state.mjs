import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { applyProbeLock, calibrationFromSetup, machinePosition, positionContinuous, readProbeLock, removeProbeLock, validateProbeLock, writeProbeLock } from "./cnc-probe-state.mjs";

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
