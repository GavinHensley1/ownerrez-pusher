import test from "node:test";
import assert from "node:assert/strict";
import {
  SURFACE_PROOF_ATTESTED,
  SURFACE_PROOF_CONDUCTIVE,
  SURFACE_PROOF_TOLERANCE_MM,
  assertSurfaceProofReady,
  buildSurfaceProof,
  requiresMeasuredSurfaceProof,
  surfaceProofStatus,
} from "./cnc-surface-proof.mjs";

// The real numbers from the 2026-09-30 incident setup.
const PLATE = 14.19;
const setup = { stockSurfaceMPos: -36.319, zOriginMPos: -36.319, stockThicknessMm: 3.855 };
const good = (overrides = {}) => buildSurfaceProof({
  method: SURFACE_PROOF_CONDUCTIVE,
  measuredSurfaceMPosZ: -36.319,
  plateThicknessMm: PLATE,
  setup,
  ...overrides,
});

test("metal requires a measured surface proof; wood does not", () => {
  assert.equal(requiresMeasuredSurfaceProof({ material: "C752 nickel silver" }), true);
  assert.equal(requiresMeasuredSurfaceProof({ material: "Aluminum / soft metal" }), true);
  assert.equal(requiresMeasuredSurfaceProof({ material: "", metalMode: true }), true);
  assert.equal(requiresMeasuredSurfaceProof({ material: "Softwood / pine" }), false);
  assert.equal(requiresMeasuredSurfaceProof({ material: "Hardwood" }), false);
});

test("a matching plate-free touch produces a verified proof", () => {
  const proof = good();
  assert.equal(proof.verified, true);
  assert.equal(proof.method, SURFACE_PROOF_CONDUCTIVE);
  assert.equal(Math.abs(proof.deltaMm) < 1e-9, true);
  assert.doesNotThrow(() => assertSurfaceProofReady(proof, { setup, plateThicknessMm: PLATE, material: "C752 nickel silver" }));
});

test("THE INCIDENT: a 20 mm plate against a 14.19 mm plate is caught as a ~5.81 mm disagreement", () => {
  // Zero was established with 20 mm when the plate was 14.19 mm, so the stored
  // surface sits 5.81 mm BELOW the true surface. The plate-free touch finds the
  // true surface and the disagreement is exactly the plate error.
  const trueSurfaceZ = -36.319 + 5.81;
  const proof = buildSurfaceProof({ method: SURFACE_PROOF_CONDUCTIVE, measuredSurfaceMPosZ: trueSurfaceZ, plateThicknessMm: PLATE, setup });
  assert.equal(proof.verified, false);
  assert.equal(Math.abs(proof.deltaMm - 5.81) < 1e-6, true);
  assert.throws(
    () => assertSurfaceProofReady(proof, { setup, plateThicknessMm: PLATE, material: "C752 nickel silver" }),
    /Surface-contact proof did not pass.*5\.810 mm/s,
  );
});

test("fails closed on absent, malformed or unverified proof", () => {
  for (const bad of [undefined, null, {}, { version: 2 }, "proof", 0]) {
    assert.throws(() => assertSurfaceProofReady(bad, { setup, plateThicknessMm: PLATE }), /Surface-contact proof is missing/);
  }
  assert.throws(
    () => assertSurfaceProofReady({ ...good(), verified: false }, { setup, plateThicknessMm: PLATE }),
    /did not pass/,
  );
});

test("metal refuses an operator attestation but wood accepts it", () => {
  const attested = buildSurfaceProof({ method: SURFACE_PROOF_ATTESTED, plateThicknessMm: PLATE, setup, operatorConfirmed: true });
  assert.equal(attested.verified, true);
  assert.doesNotThrow(() => assertSurfaceProofReady(attested, { setup, plateThicknessMm: PLATE, material: "Softwood / pine" }));
  assert.throws(
    () => assertSurfaceProofReady(attested, { setup, plateThicknessMm: PLATE, material: "C752 nickel silver" }),
    /requires a measured surface-contact touch/,
  );
  assert.throws(
    () => assertSurfaceProofReady(attested, { setup, plateThicknessMm: PLATE, metalMode: true }),
    /requires a measured surface-contact touch/,
  );
  // An attestation that was never actually confirmed is not verified.
  assert.equal(buildSurfaceProof({ method: SURFACE_PROOF_ATTESTED, plateThicknessMm: PLATE, setup }).verified, false);
});

