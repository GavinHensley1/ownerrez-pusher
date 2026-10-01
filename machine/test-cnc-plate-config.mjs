import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
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
    const written = writePlateConfig(path, { plateThicknessMm: 14.19, source: "unit test", confirmedByOperator: true, measuredBy: "operator" });
    assert.equal(written.plateThicknessMm, 14.19);
    assert.equal(readPlateConfig(path).plateThicknessMm, 14.19);
    const resolved = configuredPlateThickness(path);
    assert.equal(resolved.plateThicknessMm, 14.19);
    assert.equal(resolved.confirmed, true);
    assert.equal(resolved.measuredBy, "operator");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a stored thickness nobody confirmed is USED but never reported as confirmed", () => {
  // THE 2026-10-01 STATE: ~/.openclaw/state/cnc-plate-config.json held 12.1 mm --
  // the retired third silent default -- with measuredBy "operator" and source
  // "Supplied with a Project probe command". Nobody measured 12.1. It was
  // attributed to the operator purely because that was the field's default, and
  // `confirmed` was true merely because the file existed. Since `confirmed` is
  // what releases a cut, that is the same defect as freezing the unverified
  // 20 mm figure as a verified constant.
  const dir = scratch(), path = join(dir, "plate.json");
  try {
    const written = writePlateConfig(path, { plateThicknessMm: 12.1, source: "Supplied with a Project probe command" });
    assert.equal(written.confirmedByOperator, false);
    // Not silently attributed to a human who never touched it.
    assert.equal(written.measuredBy, "unattributed");
    const resolved = configuredPlateThickness(path);
    // Still the value in force: refusing to read it would only fall back to a
    // default, which is no safer.
    assert.equal(resolved.plateThicknessMm, 12.1);
    // But it cannot release a cut, and it says why.
    assert.equal(resolved.confirmed, false);
    assert.match(resolved.source, /never confirmed by an operator/i);
    assert.match(resolved.source, /12\.10 mm is stored/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("only the explicit set-plate path may confirm, never the probe side path", () => {
  const daemon = readFileSync(new URL("./cnc-daemon.mjs", import.meta.url), "utf8");
  const setPlate = daemon.slice(daemon.indexOf("const setPlateThickness"), daemon.indexOf("const verifySurfaceContact"));
  assert.match(setPlate, /confirmedByOperator: true, measuredBy: "operator"/);
  // The thickness carried along with a probe request is stored and used but
  // confers no confirmation, so it must not pass the confirming options at all.
  const probeCall = daemon.slice(daemon.indexOf('setConfiguredPlateMm(puckMm, "Supplied with a Project probe command")'), daemon.indexOf('setConfiguredPlateMm(puckMm, "Supplied with a Project probe command")') + 120);
  assert.match(probeCall, /setConfiguredPlateMm\(puckMm, "Supplied with a Project probe command"\);/);
  const confirmingWrites = daemon.match(/setConfiguredPlateMm\([^;]*confirmedByOperator: true/g) || [];
  assert.equal(confirmingWrites.length, 1, `exactly one call site may confirm a plate, found ${confirmingWrites.length}`);
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
