import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PLATE_THICKNESS_DEFAULT_MM,
  PLATE_THICKNESS_MAX_MM,
  PLATE_THICKNESS_MIN_MM,
  configuredPlateThickness,
  normalizePlateThickness,
  plateThicknessMatches,
  readPlateConfig,
  validatePlateConfig,
  writePlateConfig,
} from "./cnc-plate-config.mjs";

const scratch = () => mkdtempSync(join(tmpdir(), "cnc-plate-"));

test("plate thickness default is the documented 14.19 mm and is never a frozen contract", () => {
  assert.equal(PLATE_THICKNESS_DEFAULT_MM, 14.19);
  assert.equal(PLATE_THICKNESS_MIN_MM, 5);
  assert.equal(PLATE_THICKNESS_MAX_MM, 30);
});

test("plate thickness rejects blank, zero, non-numeric and out-of-range values", () => {
  for (const bad of [undefined, null, "", " ", "abc", NaN, 0, -1, 4.99, 30.01, 100, Infinity, -Infinity, {}, []]) {
    assert.equal(normalizePlateThickness(bad), null, `expected ${JSON.stringify(bad)} to be rejected`);
  }
  // Boundaries are inclusive and real values pass through unchanged.
  assert.equal(normalizePlateThickness(5), 5);
  assert.equal(normalizePlateThickness(30), 30);
  assert.equal(normalizePlateThickness("14.19"), 14.19);
  assert.equal(normalizePlateThickness(20), 20);
});

test("plate thickness comparison separates genuinely different operator entries", () => {
  assert.equal(plateThicknessMatches(14.19, 14.19), true);
  // 14.00 vs 14.19 must NOT be treated as the same plate: 0.19 mm is three times
  // the entire depth of the shallowest certified metal pass.
  assert.equal(plateThicknessMatches(14, 14.19), false);
  // The exact incident pair must never compare equal.
  assert.equal(plateThicknessMatches(20, 14.19), false);
  assert.equal(plateThicknessMatches(null, 14.19), false);
  assert.equal(plateThicknessMatches(14.19, undefined), false);
});

test("plate config round-trips and is stored private", () => {
  const dir = scratch(), path = join(dir, "plate.json");
  try {
    const written = writePlateConfig(path, { plateThicknessMm: 14.19, source: "unit test" });
    assert.equal(written.plateThicknessMm, 14.19);
    assert.equal(readPlateConfig(path).plateThicknessMm, 14.19);
    const resolved = configuredPlateThickness(path);
    assert.equal(resolved.plateThicknessMm, 14.19);
    assert.equal(resolved.confirmed, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("plate config refuses to persist an invalid thickness", () => {
  const dir = scratch(), path = join(dir, "plate.json");
  try {
    for (const bad of [0, "", null, 4, 31, "abc"]) {
      assert.throws(() => writePlateConfig(path, { plateThicknessMm: bad }), /outside the supported/);
    }
    assert.throws(() => validatePlateConfig({ version: 2, plateThicknessMm: 14.19 }), /not a supported record/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a missing or corrupt plate config falls back to the default but reports it UNCONFIRMED", () => {
  const dir = scratch(), path = join(dir, "plate.json");
  try {
    // Missing file.
    let resolved = configuredPlateThickness(path);
    assert.equal(resolved.plateThicknessMm, PLATE_THICKNESS_DEFAULT_MM);
    assert.equal(resolved.confirmed, false, "an absent file must not be reported as an operator-confirmed measurement");
    // Corrupt file must not throw and must not claim confirmation either.
    writeFileSync(path, "{ not json");
    resolved = configuredPlateThickness(path);
    assert.equal(resolved.plateThicknessMm, PLATE_THICKNESS_DEFAULT_MM);
    assert.equal(resolved.confirmed, false);
    // Out-of-range stored value is treated as unconfigured, not adopted.
    writeFileSync(path, JSON.stringify({ version: 1, plateThicknessMm: 20.17 * 100 }));
    resolved = configuredPlateThickness(path);
    assert.equal(resolved.plateThicknessMm, PLATE_THICKNESS_DEFAULT_MM);
    assert.equal(resolved.confirmed, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
