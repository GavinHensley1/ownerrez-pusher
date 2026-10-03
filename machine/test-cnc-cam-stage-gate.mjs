// Behavioural tests for the stage-chain and blank-thickness gates.
//
// These call the real functions the API and the Mac bridge both call, with the
// real certified-library accessor, so a change that would let a Profile posted
// for a different sheet reach the machine fails here and not on the metal.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const certifiedCam = require("../api/cnc-certified-library.cjs");
const gate = require("../api/cnc-cam-stage-gate.cjs");

const V2 = "rambo-buckle-c752-v2";
const V1 = "rambo-buckle-c752-v1";

// A job as api/app.js holds it immediately after the v2 library is installed.
const v2Job = (over = {}) => ({
  material: "C752 nickel silver",
  metalMode: "raised-surface",
  certifiedLibraryId: V2,
  profileDepthMm: "3.955",
  certifiedStockThicknessMm: "3.855",
  certifiedStockMeasuredOnThisBlank: "false",
  certifiedStockMeasuredOn: "the previous damaged C752 sheet (probed 2026-09-30)",
  certifiedThicknessSensitiveStages: JSON.stringify(["profile", "release"]),
  profileMode: "sacrificial-through",
  sacrificialBackingConfirmed: "true",
  allowSacrificialCutThrough: true,
  ...over,
});

const probed = (mm) => (mm === null ? {} : { stockThicknessMm: mm });

test("the required stage chain is the installed library's own order", () => {
  assert.deepEqual(gate.metalCertifiedOrder(v2Job(), certifiedCam), ["rough", "finish", "profile", "release"]);
  assert.deepEqual(gate.metalCertifiedOrder({ certifiedLibraryId: V1 }, certifiedCam), ["rough", "cleanup", "finish", "profile", "release"]);
});

test("a job with no resolvable library keeps the fixed five-stage chain", () => {
  // Hand-imported Kiri:Moto files have no library to vouch for a shorter chain.
  assert.deepEqual(gate.metalCertifiedOrder({}, certifiedCam), gate.METAL_FALLBACK_ORDER);
  assert.deepEqual(gate.metalCertifiedOrder({ certifiedLibraryId: "rambo-buckle-c752-v9" }, certifiedCam), gate.METAL_FALLBACK_ORDER);
  // Including when the accessor itself is missing.
  assert.deepEqual(gate.metalCertifiedOrder({ certifiedLibraryId: V2 }, null), gate.METAL_FALLBACK_ORDER);
});

test("v2's four-stage chain means cleanup is not demanded for a stage it omits", () => {
  const imported = ["rough", "finish", "profile", "release"];
  const missing = gate.metalCertifiedOrder(v2Job(), certifiedCam).filter((s) => !imported.includes(s));
  assert.deepEqual(missing, []);
  // The same imported set against the fixed five would be blocked on cleanup,
  // which is the dead end this gate exists to avoid.
  assert.deepEqual(gate.METAL_FALLBACK_ORDER.filter((s) => !imported.includes(s)), ["cleanup"]);
});

test("relief-only stages are never thickness-gated", () => {
  for (const stage of ["rough", "finish"]) {
    assert.equal(gate.certifiedThicknessHold(v2Job(), stage, probed(3.1), certifiedCam), "", stage + " at a wildly different thickness");
    assert.equal(gate.certifiedThicknessHold(v2Job(), stage, probed(null), certifiedCam), "", stage + " with nothing probed");
  }
  assert.deepEqual(gate.metalThicknessSensitiveStages(v2Job(), certifiedCam), ["profile", "release"]);
});

test("a through-cut stage is released only when the probed blank agrees", () => {
  // Exactly the thickness the programs were posted for: 0.100 mm into backing.
  assert.equal(gate.certifiedThicknessHold(v2Job(), "profile", probed(3.855), certifiedCam), "");
  assert.equal(gate.certifiedThicknessHold(v2Job(), "release", probed(3.855), certifiedCam), "");
  // Both ends of the permitted sacrificial band.
  assert.equal(gate.certifiedThicknessHold(v2Job(), "profile", probed(3.955), certifiedCam), "", "0.000 mm allowance");
  assert.equal(gate.certifiedThicknessHold(v2Job(), "profile", probed(3.755), certifiedCam), "", "0.200 mm allowance");
});

test("a through-cut stage is blocked when the new blank is thinner than assumed", () => {
  // 0.255 mm of backing — past the certified allowance.
  const reason = gate.certifiedThicknessHold(v2Job(), "profile", probed(3.7), certifiedCam);
  assert.match(reason, /cuts to 3\.955 mm but this blank probed 3\.700 mm/);
  assert.match(reason, /thinner than the programs assume/);
  assert.match(reason, /sacrificial backing/);
  assert.match(reason, /posted for 3\.855 mm, measured on the previous damaged C752 sheet/);
  assert.match(reason, /cam\/generate-buckle\.mjs/);
  assert.match(reason, /Rough and Finish are relief-only and are unaffected/);
});

