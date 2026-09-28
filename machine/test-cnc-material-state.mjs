import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyMaterialProfile, materialProfileFromSetup, readMaterialProfile, removeMaterialProfile, validateMaterialProfile, writeMaterialProfile } from "./cnc-material-state.mjs";

const valid = { version: 1, stockThicknessMm: 13.367, safetyFloorMm: 0.8, maxCutDepthMm: 12.567, capturedAt: "2026-09-27T12:00:00.000Z" };

test("material profile validates the measured no-cut-through relationship", () => {
  assert.deepEqual(validateMaterialProfile(valid), { ...valid, source: "Project measured bed and stock" });
  assert.throws(() => validateMaterialProfile({ ...valid, maxCutDepthMm: 12 }), /inconsistent/);
});

test("material profile survives probe-lock invalidation for later tool touch-off", () => {
  const dir = mkdtempSync(join(tmpdir(), "cnc-material-")), path = join(dir, "material.json");
  writeMaterialProfile(path, valid);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(readMaterialProfile(path).stockThicknessMm, 13.367);
  assert.match(readFileSync(path, "utf8"), /12\.567/);
  removeMaterialProfile(path);
  assert.equal(readMaterialProfile(path), null);
});

test("material profile can be applied without claiming current Z is calibrated", () => {
  const setup = { probeLocked: false };
  applyMaterialProfile(setup, materialProfileFromSetup({ ...valid, updatedAt: valid.capturedAt }));
  assert.equal(setup.materialReady, true);
  assert.equal(setup.savedStockThicknessMm, 13.367);
  assert.equal(setup.probeLocked, false);
});
