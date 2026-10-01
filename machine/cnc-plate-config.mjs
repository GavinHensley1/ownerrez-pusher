// Operator-configured Z-probe plate ("puck") thickness.
//
// WHY THIS IS ITS OWN FILE, SEPARATE FROM THE PROBE CALIBRATION RECORD:
// This number sets absolute Z zero one-for-one. The probe routine computes
//     stock surface = latched PRB contact Z - plate thickness
// so an error of N mm in the plate figure moves the software's idea of the
// surface N mm, and every program then cuts N mm deeper than commanded.
//
// It is also invisible downstream. Measured stock thickness is a DIFFERENCE of
// two touches (bed and stock), so the same plate error cancels out and the
// thickness still looks right. That is exactly why a 20 mm value against a
// ~14.19 mm plate cut a buckle about 6 mm too deep on 2026-09-30 while all ten
// readiness gates stayed green.
//
// Therefore the configured value must NEVER be read back out of the calibration
// record that is being validated against it: that is self-validation and always
// passes. The configured value lives here, written only when the operator sets
// it, and a stored calibration made with a different plate is rejected.
//
// Genmitsu/SainSmart ship this plate in 14, 14.19 and 20.17 mm variants and
// their own manual says "inconsistencies can happen in manufacturing, so you
// should measure your specific probe's thickness". So 14.19 is a DEFAULT to be
// confirmed by the operator, never a verified machine constant.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
// The thickness range, the default and the match tolerance are defined ONCE, in
// api/cnc-plate-contract.cjs, because the CommonJS Vercel API enforces the same
// contract and cannot import ESM. Re-exported here so every existing ESM
// importer of this module keeps working against the one set of numbers.
import plateContract from "../api/cnc-plate-contract.cjs";

export const {
  PLATE_THICKNESS_DEFAULT_MM,
  PLATE_THICKNESS_MIN_MM,
  PLATE_THICKNESS_MAX_MM,
  PLATE_THICKNESS_MATCH_TOLERANCE_MM,
  normalizePlateThickness,
  plateThicknessMatches,
} = plateContract;

export function validatePlateConfig(raw) {
  if (!raw || typeof raw !== "object" || raw.version !== 1) throw new Error("Plate configuration is not a supported record");
  const plateThicknessMm = normalizePlateThickness(raw.plateThicknessMm);
  if (plateThicknessMm === null) {
    throw new Error(`Plate thickness ${raw.plateThicknessMm} is outside the supported ${PLATE_THICKNESS_MIN_MM}-${PLATE_THICKNESS_MAX_MM} mm range`);
  }
  return {
    version: 1,
    plateThicknessMm,
    measuredBy: String(raw.measuredBy || "operator").slice(0, 60),
    updatedAt: String(raw.updatedAt || new Date().toISOString()),
    source: String(raw.source || "Operator-entered Z-probe plate thickness").slice(0, 160),
  };
}

export function readPlateConfig(path) {
  if (!existsSync(path)) return null;
  return validatePlateConfig(JSON.parse(readFileSync(path, "utf8")));
}

export function writePlateConfig(path, raw) {
  const config = validatePlateConfig({ ...raw, version: 1, updatedAt: raw?.updatedAt || new Date().toISOString() });
  const temp = `${path}.${process.pid}.tmp`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
  chmodSync(path, 0o600);
  return config;
}

// Fail SAFE, not silent: a missing or corrupt file falls back to the documented
// default and reports that the value is unconfirmed, so the caller can tell the
// operator to confirm it rather than silently probing against a guess.
export function configuredPlateThickness(path) {
  try {
    const config = readPlateConfig(path);
    if (config) return { plateThicknessMm: config.plateThicknessMm, confirmed: true, updatedAt: config.updatedAt, source: config.source };
  } catch { /* fall through to the default below */ }
  return {
    plateThicknessMm: PLATE_THICKNESS_DEFAULT_MM,
    confirmed: false,
    updatedAt: null,
    source: `Unconfirmed default ${PLATE_THICKNESS_DEFAULT_MM} mm; measure and save the plate you are actually using`,
  };
}