test("proof is bound to the plate it corroborated", () => {
  const proof = good();
  assert.throws(
    () => assertSurfaceProofReady(proof, { setup, plateThicknessMm: 20, material: "C752 nickel silver" }),
    /taken with a 14\.19 mm plate but 20\.00 mm is configured/,
  );
  // Even a 0.19 mm change invalidates it, because that is the 14 vs 14.19 ambiguity.
  assert.throws(() => assertSurfaceProofReady(proof, { setup, plateThicknessMm: 14.0 }), /is configured now/);
});

test("proof is bound to the exact Z reference, so any re-probe or re-zero invalidates it", () => {
  const proof = good();
  assert.throws(
    () => assertSurfaceProofReady(proof, { setup: { ...setup, stockSurfaceMPos: -30.0 }, plateThicknessMm: PLATE }),
    /belongs to a different Z reference/,
  );
  assert.throws(
    () => assertSurfaceProofReady(proof, { setup: { ...setup, zOriginMPos: -30.0 }, plateThicknessMm: PLATE }),
    /belongs to a different Z reference/,
  );
  assert.throws(
    () => assertSurfaceProofReady(proof, { setup: { stockSurfaceMPos: null, zOriginMPos: null }, plateThicknessMm: PLATE }),
    /belongs to a different Z reference/,
  );
});

test("proof expires and refuses future timestamps", () => {
  const at = new Date("2026-10-01T12:00:00.000Z").toISOString();
  const proof = good({ at });
  const base = Date.parse(at);
  assert.doesNotThrow(() => assertSurfaceProofReady(proof, { setup, plateThicknessMm: PLATE, now: base + 60_000 }));
  assert.throws(
    () => assertSurfaceProofReady(proof, { setup, plateThicknessMm: PLATE, now: base + 31 * 60_000 }),
    /expired/,
  );
  assert.throws(
    () => assertSurfaceProofReady(proof, { setup, plateThicknessMm: PLATE, now: base - 60_000 }),
    /timestamped in the future/,
  );
  assert.throws(
    () => assertSurfaceProofReady({ ...proof, at: "not-a-date" }, { setup, plateThicknessMm: PLATE }),
    /no usable timestamp/,
  );
});

test("tolerance boundary: just inside passes, just outside is refused", () => {
  const inside = buildSurfaceProof({ method: SURFACE_PROOF_CONDUCTIVE, measuredSurfaceMPosZ: -36.319 + (SURFACE_PROOF_TOLERANCE_MM - 0.001), plateThicknessMm: PLATE, setup });
  assert.equal(inside.verified, true);
  const outside = buildSurfaceProof({ method: SURFACE_PROOF_CONDUCTIVE, measuredSurfaceMPosZ: -36.319 + (SURFACE_PROOF_TOLERANCE_MM + 0.001), plateThicknessMm: PLATE, setup });
  assert.equal(outside.verified, false);
  // Even a sub-tenth-mm error exceeds the shallowest certified metal pass (0.0317 mm),
  // so refusing at this scale is deliberate rather than over-strict.
  assert.equal(SURFACE_PROOF_TOLERANCE_MM < 0.1, true);
});

test("building a proof refuses to invent a reference that does not exist", () => {
  assert.throws(() => buildSurfaceProof({ method: SURFACE_PROOF_CONDUCTIVE, measuredSurfaceMPosZ: -36, plateThicknessMm: PLATE, setup: {} }), /no stored stock surface/);
  assert.throws(() => buildSurfaceProof({ method: SURFACE_PROOF_CONDUCTIVE, measuredSurfaceMPosZ: -36, plateThicknessMm: PLATE, setup: { stockSurfaceMPos: -36 } }), /no stored Z work origin/);
  assert.throws(() => buildSurfaceProof({ method: SURFACE_PROOF_CONDUCTIVE, measuredSurfaceMPosZ: null, plateThicknessMm: PLATE, setup }), /did not return a usable contact height/);
  assert.throws(() => buildSurfaceProof({ method: "guesswork", plateThicknessMm: PLATE, setup }), /Unknown surface-proof method/);
});

test("surfaceProofStatus never throws and explains why it is unusable", () => {
  const absent = surfaceProofStatus(null, { setup, plateThicknessMm: PLATE });
  assert.equal(absent.ready, false);
  assert.match(absent.reason, /missing/);
  const ok = surfaceProofStatus(good(), { setup, plateThicknessMm: PLATE });
  assert.equal(ok.ready, true);
  assert.equal(ok.reason, "");
});
