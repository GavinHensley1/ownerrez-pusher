// Cut-execution hold. Stored files, manual positioning and probing stay available.
//
// WHAT THIS USED TO BE, AND WHY IT HAD TO CHANGE:
// Until 2026-10-01 this file was an unconditional blocklist. It held a cut if the
// program's camSourceHash was one of five certified Rambo-buckle hashes, or if
// certifiedLibraryId was "rambo-buckle-c752-v1" — with no way to clear. Because
// api/app.js turns the returned string into a 409 on Start and index.html uses it
// to disable the Start button, Start could never succeed for the only metal job
// in the system. That was correct as an emergency stop on 2026-09-30 and wrong
// as a steady state.
//
// Its premise is now resolved. All 834,070 lines of the five programs were
// independently audited and re-hashed byte-for-byte; the G-code was never the
// fault. The fault was the Z REFERENCE: the probe plate was configured 20 mm
// against a plate that is actually ~14.19 mm, putting work Z0 about 5.81-6.09 mm
// below the true surface. At that offset the program's own clearance height of
// work Z+4.99 physically sat 0.82-1.10 mm INSIDE the metal, so the opening
// rapids G0 Z4.99 / G0 X0 Y0 / G0 X25.8686 Y83.4308 bored a crater at each
// endpoint and dragged a groove between them, before any commanded cutting depth
// was ever reached.
//
// So the hold is no longer about WHICH program. It is about whether the Z
// reference that program will be executed against has been proven, and it is
// asserted for EVERY job unless all of the following are in force:
//   - the operator has confirmed a measured plate thickness;
//   - a locked Z calibration exists;
//   - that calibration was captured at the SAME plate thickness now configured
//     (this is the specific condition that was invisible on 2026-09-30, because
//     measured stock thickness is a difference of two touches and the plate
//     error cancels out of it);
//   - an independent, plate-free surface-contact proof is in force, itself taken
//     at the configured plate thickness;
//   - and for metal, that proof is a measured conductive touch, not an eyeball
//     attestation, because a 0.06 mm skim on a 3.855 mm blank has no margin.
//
// FAIL CLOSED. No machine evidence at all means held, never released — an absent
// bridge snapshot must not read as consent.
const { plateThicknessMatches } = require("./cnc-plate-contract.cjs");

const METAL_PROOF_METHOD = "conductive-stock-touch";
const RELEASED = "";

function isMetal(job) {
  return /C752 nickel silver/i.test(String((job && job.material) || ""));
}

const RELEASED_DETAIL = { reason: RELEASED, requiresFreshSetup: false };

// Two kinds of hold, and the difference matters to the operator:
//  - requiresFreshSetup TRUE  -> the Z REFERENCE ITSELF is wrong or unknown
//    (plate unconfirmed, calibration captured at a different plate, no lock).
//    Nothing is recoverable until the bed and stock are probed again.
//  - requiresFreshSetup FALSE -> the reference is sound but the proof that the
//    bit is physically at the surface has not been taken yet, which the operator
//    clears with one action. Calling that a "fresh setup" would send them back
//    to re-probe for no reason, which is how a safe gate becomes a dead end.
const held = (reason, requiresFreshSetup) => ({ reason, requiresFreshSetup });

// `machine` is the Mac bridge's /health snapshot (or the subset of it the daemon
// holds locally): { plate, surfaceProof, setup }.
function programAuditHoldDetail(job = {}, machine = null) {
  const verdict = evaluate(job, machine);
  return verdict.reason ? verdict : RELEASED_DETAIL;
}

// String form, kept because api/app.js turns it straight into a 409 body and
// index.html renders it as the Start-disabled notice.
function programAuditHold(job = {}, machine = null) {
  return programAuditHoldDetail(job, machine).reason;
}

function evaluate(job, machine) {
  if (!machine || typeof machine !== "object") {
    return held("Cutting is held until the Mac bridge reports the Z-probe plate and a surface-contact proof. Update or restart the bridge, then confirm the plate and verify surface contact.", true);
  }

  const plate = machine.plate || null;
  const setup = machine.setup || {};
  const proofState = machine.surfaceProof || null;

  if (!plate || plate.confirmed !== true) {
    return held("Cutting is held until you confirm the measured thickness of the Z-probe plate you are actually using. A wrong plate figure moves absolute Z zero by exactly that error and every cut goes that much deeper. The plate thickness has never been confirmed.", true);
  }

  // The bridge /health snapshot publishes this as `thicknessMm`; a raw plate
  // config record names it `plateThicknessMm`. Accept either so the hold can be
  // evaluated against whichever shape the caller holds, and treat an absent
  // value as unreadable rather than as zero.
  const configuredMm = Number(plate.thicknessMm !== undefined ? plate.thicknessMm : plate.plateThicknessMm);
  if (!Number.isFinite(configuredMm)) {
    return held("Cutting is held: the configured Z-probe plate thickness is unreadable. Re-enter the measured plate thickness.", true);
  }

  if (setup.probeLocked !== true) {
    return held(`Cutting is held until Z is probed and locked against the confirmed ${configuredMm.toFixed(2)} mm plate.`, true);
  }

  // THE 2026-09-30 CONDITION. Hold any job whose calibration was captured at a
  // different plate thickness than is configured now, so correcting the plate
  // figure can never leave a stale calibration silently in force.
  if (!plateThicknessMatches(setup.probeThickness, configuredMm)) {
    const capturedMm = Number(setup.probeThickness);
    const captured = Number.isFinite(capturedMm) ? `${capturedMm.toFixed(2)} mm` : "an unrecorded thickness";
    return held(`Cutting is held: the locked Z calibration was captured with ${captured} but ${configuredMm.toFixed(2)} mm is configured. Absolute Z zero is off by the difference. Re-probe the bed and stock against the configured plate.`, true);
  }

  if (!proofState) {
    return held("Cutting is held until the Mac bridge reports a surface-contact proof. Update or restart the bridge, then verify surface contact.", true);
  }
  // The reference is sound from here on; only the physical proof is outstanding,
  // and the operator clears it with one action. Not a fresh-setup condition.
  if (proofState.ready !== true) {
    return held(`Cutting is held until surface contact is proven independently of the plate. ${String(proofState.reason || "Run Verify surface contact.")}`, false);
  }

  const proof = proofState.proof || {};

  // A proof taken BEFORE the plate was corrected proves nothing about the
  // reference now in force, so it is held exactly like a mismatched calibration.
  if (proof.plateThicknessMm !== undefined && !plateThicknessMatches(proof.plateThicknessMm, configuredMm)) {
    const proofMm = Number(proof.plateThicknessMm);
    const at = Number.isFinite(proofMm) ? `${proofMm.toFixed(2)} mm` : "an unrecorded thickness";
    return held(`Cutting is held: the surface-contact proof was taken at ${at} but ${configuredMm.toFixed(2)} mm is configured. Verify surface contact again against the configured plate.`, false);
  }

  if (isMetal(job) && String(proof.method || "") !== METAL_PROOF_METHOD) {
    return held("Cutting is held: metal requires a measured surface-contact touch on the conductive blank, not an operator attestation. Attach the clip to the metal, remove the plate, and run Verify surface contact.", false);
  }

  return held(RELEASED, false);
}

module.exports = { programAuditHold, programAuditHoldDetail, METAL_PROOF_METHOD };
