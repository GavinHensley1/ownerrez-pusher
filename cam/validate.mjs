// Independent validator.
//
// It re-reads the emitted text and checks the contract from scratch, with no
// access to the builder's own state. A generator bug that produced a safe-looking
// internal model but wrong output has to get past this too.
//
// These are the project's existing contracts (memory 2026-09-29 "Binding metal
// buckle geometry and finish contract", 2026-09-30 five-file re-audit) plus the
// two the machinability audit added: no full-immersion slotting, and tabs that
// actually exist.

import { parseMoves, segmentLengthMm } from "./nc-parse.mjs";

const FORBIDDEN = /\b(?:G10|G28|G30|G53|G91|G92|M0?3|M0?4|M0?5|M0?6)\b/i;

export function validateProgram(code, contract) {
  const problems = [];
  const fail = (message) => problems.push(message);

  if (!/^G21\b/m.test(code)) fail("missing G21 metric");
  if (!/^G90\b/m.test(code)) fail("missing G90 absolute");
  if (FORBIDDEN.test(code)) {
    fail(`contains a forbidden command: ${code.match(FORBIDDEN)[0]}`);
  }
  if (!/^M30\s*$/m.test(code.trim().split("\n").pop())) fail("does not end with M30");

  let minZ = Infinity;
  let maxZ = -Infinity;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let maxCutFeed = 0;
  let rapidBelowSurface = 0;
  let travelBelowClearance = 0;
  let verticalPlunges = 0;
  let deepestVerticalPlunge = 0;
  let steepestEntryDeg = 0;
  let cutMoves = 0;
  let cutDistanceMm = 0;
  let cutTimeMin = 0;
  let lastCutIndex = -1;
  let lastMotion = null;
  let index = 0;

  const moves = [...parseMoves(code)];
  for (const move of moves) {
    index += 1;
    const length = segmentLengthMm(move);
    const lateral = Math.hypot(move.to.x - move.from.x, move.to.y - move.from.y);
    const descent = move.from.z - move.to.z;

    if (move.rapid) {
      // A rapid that DESCENDS to or below the stock surface, or that moves
      // laterally while at or below it, is an uncontrolled cut. A purely
      // upward retract out of a cut is the required way to leave one.
      const descends = move.to.z < move.from.z - 1e-9;
      const lateralAtOrBelow = lateral > 1e-6 && (move.to.z <= 0 || move.from.z <= 0);
      if ((descends && move.to.z <= 0) || lateralAtOrBelow) rapidBelowSurface += 1;
      // XY travel is only permitted above the clearance plane.
      if (lateral > 1e-6 && (move.from.z < contract.clearanceZMm - 1e-6 || move.to.z < contract.clearanceZMm - 1e-6)) {
        travelBelowClearance += 1;
      }
    } else {
      cutMoves += 1;
      cutDistanceMm += length;
      if (move.feed > 0) cutTimeMin += length / move.feed;
      maxCutFeed = Math.max(maxCutFeed, move.feed);
      if (move.to.z < 0 || move.from.z < 0) {
        minZ = Math.min(minZ, move.to.z, move.from.z);
        minX = Math.min(minX, move.to.x, move.from.x);
        maxX = Math.max(maxX, move.to.x, move.from.x);
        minY = Math.min(minY, move.to.y, move.from.y);
        maxY = Math.max(maxY, move.to.y, move.from.y);
      }
      if (descent > 1e-6 && move.to.z < 0) {
        if (lateral < 1e-6) {
          verticalPlunges += 1;
          deepestVerticalPlunge = Math.max(deepestVerticalPlunge, -move.to.z);
        } else {
          steepestEntryDeg = Math.max(steepestEntryDeg, (Math.atan2(descent, lateral) * 180) / Math.PI);
        }
      }
      lastCutIndex = index;
    }
    maxZ = Math.max(maxZ, move.to.z, move.from.z);
    lastMotion = move;
  }

  if (rapidBelowSurface) fail(`${rapidBelowSurface} rapid move(s) at or below the stock surface`);
  if (travelBelowClearance) fail(`${travelBelowClearance} XY travel move(s) below the clearance plane`);
  if (verticalPlunges) fail(`${verticalPlunges} vertical plunge(s) into the stock, deepest ${deepestVerticalPlunge.toFixed(4)} mm`);

  if (Number.isFinite(contract.maxDepthMm) && minZ < -contract.maxDepthMm - 1e-4) {
    fail(`reaches Z${minZ.toFixed(4)}, deeper than the ${contract.maxDepthMm} mm envelope`);
  }
  if (Number.isFinite(contract.maxCutFeedMmPerMin) && maxCutFeed > contract.maxCutFeedMmPerMin + 1e-6) {
    fail(`cutting feed ${maxCutFeed} exceeds the ${contract.maxCutFeedMmPerMin} mm/min limit`);
  }
  if (contract.bounds) {
    const { bounds } = contract;
    if (minX < bounds.minX - 1e-3 || maxX > bounds.maxX + 1e-3 || minY < bounds.minY - 1e-3 || maxY > bounds.maxY + 1e-3) {
      fail(
        `cutting bounds X ${minX.toFixed(3)}..${maxX.toFixed(3)} Y ${minY.toFixed(3)}..${maxY.toFixed(3)} leave the certified envelope`,
      );
    }
  }

  // The final cutting move must be followed only by a vertical retract.
  const tail = moves.slice(lastCutIndex);
  if (!tail.length) {
    fail("contains no cutting move");
  } else {
    const after = tail.slice(1);
    const lateralAfter = after.filter((m) => Math.hypot(m.to.x - m.from.x, m.to.y - m.from.y) > 1e-6);
    if (lateralAfter.length) fail(`${lateralAfter.length} XY move(s) after the final cut`);
    if (!lastMotion || lastMotion.to.z < contract.clearanceZMm - 1e-6) {
      fail(`does not end at the clearance plane (ends at Z${lastMotion ? lastMotion.to.z : "?"})`);
    }
  }

  return {
    ok: problems.length === 0,
    problems,
    metrics: {
      totalMoves: moves.length,
      cutMoves,
      cutDistanceMm,
      cutTimeMin,
      meanCutSegmentMm: cutMoves ? cutDistanceMm / cutMoves : 0,
      minZ: Number.isFinite(minZ) ? minZ : 0,
      maxZ,
      maxCutFeed,
      steepestEntryDeg,
      bounds: { minX, maxX, minY, maxY },
      lines: code.split("\n").filter(Boolean).length,
    },
  };
}

