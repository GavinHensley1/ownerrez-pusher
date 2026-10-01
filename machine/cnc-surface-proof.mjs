// Surface-contact proof: an INDEPENDENT corroboration that the bit is physically
// at the stock surface when the controller reports work Z zero.
//
// ---------------------------------------------------------------------------
// WHY A SEPARATE PROOF IS NECESSARY (the 2026-09-30 failure, stated precisely)
// ---------------------------------------------------------------------------
// The probe establishes the surface by ONE arithmetic chain:
//
//     stock surface machine Z = latched PRB contact Z - plate thickness
//
// Every downstream number is derived from that same chain: the Z work origin,
// the measured stock thickness, the protected floor, the maximum cut depth, and
// therefore every readiness gate and every depth validation. A wrong plate
// thickness corrupts the whole chain CONSISTENTLY, so nothing downstream can
// detect it:
//
//   * measured stock thickness = bed touch - stock touch, and the identical
//     plate error cancels in that subtraction, so the thickness looks correct;
//   * the depth gates compare the program against that same corrupted origin,
//     so they also pass.
//
// On 2026-09-30 a 20 mm plate figure was used against a ~14.19 mm plate. Zero
// sat ~5.8 mm below the true surface, every program cut ~5.8 mm deeper than
// commanded, and all ten readiness badges were green the entire time. No amount
// of additional checking INSIDE that arithmetic chain could have caught it.
//
// ---------------------------------------------------------------------------
// WHAT MAKES THIS PROOF INDEPENDENT
// ---------------------------------------------------------------------------
// The verification touch measures the surface WITHOUT USING THE PLATE AT ALL:
// the plate is removed, the clip is attached to the conductive stock itself, and
// the bit is driven down until the bit-to-stock contact closes the probe circuit.
// The latched PRB Z at that moment IS the true surface machine Z, with no plate
// term anywhere in it.
//
// Comparing that against the stored, plate-derived surface closes the loop:
//
//     delta = measured-without-plate - stored-with-plate
//
// A plate error of N mm shows up as a delta of exactly N mm. The 2026-09-30
// incident would have produced a ~5.8 mm delta and been refused before cutting.
//
// It also catches more than the plate number, which is the point. Because it is
// taken immediately before the run, it independently detects:
//   * lost or slipped Z steps between probing and Start (the machine is an
//     open-loop stepper whose Z limit switch has never worked, so counted steps
//     are not proof of physical position);
//   * stock that moved, lifted, or was replaced after probing;
//   * a stale calibration restored into a different physical setup.
//
// ---------------------------------------------------------------------------
// HONEST LIMITS (do not oversell this gate)
// ---------------------------------------------------------------------------
//  1. It shares the probe CIRCUIT and the machine's motion system with the
//     original probe. A shorted or sticky probe circuit can false-trigger both.
//     Mitigated by requiring the probe input to be inactive before the touch, to
//     latch during it, and to clear after the retract, and by requiring two
//     independent touches to agree - the same structure the main probe uses.
//  2. It proves the surface at ONE point. It does not prove the stock is flat or
//     level. Bowed stock has already stopped one run on this machine.
//  3. Electrical verification requires CONDUCTIVE stock. Wood cannot close the
//     circuit, so wood falls back to an explicit operator-attested feeler check.
//     That attestation is deliberately NOT accepted for metal: metal is where
//     the sub-millimetre margin lives, so metal demands the measured touch.
//
// ---------------------------------------------------------------------------
// FAIL-CLOSED CONTRACT
// ---------------------------------------------------------------------------
// Absent proof, unparsable proof, expired proof, proof bound to a different
// plate thickness, or proof bound to a different surface/Z origin all BLOCK the
// start. Nothing here may ever fail open; several older depth gates in this
// codebase failed open when their input snapshot was missing, which is precisely
// the shape of bug that lets a bad setup reach the metal.

export const SURFACE_PROOF_CONDUCTIVE = "conductive-stock-touch";
export const SURFACE_PROOF_ATTESTED = "operator-attested-feeler";

