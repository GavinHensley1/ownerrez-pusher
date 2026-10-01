// Single source of truth for the Z-probe plate ("puck") contract.
//
// WHY THIS FILE IS CommonJS AND LIVES UNDER api/:
// The plate thickness sets absolute Z zero one-for-one, and it is consumed on
// both sides of a module-system boundary — the CommonJS Vercel API (api/app.js,
// api/cnc-program-holds.cjs) and the ESM machine layer (machine/*.mjs). Before
// this file existed the same four numbers were written out as literals in both
// places: api/app.js declared `PROBE_PUCK_DEFAULT_MM=14.19, MIN 5, MAX 30` while
// machine/cnc-plate-config.mjs declared its own copies plus the 0.005 mm match
// tolerance. Two independent copies of the number that defines Z zero is the
// same class of defect as the hard-coded 20 mm that cut a buckle ~6 mm too deep
// on 2026-09-30: nothing fails when they drift, the cut just goes to the wrong
// depth. CommonJS is the direction that works without a loader shim, because ESM
// can require/import CJS but the Vercel API cannot import ESM.
//
// Genmitsu/SainSmart ship this plate in 14, 14.19 and 20.17 mm variants and
// their own manual says "inconsistencies can happen in manufacturing, so you
// should measure your specific probe's thickness". DEFAULT is therefore a value
// the operator must confirm, never a verified machine constant.
const PLATE_THICKNESS_DEFAULT_MM = 14.19;
const PLATE_THICKNESS_MIN_MM = 5;
const PLATE_THICKNESS_MAX_MM = 30;

// Operators type this to 2 decimals, so two genuinely different entries differ
// by at least 0.01 mm. 0.005 separates "the same value" from "a different value"
// without ever accepting a real difference. The 0.19 mm gap between the 14.00 and
// 14.19 variants matters on a pass that only skims 0.06 mm, so this must stay
// far tighter than the 0.05 mm windows used for coordinate continuity.
const PLATE_THICKNESS_MATCH_TOLERANCE_MM = 0.005;

function normalizePlateThickness(value) {
  const mm = Number(value);
  if (!Number.isFinite(mm) || mm < PLATE_THICKNESS_MIN_MM || mm > PLATE_THICKNESS_MAX_MM) return null;
  return mm;
}

// Fails CLOSED on a non-finite input: an absent or unparseable thickness is
// "these do not match", never "close enough".
function plateThicknessMatches(a, b, toleranceMm = PLATE_THICKNESS_MATCH_TOLERANCE_MM) {
  const left = Number(a), right = Number(b);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
  return Math.abs(left - right) <= toleranceMm;
}

module.exports = {
  PLATE_THICKNESS_DEFAULT_MM,
  PLATE_THICKNESS_MIN_MM,
  PLATE_THICKNESS_MAX_MM,
  PLATE_THICKNESS_MATCH_TOLERANCE_MM,
  normalizePlateThickness,
  plateThicknessMatches,
};