/**
 * Reject full-radial-immersion slotting.
 *
 * A closed contour cut once per level at full tool width is a slot: the cutter
 * is buried on both sides, which is what forced the rejected Profile stage down
 * to 0.05 mm axial and 1.25 um/tooth. A trochoidal or peeled path revisits the
 * same arc position repeatedly at different offsets, so the test is whether the
 * path's own width at each place along it exceeds the tool diameter.
 */
export function assertNoFullImmersionSlotting(code, toolDiameterMm, { minWideningMm = 0.3 } = {}) {
  const cutting = [...parseMoves(code)].filter((m) => !m.rapid && (m.to.z < -1e-6 || m.from.z < -1e-6));
  if (!cutting.length) return { slotting: false, kerfWidthMm: 0, samples: 0 };

  // Bucket cutter-centre positions on a coarse grid, then measure how far the
  // centres spread perpendicular to the local direction of travel.
  const cell = Math.max(0.5, toolDiameterMm / 2);
  const buckets = new Map();
  for (const move of cutting) {
    const key = `${Math.round(move.to.x / cell)}:${Math.round(move.to.y / cell)}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = [];
      buckets.set(key, bucket);
    }
    bucket.push(move.to);
  }

  let widest = 0;
  let narrow = 0;
  let sampled = 0;
  for (const bucket of buckets.values()) {
    if (bucket.length < 3) continue;
    sampled += 1;
    let minXb = Infinity;
    let maxXb = -Infinity;
    let minYb = Infinity;
    let maxYb = -Infinity;
    for (const point of bucket) {
      minXb = Math.min(minXb, point.x);
      maxXb = Math.max(maxXb, point.x);
      minYb = Math.min(minYb, point.y);
      maxYb = Math.max(maxYb, point.y);
    }
    const spread = Math.max(maxXb - minXb, maxYb - minYb);
    widest = Math.max(widest, spread);
    if (spread < minWideningMm) narrow += 1;
  }

  const kerfWidthMm = toolDiameterMm + widest;
  const slotting = sampled > 0 && narrow / sampled > 0.5;
  return { slotting, kerfWidthMm, centreSpreadMm: widest, samples: sampled, narrowFraction: sampled ? narrow / sampled : 0 };
}

/**
 * Confirm a profile program actually leaves holding tabs: at least `expected`
 * distinct arc regions where the program never reaches full through depth.
 */
export function findHoldingTabs(code, throughDepthMm, { tolerance = 0.05 } = {}) {
  const cutting = [...parseMoves(code)].filter((m) => !m.rapid);
  if (!cutting.length) return { tabs: 0, regions: [] };

  // Deepest Z reached near each point on the perimeter.
  const cell = 1.0;
  const deepest = new Map();
  for (const move of cutting) {
    const key = `${Math.round(move.to.x / cell)}:${Math.round(move.to.y / cell)}`;
    const current = deepest.get(key);
    if (current === undefined || move.to.z < current.z) deepest.set(key, { z: move.to.z, x: move.to.x, y: move.to.y });
  }

  const held = [...deepest.values()].filter((entry) => entry.z > -throughDepthMm + tolerance);
  if (!held.length) return { tabs: 0, regions: [], heldCells: 0, totalCells: deepest.size };

  // Cluster the held cells into contiguous regions.
  const remaining = [...held];
  const regions = [];
  while (remaining.length) {
    const seed = remaining.shift();
    const region = [seed];
    let grew = true;
    while (grew) {
      grew = false;
      for (let i = remaining.length - 1; i >= 0; i -= 1) {
        if (region.some((p) => Math.hypot(p.x - remaining[i].x, p.y - remaining[i].y) <= cell * 1.5)) {
          region.push(remaining.splice(i, 1)[0]);
          grew = true;
        }
      }
    }
    regions.push({
      cells: region.length,
      shallowestZ: Math.max(...region.map((p) => p.z)),
      centroid: {
        x: region.reduce((s, p) => s + p.x, 0) / region.length,
        y: region.reduce((s, p) => s + p.y, 0) / region.length,
      },
    });
  }

  return { tabs: regions.length, regions, heldCells: held.length, totalCells: deepest.size };
}
