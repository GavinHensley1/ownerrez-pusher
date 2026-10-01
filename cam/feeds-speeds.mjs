// Feed and speed solver.
//
// Every cutting feed in every generated program comes out of solveCut(). There
// is no other way to produce one, and no stage is permitted to write a literal
// feed number. The solver works forwards from physics:
//
//   1. pick the slowest router gear whose WORST-CASE rpm keeps the engaged
//      diameter under the material's surface-speed ceiling;
//   2. compute feed from the target chip load at that gear's nominal rpm,
//      correcting for radial chip thinning;
//   3. re-check the resulting chip load at BOTH ends of the gear's rpm range
//      and reject the stage if it can plough or overload.
//
// A rejection here is the intended outcome, not a failure to work around. The
// twenty-hour Profile stage happened because its CAM had no step 3: it was free
// to drive chip load down to 1.25 um/tooth to make an illegal surface speed
// survivable, and silently emitted the result.

import { PLOUGHING_CHIP_LOAD_MM, material as lookupMaterial } from "./material-library.mjs";
import {
  assertLightEngagementOnMetal,
  assertPermittedOnMetal,
  engagedDiameterMm,
  tool as lookupTool,
} from "./tool-library.mjs";
import { ROUTER, gear as lookupGear, surfaceSpeedMPerMin } from "./machine-library.mjs";

export class UnmachinableStageError extends Error {
  constructor(stage, reason, detail = {}) {
    super(`${stage}: ${reason}`);
    this.name = "UnmachinableStageError";
    this.stage = stage;
    this.reason = reason;
    this.detail = detail;
  }
}

// Radial chip thinning. When radial engagement is less than half the cutter
// diameter the actual chip is thinner than the programmed advance per tooth, so
// the programmed feed must be scaled UP to keep a real chip. Ignoring this is a
// second, quieter route into the ploughing regime.
export function chipThinningFactor(radialEngagementMm, diameterMm) {
  const ratio = Math.min(1, Math.max(0, radialEngagementMm / diameterMm));
  if (ratio >= 0.5) return 1;
  // Average chip thickness over the engaged arc, relative to feed per tooth.
  const factor = 2 * Math.sqrt(ratio * (1 - ratio));
  return Math.max(0.1, factor);
}

/**
 * Solve a single cutting condition.
 *
 * @param {object} options
 * @param {string} options.stage            stage name, used in error messages
 * @param {string} options.toolId           id from tool-library
 * @param {string} options.materialId       id from material-library
 * @param {number} options.axialDepthMm     depth of cut per pass
 * @param {number} options.radialEngagementMm  width of cut
 * @param {string} [options.chipLoadClass]  override the tool's default class
 * @param {number} [options.forceGear]      pin a gear instead of solving for one
 * @param {number} [options.maxFeedMmPerMin] engineering cap on the emitted feed
 */