// The probe's own two touches must already agree within 0.05 mm, and the machine
// resolves about 0.0125 mm/step. 0.08 mm leaves room for genuine repeatability
// and surface finish while being far tighter than any error that matters: the
// shallowest metal pass removes 0.0317 mm, and the incident error was ~5810 um.
export const SURFACE_PROOF_TOLERANCE_MM = 0.08;

// A proof is a statement about the machine's CURRENT physical state. Thirty
// minutes is long enough to finish setting up and turn the router on, and short
// enough that the proof cannot be a souvenir from an earlier session.
export const SURFACE_PROOF_MAX_AGE_MS = 30 * 60 * 1000;

// Binding tolerance for "is this proof still about the same zero?". Tighter than
// the measurement tolerance because these are stored numbers being compared to
// themselves, not physical measurements.
const BINDING_TOLERANCE_MM = 0.005;

// Strict numeric coercion. Number(null), Number(""), Number([]) and Number(false)
// are all 0, so the usual Number.isFinite(Number(x)) check would silently accept a
// missing measurement as 0 mm machine Z - and 0 is a real coordinate on this
// machine. A missing number must be missing, not zero.
const num = (value) => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};
const finite = (value) => num(value) !== null;

// Metal is where this gate is mandatory. Match the material strings this project
// actually uses ("C752 nickel silver") plus the obvious non-ferrous families, and
// honour an explicit metalMode flag from the job plan.
export function requiresMeasuredSurfaceProof({ material = "", metalMode = false } = {}) {
  if (metalMode === true) return true;
  return /c752|nickel\s*silver|brass|bronze|alumin|copper|steel|metal/i.test(String(material || ""));
}

export function buildSurfaceProof({
  method,
  measuredSurfaceMPosZ = null,
  plateThicknessMm,
  setup,
  operatorConfirmed = false,
  at = new Date().toISOString(),
  toleranceMm = SURFACE_PROOF_TOLERANCE_MM,
  evidence = {},
}) {
  if (method !== SURFACE_PROOF_CONDUCTIVE && method !== SURFACE_PROOF_ATTESTED) {
    throw new Error(`Unknown surface-proof method ${method}`);
  }
  const expectedSurfaceMPosZ = num(setup?.stockSurfaceMPos);
  if (expectedSurfaceMPosZ === null) throw new Error("There is no stored stock surface to corroborate; probe the stock first");
  const zOriginMPos = num(setup?.zOriginMPos);
  if (zOriginMPos === null) throw new Error("There is no stored Z work origin to corroborate; probe the stock first");
  const plateMm = num(plateThicknessMm);
  if (plateMm === null) throw new Error("Surface proof requires the plate thickness it is being compared against");

  let deltaMm = null, verified = false;
  if (method === SURFACE_PROOF_CONDUCTIVE) {
    const measured = num(measuredSurfaceMPosZ);
    if (measured === null) throw new Error("The verification touch did not return a usable contact height");
    deltaMm = measured - expectedSurfaceMPosZ;
    verified = Math.abs(deltaMm) <= toleranceMm;
  } else {
    // The operator looked at the bit sitting at commanded work Z0 and confirmed
    // physical contact. There is no number to compare, so the attestation itself
    // is the evidence and it must be explicit.
    verified = operatorConfirmed === true;
  }

  return {
    version: 1,
    method,
    verified,
    deltaMm,
    toleranceMm: num(toleranceMm) ?? SURFACE_PROOF_TOLERANCE_MM,
    measuredSurfaceMPosZ: method === SURFACE_PROOF_CONDUCTIVE ? num(measuredSurfaceMPosZ) : null,
    expectedSurfaceMPosZ,
    zOriginMPos,
    plateThicknessMm: plateMm,
    at,
    expiresAt: new Date(Date.parse(at) + SURFACE_PROOF_MAX_AGE_MS).toISOString(),
    evidence: {
      firstContactZ: finite(evidence.firstContactZ) ? Number(evidence.firstContactZ) : null,
      secondContactZ: finite(evidence.secondContactZ) ? Number(evidence.secondContactZ) : null,
      searchedMm: finite(evidence.searchedMm) ? Number(evidence.searchedMm) : null,
    },
  };
}