test("a through-cut stage is blocked when the new blank is thicker than the through-depth", () => {
  // The part would stay attached to the sheet.
  const reason = gate.certifiedThicknessHold(v2Job(), "release", probed(4.1), certifiedCam);
  assert.match(reason, /this blank probed 4\.100 mm/);
  assert.match(reason, /thicker than the programmed through-depth, so the part would not come free/);
});

test("the thickness gate fails closed on missing evidence", () => {
  // No probe at all. Must refuse, not skip.
  const unprobed = gate.certifiedThicknessHold(v2Job(), "profile", probed(null), certifiedCam);
  assert.match(unprobed, /Probe this blank before the profile stage/);
  assert.match(unprobed, /3\.955 mm through-depth/);
  assert.equal(gate.certifiedThicknessHold(v2Job(), "profile", null, certifiedCam), unprobed);
  for (const bad of [0, -1, "", "not a number"]) {
    assert.match(gate.certifiedThicknessHold(v2Job(), "profile", { stockThicknessMm: bad }, certifiedCam), /Probe this blank/, String(bad));
  }
  // No certified through-depth either.
  assert.match(gate.certifiedThicknessHold(v2Job({ profileDepthMm: "" }), "profile", probed(3.855), certifiedCam), /no certified through-depth/);
});

test("the gate survives the library id becoming unresolvable", () => {
  // The job still carries what the library declared at install time, so renaming
  // or retiring a library cannot quietly un-gate an installed through-cut.
  const orphan = v2Job({ certifiedLibraryId: "rambo-buckle-c752-gone" });
  assert.deepEqual(gate.metalThicknessSensitiveStages(orphan, certifiedCam), ["profile", "release"]);
  assert.match(gate.certifiedThicknessHold(orphan, "profile", probed(3.2), certifiedCam), /does not|thinner|thicker/);
});

test("a hand-imported profile that stops at the protected floor is not through-gated", () => {
  // No library, no declared list, and not a sacrificial through-cut: this stage
  // never reaches the backing, so the through-depth comparison does not apply.
  const floorJob = { material: "C752 nickel silver", profileDepthMm: "3.000", allowSacrificialCutThrough: false };
  assert.deepEqual(gate.metalThicknessSensitiveStages(floorJob, certifiedCam), []);
  assert.equal(gate.certifiedThicknessHold(floorJob, "profile", probed(null), certifiedCam), "");
  // Declared as a through-cut, the same job is gated.
  const throughJob = { ...floorJob, allowSacrificialCutThrough: true };
  assert.deepEqual(gate.metalThicknessSensitiveStages(throughJob, certifiedCam), ["profile", "release"]);
  assert.match(gate.certifiedThicknessHold(throughJob, "profile", probed(null), certifiedCam), /Probe this blank/);
});

test("the certificate's own provenance flag is readable without a probe", () => {
  assert.equal(gate.certifiedThicknessIsUnverifiedForThisBlank(v2Job()), true);
  assert.equal(gate.certifiedThicknessIsUnverifiedForThisBlank(v2Job({ certifiedStockMeasuredOnThisBlank: "true" })), false);
  assert.equal(gate.certifiedThicknessIsUnverifiedForThisBlank({}), false);
});

test("the gate's allowance band matches the bridge's depth ceiling", async () => {
  // approvedProgramDepth is the independent re-derivation in the Mac bridge. If
  // the two bands ever differ, one layer releases a cut the other refuses.
  const { approvedProgramDepth } = await import("./cnc-program.mjs");
  const setup = { maxCutDepthMm: 3.055, stockThicknessMm: 3.855 };
  const context = { operation: "profile", allowSacrificialCutThrough: true, sacrificialBackingConfirmed: true };
  assert.equal(approvedProgramDepth(setup, { ...context, profileDepthMm: 3.855 }), 3.855);
  assert.equal(approvedProgramDepth(setup, { ...context, profileDepthMm: 4.055 }), 4.055);
  assert.throws(() => approvedProgramDepth(setup, { ...context, profileDepthMm: 4.06 }), /outside the approved/);
  assert.throws(() => approvedProgramDepth(setup, { ...context, profileDepthMm: 3.8 }), /outside the approved/);
  // Same boundaries through the gate, expressed as probed thickness.
  assert.equal(gate.certifiedThicknessHold(v2Job({ profileDepthMm: "4.055" }), "profile", probed(3.855), certifiedCam), "");
  assert.notEqual(gate.certifiedThicknessHold(v2Job({ profileDepthMm: "4.06" }), "profile", probed(3.855), certifiedCam), "");
  assert.notEqual(gate.certifiedThicknessHold(v2Job({ profileDepthMm: "3.8" }), "profile", probed(3.855), certifiedCam), "");
  assert.equal(gate.SACRIFICIAL_ALLOWANCE_MAX_MM, 0.2);
});