export function solveCut(options) {
  const {
    stage,
    toolId,
    materialId,
    axialDepthMm,
    radialEngagementMm,
    chipLoadClass,
    forceGear,
    maxFeedMmPerMin,
  } = options;

  const toolSpec = lookupTool(toolId);
  const materialSpec = lookupMaterial(materialId);

  if (!(axialDepthMm > 0)) throw new UnmachinableStageError(stage, "axial depth must be positive", { axialDepthMm });
  if (!(radialEngagementMm > 0)) throw new UnmachinableStageError(stage, "radial engagement must be positive", { radialEngagementMm });

  // The operator's standing rule, applied before any arithmetic: a cutter he has
  // excluded from metal must not reach the point of having a feed computed for
  // it, and a cutter he permits must stay inside the load he permits it.
  if (materialSpec.isMetal) {
    try {
      assertPermittedOnMetal(toolSpec);
      assertLightEngagementOnMetal(toolSpec, radialEngagementMm, chipLoadClass || toolSpec.kind);
    } catch (error) {
      throw new UnmachinableStageError(stage, error.message, { toolId });
    }
  }

  if (!toolSpec.nonFerrousRated) {
    throw new UnmachinableStageError(stage, `${toolSpec.name} is not rated for non-ferrous metal`, { toolId });
  }

  const nominalDiameter = toolSpec.diameterMm ?? toolSpec.shankMm;
  const maxAxial = nominalDiameter * toolSpec.maxAxialFractionOfDiameter;
  if (axialDepthMm > maxAxial + 1e-9) {
    throw new UnmachinableStageError(
      stage,
      `axial depth ${axialDepthMm.toFixed(3)} mm exceeds ${(toolSpec.maxAxialFractionOfDiameter * 100).toFixed(0)}% of the ${nominalDiameter} mm cutter`,
      { axialDepthMm, maxAxial },
    );
  }

  const engaged = engagedDiameterMm(toolSpec, axialDepthMm);
  const surfaceCeiling = materialSpec.maxSurfaceSpeedMPerMin[toolSpec.surfaceSpeedClass];
  if (!Number.isFinite(surfaceCeiling)) {
    throw new UnmachinableStageError(stage, `no surface-speed limit for ${toolSpec.surfaceSpeedClass} in ${materialSpec.name}`);
  }

  const classKey = chipLoadClass || toolSpec.kind;
  const band = materialSpec.chipLoad[classKey];
  if (!band) throw new UnmachinableStageError(stage, `no chip-load data for tool class ${classKey} in ${materialSpec.name}`);

  const thinning = chipThinningFactor(radialEngagementMm, nominalDiameter);
  // Programmed advance per tooth needed to achieve the target ACTUAL chip.
  const programmedPerTooth = band.target / thinning;

  // Evaluate every gear. GEAR POLICY: take the LOWEST gear that still reaches
  // (within 2%) the best feed any legal gear can deliver. Running slower than
  // necessary is not free — it lowers the feed at a fixed chip load, which is
  // precisely how a sane-looking process turns into a ten-hour program — so
  // "slowest" is bounded by "not giving up throughput for nothing".
  const candidates = [];
  const rejections = [];
  for (const entry of forceGear ? [lookupGear(forceGear)] : ROUTER_GEARS()) {
    const surfaceSpeedWorst = surfaceSpeedMPerMin(engaged, entry.rpmMax);
    if (surfaceSpeedWorst > surfaceCeiling + 1e-9) {
      rejections.push(`gear ${entry.gear}: ${surfaceSpeedWorst.toFixed(0)} m/min over the ${surfaceCeiling} m/min limit`);
      continue;
    }
    let feed = Math.round(programmedPerTooth * toolSpec.flutes * entry.rpmNominal);
    let feedCappedBy = null;
    if (Number.isFinite(maxFeedMmPerMin) && feed > maxFeedMmPerMin) {
      feed = Math.round(maxFeedMmPerMin);
      feedCappedBy = "stage cap";
    }
    // What the machine ACTUALLY sees across this gear's rpm uncertainty.
    const actualChipMin = (feed / (toolSpec.flutes * entry.rpmMax)) * thinning;
    const actualChipMax = (feed / (toolSpec.flutes * entry.rpmMin)) * thinning;
    if (actualChipMin < PLOUGHING_CHIP_LOAD_MM) {
      rejections.push(`gear ${entry.gear}: chip load ${(actualChipMin * 1000).toFixed(2)} um/tooth at ${entry.rpmMax} rpm is under the ${PLOUGHING_CHIP_LOAD_MM * 1000} um/tooth ploughing floor`);
      continue;
    }
    if (actualChipMax > band.max + 1e-9) {
      rejections.push(`gear ${entry.gear}: chip load ${(actualChipMax * 1000).toFixed(1)} um/tooth at ${entry.rpmMin} rpm is over the ${(band.max * 1000).toFixed(0)} um/tooth limit`);
      continue;
    }
    candidates.push({ entry, feed, feedCappedBy, actualChipMin, actualChipMax, surfaceSpeedWorst });
  }

  if (!candidates.length) {
    throw new UnmachinableStageError(
      stage,
      `no router gear can cut a ${engaged.toFixed(3)} mm engaged diameter of ${materialSpec.name} with ${toolSpec.name} at ${axialDepthMm.toFixed(3)} mm axial / ${radialEngagementMm.toFixed(3)} mm radial. ${rejections.join("; ")}.`,
      { engaged, surfaceCeiling, rejections },
    );
  }

  const bestFeed = Math.max(...candidates.map((c) => c.feed));
  const chosen = candidates.find((c) => c.feed >= bestFeed * 0.98) || candidates[0];
  const selectedGear = chosen.entry;
  const feed = chosen.feed;
  const materialRemovalRate = axialDepthMm * radialEngagementMm * feed;

  return Object.freeze({
    stage,
    tool: toolSpec.id,
    toolName: toolSpec.name,
    material: materialSpec.id,
    gear: selectedGear.gear,
    rpmNominal: selectedGear.rpmNominal,
    rpmMin: selectedGear.rpmMin,
    rpmMax: selectedGear.rpmMax,
    rpmModelled: selectedGear.modelled,
    gearsRejected: rejections,
    axialDepthMm,
    radialEngagementMm,
    engagedDiameterMm: engaged,
    surfaceSpeedNominalMPerMin: surfaceSpeedMPerMin(engaged, selectedGear.rpmNominal),
    surfaceSpeedWorstMPerMin: chosen.surfaceSpeedWorst,
    surfaceSpeedLimitMPerMin: surfaceCeiling,
    chipThinningFactor: thinning,
    chipLoadClass: classKey,
    chipLoadTargetMm: band.target,
    chipLoadActualMinMm: chosen.actualChipMin,
    chipLoadActualMaxMm: chosen.actualChipMax,
    feedMmPerMin: feed,
    feedCappedBy: chosen.feedCappedBy,
    materialRemovalRateMm3PerMin: materialRemovalRate,
  });
}