// Throws with an operator-readable reason when the proof cannot authorise a cut.
// Every exit path from here either throws or returns a verified proof.
export function assertSurfaceProofReady(proof, {
  setup,
  plateThicknessMm,
  material = "",
  metalMode = false,
  now = Date.now(),
  maxAgeMs = SURFACE_PROOF_MAX_AGE_MS,
} = {}) {
  const needsMeasured = requiresMeasuredSurfaceProof({ material, metalMode });
  const what = needsMeasured
    ? "Verify surface contact with the clip on the metal and the plate removed"
    : "Verify surface contact before starting";

  if (!proof || typeof proof !== "object" || proof.version !== 1) {
    throw new Error(`Surface-contact proof is missing. ${what}. The controller reporting work Z zero is not by itself evidence that the bit is at the surface.`);
  }
  if (proof.verified !== true) {
    const detail = finite(proof.deltaMm) ? ` Last check disagreed by ${Number(proof.deltaMm).toFixed(3)} mm.` : "";
    throw new Error(`Surface-contact proof did not pass.${detail} ${what}.`);
  }
  if (needsMeasured && proof.method !== SURFACE_PROOF_CONDUCTIVE) {
    throw new Error(`This material requires a measured surface-contact touch, not an operator attestation. Attach the clip to the stock, remove the plate, and run the surface check.`);
  }
  if (proof.method !== SURFACE_PROOF_CONDUCTIVE && proof.method !== SURFACE_PROOF_ATTESTED) {
    throw new Error(`Surface-contact proof used an unrecognised method ${proof.method}`);
  }

  // Bound to the plate figure it corroborated. Changing the plate number changes
  // the stored surface, so an older proof no longer says anything about it.
  if (!finite(proof.plateThicknessMm) || Math.abs(Number(proof.plateThicknessMm) - Number(plateThicknessMm)) > BINDING_TOLERANCE_MM) {
    throw new Error(`Surface-contact proof was taken with a ${Number(proof.plateThicknessMm).toFixed(2)} mm plate but ${Number(plateThicknessMm).toFixed(2)} mm is configured now. Re-probe and verify again.`);
  }

  // Bound to the exact surface and Z origin it verified, so any re-probe, re-zero
  // or restored calibration invalidates it rather than inheriting its approval.
  for (const [field, current] of [["expectedSurfaceMPosZ", setup?.stockSurfaceMPos], ["zOriginMPos", setup?.zOriginMPos]]) {
    if (!finite(proof[field]) || !finite(current) || Math.abs(Number(proof[field]) - Number(current)) > BINDING_TOLERANCE_MM) {
      throw new Error(`Surface-contact proof belongs to a different Z reference (${field} ${proof[field]} vs ${current}). Verify surface contact again.`);
    }
  }

  if (proof.method === SURFACE_PROOF_CONDUCTIVE) {
    const tolerance = finite(proof.toleranceMm) ? Number(proof.toleranceMm) : SURFACE_PROOF_TOLERANCE_MM;
    if (!finite(proof.deltaMm) || Math.abs(Number(proof.deltaMm)) > tolerance) {
      throw new Error(`Surface-contact proof is out of tolerance by ${Number(proof.deltaMm)} mm (limit ${tolerance} mm)`);
    }
  }

  const takenAt = Date.parse(String(proof.at || ""));
  if (!Number.isFinite(takenAt)) throw new Error("Surface-contact proof has no usable timestamp");
  const ageMs = now - takenAt;
  // A future timestamp is as untrustworthy as an expired one.
  if (ageMs < -1000) throw new Error("Surface-contact proof is timestamped in the future");
  if (ageMs > maxAgeMs) {
    throw new Error(`Surface-contact proof expired ${Math.round((ageMs - maxAgeMs) / 60000)} min ago. Verify surface contact again immediately before starting.`);
  }
  return proof;
}

// Convenience for UI/health: never throws, reports why it is not usable.
export function surfaceProofStatus(proof, options = {}) {
  try {
    assertSurfaceProofReady(proof, options);
    return { ready: true, reason: "", proof };
  } catch (error) {
    return { ready: false, reason: error.message, proof: proof || null };
  }
}
