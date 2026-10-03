// Stage-chain and blank-thickness gates for certified metal programs.
//
// WHY THIS FILE IS CommonJS AND LIVES UNDER api/ — same reason as
// cnc-plate-contract.cjs: these rules are enforced in three places across a
// module-system boundary (the CommonJS Vercel API, the ESM Mac bridge, and the
// browser via a string the API publishes), and the one thing that must never
// happen is that two of them disagree about whether a program may cut.
//
// WHAT THE TWO GATES ARE FOR:
//
// 1. STAGE CHAIN. Metal Start requires the whole certified chain to be present.
//    That was written as a fixed five — rough, cleanup, finish, profile, release
//    — which is correct for a job assembled from hand-imported Kiri:Moto files.
//    It is wrong for a job installed from an in-repo certified library, because a
//    library may deliberately NOT contain a stage and record why: cam-v3 folds
//    cleanup into Finish (the only tool that can reach what Rough leaves is the
//    finisher itself, so a separate cleanup stage would be the same tool on the
//    same geometry) and drops the V-bit detail pass (not certified for C752).
//    Held to the fixed five, that job could never start, for a stage that is
//    deliberately absent. So the chain is the LIBRARY's own order when there is a
//    library, and the fixed five when there is not.
//
// 2. BLANK THICKNESS. Profile and Release cut THROUGH the sheet. Their depth is
//    stock thickness plus a sacrificial allowance into the backing, so it is only
//    valid for a blank of that thickness. cam-v3 says so about itself:
//    stock.thicknessMeasuredOnThisBlank is false — 3.855 mm was probed on the
//    previous, damaged sheet, and the sheet now in the machine is a new one.
//    A note is not a gate. This compares the certified through-depth against the
//    thickness physically probed on THIS blank and refuses when they disagree:
//      - probed thicker than the through-depth  -> the part would not come free;
//      - probed more than 0.200 mm thinner      -> the cutter digs into backing.
//    Rough and Finish are relief-only and are deliberately not gated.
//
// FAILS CLOSED. An absent probed thickness, an absent through-depth, or an
// unresolvable library id all refuse. None of them read as consent.

const METAL_FALLBACK_ORDER = ["rough", "cleanup", "finish", "profile", "release"];
const FALLBACK_THICKNESS_SENSITIVE_STAGES = ["profile", "release"];

// How far past the measured sheet a through-cut may reach, into the sacrificial
// backing. Matches approvedProgramDepth in machine/cnc-program.mjs.
const SACRIFICIAL_ALLOWANCE_MAX_MM = 0.2;
const SACRIFICIAL_ALLOWANCE_MIN_MM = 0;
// Float slack only. Not a tolerance on the allowance itself.
const EPSILON_MM = 0.001;

const RELEASED = "";

function readJsonArray(value) {
  try {
    const parsed = JSON.parse(String(value || "[]"));
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

// `library` is the certified-library accessor pair, passed in so this module does
// not have to read the 6 MB of program assets to answer a question about order.
function metalCertifiedOrder(job, library) {
  const fromLibrary = library && typeof library.certifiedLibraryOrder === "function"
    ? library.certifiedLibraryOrder(String((job && job.certifiedLibraryId) || ""))
    : [];
  if (fromLibrary.length) return fromLibrary;
  const declared = readJsonArray(job && job.gcodeStagesCertifiedOrder);
  return declared.length ? declared : METAL_FALLBACK_ORDER.slice();
}

// Which stages of THIS job cut through the blank:
//   - what the installed library declares (authoritative), else
//   - what the library declared at install time and the job still carries, else
//   - the stage now starting, but only if the caller says this start is a
//     sacrificial through-cut. A hand-imported profile that stops at the
//     protected floor does not cut through and is deliberately not gated here.
function metalThicknessSensitiveStages(job, library) {
  job = job || {};
  const fromLibrary = library && typeof library.certifiedThicknessSensitiveStages === "function"
    ? library.certifiedThicknessSensitiveStages(String(job.certifiedLibraryId || ""))
    : [];
  if (fromLibrary.length) return fromLibrary;
  const declared = readJsonArray(job.certifiedThicknessSensitiveStages);
  if (declared.length) return declared;
  return job.allowSacrificialCutThrough === true ? FALLBACK_THICKNESS_SENSITIVE_STAGES.slice() : [];
}

// Returns the operator-facing reason a through-cutting stage may not run against
// this blank, or "" when it may. `setup` is the bridge's probe snapshot.
function certifiedThicknessHold(job, stage, setup, library) {
  job = job || {};
  if (!metalThicknessSensitiveStages(job, library).includes(String(stage || ""))) return RELEASED;

  const target = Number(job.profileDepthMm);
  if (!(target > 0)) return `The ${stage} stage has no certified through-depth. Reload the certified program library.`;

  const probed = Number((setup || {}).stockThicknessMm);
  if (!(probed > 0)) {
    return `Probe this blank before the ${stage} stage. It cuts through the sheet, so its ${target.toFixed(3)} mm through-depth has to be checked against a thickness measured on the blank that is in the machine now.`;
  }

  const allowance = target - probed;
  if (allowance < SACRIFICIAL_ALLOWANCE_MIN_MM - EPSILON_MM || allowance > SACRIFICIAL_ALLOWANCE_MAX_MM + EPSILON_MM) {
    const certified = Number(job.certifiedStockThicknessMm);
    const posted = Number.isFinite(certified)
      ? ` The programs were posted for ${certified.toFixed(3)} mm${job.certifiedStockMeasuredOn ? `, measured on ${String(job.certifiedStockMeasuredOn)}` : ""}.`
      : "";
    const direction = allowance < 0
      ? "this blank is thicker than the programmed through-depth, so the part would not come free"
      : "this blank is thinner than the programs assume, so the cutter would reach too far into the sacrificial backing";
    return `The ${stage} stage cuts to ${target.toFixed(3)} mm but this blank probed ${probed.toFixed(3)} mm — ${direction} (sacrificial allowance ${allowance.toFixed(3)} mm, allowed ${SACRIFICIAL_ALLOWANCE_MIN_MM.toFixed(3)}–${SACRIFICIAL_ALLOWANCE_MAX_MM.toFixed(3)} mm).${posted} Regenerate Profile and Release with cam/generate-buckle.mjs against the measured thickness and reload the library. Rough and Finish are relief-only and are unaffected.`;
  }

  return RELEASED;
}

// True when the certificate itself says its thickness was measured elsewhere, so
// the dependency should be stated from install time rather than only at Start.
function certifiedThicknessIsUnverifiedForThisBlank(job) {
  return String((job && job.certifiedStockMeasuredOnThisBlank) || "") === "false";
}

module.exports = {
  METAL_FALLBACK_ORDER,
  FALLBACK_THICKNESS_SENSITIVE_STAGES,
  SACRIFICIAL_ALLOWANCE_MAX_MM,
  SACRIFICIAL_ALLOWANCE_MIN_MM,
  metalCertifiedOrder,
  metalThicknessSensitiveStages,
  certifiedThicknessHold,
  certifiedThicknessIsUnverifiedForThisBlank,
};