/**
 * Solve several cutting conditions that must share ONE router gear.
 *
 * The router's speed is set by hand, so every phase inside a single program
 * runs at whatever gear the operator dialled in. Solving each phase
 * independently and hoping they agree does not work: the gear that maximises a
 * bulk pass's feed can starve a light finishing pass into the ploughing regime,
 * which is precisely the failure this returns as an error rather than hides.
 *
 * Picks the gear that maximises the worst phase's fraction of its own best
 * achievable feed, breaking ties toward the lower gear.
 */
export function solveSharedGear(phases) {
  const attempts = [];
  const failures = [];
  for (const entry of ROUTER.gears) {
    try {
      attempts.push({ gear: entry.gear, cuts: phases.map((phase) => solveCut({ ...phase, forceGear: entry.gear })) });
    } catch (error) {
      failures.push(`gear ${entry.gear}: ${error.reason || error.message}`);
    }
  }
  if (!attempts.length) {
    throw new UnmachinableStageError(
      phases[0].stage,
      `no single router gear can run all phases of this stage. ${failures.join(" | ")}`,
      { failures },
    );
  }
  const bestPerPhase = phases.map((_, index) => Math.max(...attempts.map((a) => a.cuts[index].feedMmPerMin)));
  let best = null;
  for (const attempt of attempts) {
    const score = Math.min(...attempt.cuts.map((cut, index) => cut.feedMmPerMin / bestPerPhase[index]));
    if (!best || score > best.score + 1e-9) best = { ...attempt, score };
  }
  return { gear: best.gear, cuts: best.cuts, rejectedGears: failures };
}

// A programmed feed the controller cannot actually deliver is not a safe feed:
// the machine runs slower than programmed, so the REAL chip load drops below
// the designed value and the tool starts to plough. The 4040-PRO is fed one
// G-code line at a time over Wi-Fi, so on a path made of very short segments the
// line rate, not the feed word, sets the speed.
export function assertFeedDeliverable(cut, meanSegmentLengthMm, linesPerSecond) {
  const deliverable = meanSegmentLengthMm * linesPerSecond * 60;
  if (cut.feedMmPerMin > deliverable * 1.02) {
    const impliedChip = cut.chipLoadActualMinMm * (deliverable / cut.feedMmPerMin);
    throw new UnmachinableStageError(
      cut.stage,
      `programmed feed ${cut.feedMmPerMin} mm/min cannot be delivered: the controller streams about ${linesPerSecond} lines/s and this path averages ${meanSegmentLengthMm.toFixed(3)} mm per segment, so the machine can only run ${deliverable.toFixed(0)} mm/min. Real chip load would collapse to ${(impliedChip * 1000).toFixed(2)} um/tooth. Lengthen the segments (raise the linearisation tolerance) or lower the feed.`,
      { deliverable, meanSegmentLengthMm, linesPerSecond },
    );
  }
  return deliverable;
}

function ROUTER_GEARS() {
  return ROUTER.gears;
}

// Plunge / ramp feed. A vertical or near-vertical entry has no sideways chip
// clearance, so it runs at a fraction of the lateral feed. Still derived, never
// typed in.
export function rampFeed(cut, fraction = 0.35) {
  return Math.max(10, Math.round(cut.feedMmPerMin * fraction));
}
