// Stage generators.
//
// Each returns { code, cut(s), metrics }. None of them contains a literal feed:
// every feed comes from solveCut(), and a stage whose computed chip load would
// plough throws UnmachinableStageError instead of emitting a program.

import { MACHINE } from "./machine-library.mjs";
import { ProgramBuilder, linearize } from "./program.mjs";
import { assertFeedDeliverable, rampFeed, solveCut, solveSharedGear, UnmachinableStageError } from "./feeds-speeds.mjs";
import { depthField, discErode, discDilate } from "./morphology.mjs";
import { offsetPolygon, polygonPerimeterMm, pointInPolygon } from "./relief-model.mjs";
import { TOOLS, sweepRadiusMm } from "./tool-library.mjs";

const MATERIAL = "c752-nickel-silver";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function partMask(model, partEdge, marginMm) {
  const grown = marginMm ? offsetPolygon(partEdge, marginMm) : partEdge;
  const mask = new Uint8Array(model.cols * model.rows);
  for (let r = 0; r < model.rows; r += 1) {
    const y = model.yOf(r);
    for (let c = 0; c < model.cols; c += 1) {
      if (pointInPolygon(grown, model.xOf(c), y)) mask[r * model.cols + c] = 1;
    }
  }
  return mask;
}

/**
 * Build boustrophedon raster rows over a mask, splitting each row into the
 * contiguous runs where the mask is set so the tool never traverses outside the
 * region while down.
 */
function rasterRuns(model, mask, stepoverMm, startY, endY) {
  const runs = [];
  const rowCount = Math.floor((endY - startY) / stepoverMm) + 1;
  for (let k = 0; k < rowCount; k += 1) {
    const y = startY + k * stepoverMm;
    const row = model.rowOf(y);
    if (row < 0 || row >= model.rows) continue;
    const base = row * model.cols;
    let runStart = -1;
    const rowRuns = [];
    for (let c = 0; c < model.cols; c += 1) {
      const on = mask[base + c] === 1;
      if (on && runStart < 0) runStart = c;
      if ((!on || c === model.cols - 1) && runStart >= 0) {
        const last = on ? c : c - 1;
        if (last > runStart) rowRuns.push({ y, x0: model.xOf(runStart), x1: model.xOf(last) });
        runStart = -1;
      }
    }
    if (k % 2 === 1) rowRuns.reverse();
    for (const run of rowRuns) runs.push(k % 2 === 1 ? { ...run, x0: run.x1, x1: run.x0 } : run);
  }
  return runs;
}

function meanSegmentLength(metrics, cuttingLines) {
  return cuttingLines > 0 ? metrics.cutDistanceMm / cuttingLines : 0;
}

// ---------------------------------------------------------------------------
// ROUGH — flat-tool Z-level clearing of everything the 1/8" cutter can reach
// ---------------------------------------------------------------------------

export function generateRough(context) {
  const {
    model,
    partEdge,
    plate,
    stock,
    stockToLeaveMm,
    toolId = "spetool-w03010",
    axialDepthMm: axial = 0.15,
    // 25%, not the 50% this stage used to ask for. The tool library caps this
    // cutter at 25% radial engagement on metal under the operator's "no small
    // bits on metal" rule, and until 2026-10-01 nothing checked it -- so Rough
    // was quietly stepping over at twice the tool's own declared limit. Halving
    // the stepover roughly doubles Rough's path length, but Rough is the
    // cheapest stage in the job, so the cost is a few minutes.
    stepoverFraction = 0.25,
  } = context;
  const toolSpec = TOOLS[toolId];
  const radius = toolSpec.diameterMm / 2;
  const stepover = toolSpec.diameterMm * stepoverFraction;

  const cut = solveCut({
    stage: "rough",
    toolId,
    materialId: MATERIAL,
    axialDepthMm: axial,
    radialEngagementMm: stepover,
  });
  const entryFeed = rampFeed(cut, 0.4);

  // Depth the tool CENTRE can reach: erosion of the relief by the tool disc.
  const radiusCells = Math.round(radius / model.gridMm);
  const centreDepth = discErode(depthField(model), model.cols, model.rows, radiusCells);
  const inside = partMask(model, partEdge, -radius);

  // Deepest level worth cutting, after leaving stock for the finish tool.
  let maxCentre = 0;
  for (let i = 0; i < centreDepth.length; i += 1) {
    if (inside[i] && centreDepth[i] > maxCentre) maxCentre = centreDepth[i];
  }
  const maxRough = Math.max(0, maxCentre - stockToLeaveMm);
  if (maxRough <= axial * 0.5) {
    throw new UnmachinableStageError(
      "rough",
      `a ${toolSpec.diameterMm} mm flat cutter can only reach ${maxCentre.toFixed(3)} mm into this relief, which leaves ${maxRough.toFixed(3)} mm after the ${stockToLeaveMm} mm finish allowance. Roughing would remove nothing.`,
    );
  }
  const builder = new ProgramBuilder({
    stage: "rough",
    plateThicknessMm: plate.thicknessMm,
    plateConfirmed: plate.confirmed,
    stockThicknessMm: stock.thicknessMm,
    maxDepthMm: maxRough + 1e-6,
  });
  builder.comment(`ROUGH ${toolSpec.name}`);
  builder.comment(`manual router gear ${cut.gear} approx ${cut.rpmNominal} rpm - set it by hand`);
  builder.comment(`3D offset, <=${axial} mm per layer, ${stepover} mm stepover, leaving ${stockToLeaveMm} mm`);

  // A terraced Z-level rough throws away everything shallower than one level,
  // which on a relief this fine is nearly all of it: levelled roughing removed
  // 1.5% of the relief where the tool can actually reach 25%. So follow the
  // reachable surface itself, in layers bounded by the axial limit.
  //
  // The erosion is eroded once more by a cell so a nearest-cell lookup stays
  // valid anywhere inside that cell; a cell of conservatism is immaterial
  // against a 0.12 mm finish allowance.
  const safeCentre = discErode(centreDepth, model.cols, model.rows, 1);
  const target = new Float32Array(model.cols * model.rows);
  for (let i = 0; i < target.length; i += 1) {
    target[i] = inside[i] ? Math.max(0, safeCentre[i] - stockToLeaveMm) : 0;
  }

  let cuttingLines = 0;
  let layers = 0;
  const surface = new Float32Array(model.cols * model.rows);
  for (let layer = 1; ; layer += 1) {
    let anyWork = false;
    for (let i = 0; i < target.length; i += 1) {
      if (target[i] - surface[i] > 1e-4) {
        anyWork = true;
        break;
      }
    }
    if (!anyWork) break;
    if (layer > 30) throw new UnmachinableStageError("rough", "layering did not converge");

    const mask = new Uint8Array(model.cols * model.rows);
    for (let i = 0; i < mask.length; i += 1) {
      if (target[i] - surface[i] > 1e-4) mask[i] = 1;
    }
    const limitAt = (x, y) => {
      const cell = model.rowOf(y) * model.cols + model.colOf(x);
      return -Math.min(target[cell] ?? 0, (surface[cell] ?? 0) + axial);
    };
    cuttingLines += emitRaster(builder, model, mask, limitAt, stepover, cut, entryFeed, 0.01);
    for (let i = 0; i < surface.length; i += 1) {
      if (mask[i]) surface[i] = Math.min(target[i], surface[i] + axial);
    }
    layers = layer;
  }

  const code = builder.finish();
  const metrics = builder.metrics();
  const deliverable = assertFeedDeliverable(cut, meanSegmentLength(metrics, cuttingLines), MACHINE.programLinesPerSecond);

  return {
    stage: "rough",
    tool: toolSpec,
    code,
    cuts: [cut],
    levels: layers,
    levelDepthMm: axial,
    stockToLeaveMm,
    metrics: { ...metrics, deliverableFeedMmPerMin: deliverable },
  };
}

// ---------------------------------------------------------------------------
// FINISH — tapered ball nose, bulk layers then the detail pass, one tool
// ---------------------------------------------------------------------------

export function generateFinish(context) {
  const {
    model,
    partEdge,
    plate,
    stock,
    roughedSurface,
    toolId = "spetool-w01015-spe-x",
    detailStepoverMm = 0.16,
    bulkStepoverMm = 0.6,
    maxLayerDepthMm = 0.25,
    linearizeToleranceMm = 0.004,
    maxFeedMmPerMin = 550,
  } = context;

  const toolSpec = TOOLS[toolId];
  const maxDepth = model.stats().maxDepthMm;

  // The router gear is set by hand once for the whole stage, so both phases
  // must be solvable at the same gear.
  const shared = solveSharedGear([
    {
      stage: "finish-bulk",
      toolId,
      materialId: MATERIAL,
      axialDepthMm: maxLayerDepthMm,
      radialEngagementMm: bulkStepoverMm,
      maxFeedMmPerMin,
    },
    {
      stage: "finish-detail",
      toolId,
      materialId: MATERIAL,
      axialDepthMm: maxLayerDepthMm / 2,
      radialEngagementMm: detailStepoverMm,
      maxFeedMmPerMin,
    },
  ]);
  const [bulkCut, detailCut] = shared.cuts;
  const entryFeed = rampFeed(detailCut, 0.35);

  // Drop-cutter Z for the tool tip at every grid cell, precomputed once.
  //
  // The field is evaluated at cell centres, but the toolpath visits continuous
  // positions and looks the field up by nearest cell. Between cells the real
  // limit can be shallower than the cell's value, so the tool would dip below
  // the design by up to one gradient step. Eroding the field by one cell makes
  // every lookup valid for any position inside that cell.
  const tipZ = dropCutterField(model, toolSpec, maxDepth);
  const dropCutterAt = makeDropCutter(model, toolSpec, maxDepth);
  const inside = partMask(model, partEdge, sweepRadiusMm(toolSpec, maxDepth));

  // Material actually present when this stage starts: the relief that Rough
  // could not reach, expressed as depth already removed at each cell.
  const alreadyRemoved = roughedSurface || new Float32Array(model.cols * model.rows);

  const attempt = (tolerance) => {
    const builder = new ProgramBuilder({
      stage: "finish",
      plateThicknessMm: plate.thicknessMm,
      plateConfirmed: plate.confirmed,
      stockThicknessMm: stock.thicknessMm,
      maxDepthMm: maxDepth + 1e-6,
    });
    builder.comment(`FINISH ${toolSpec.name}`);
    builder.comment(`manual router gear ${bulkCut.gear} approx ${bulkCut.rpmNominal} rpm - set it by hand`);
    builder.comment(`bulk ${bulkStepoverMm} mm stepover then detail ${detailStepoverMm} mm, max ${maxLayerDepthMm} mm per layer`);
    builder.comment(`path linearised to ${tolerance.toFixed(4)} mm`);

    let cuttingLines = 0;
    const layerReport = [];

    // --- bulk layers -----------------------------------------------------
    // Each layer clamps the tool to at most maxLayerDepthMm below the surface
    // left by the previous layer, so axial engagement is bounded everywhere.
    // This is what the separate Cleanup stage used to provide.
    const surface = new Float32Array(alreadyRemoved);
    for (let layer = 1; ; layer += 1) {
      const limit = new Float32Array(model.cols * model.rows);
      let anyWork = false;
      for (let i = 0; i < limit.length; i += 1) {
        const target = -tipZ[i];
        limit[i] = Math.min(target, surface[i] + maxLayerDepthMm);
        if (inside[i] && target - surface[i] > maxLayerDepthMm + 1e-6) anyWork = true;
      }
      if (!anyWork) break;
      if (layer > 20) throw new UnmachinableStageError("finish", "bulk layering did not converge");

      const mask = new Uint8Array(model.cols * model.rows);
      let area = 0;
      for (let i = 0; i < mask.length; i += 1) {
        if (inside[i] && limit[i] - surface[i] > 1e-4) {
          mask[i] = 1;
          area += model.gridMm * model.gridMm;
        }
      }
      const bulkLimitAt = (x, y) => {
        const cell = model.rowOf(y) * model.cols + model.colOf(x);
        return Math.max(dropCutterAt(x, y), -(surface[cell] + maxLayerDepthMm));
      };
      cuttingLines += emitRaster(builder, model, mask, bulkLimitAt, bulkStepoverMm, bulkCut, entryFeed, tolerance);
      layerReport.push({ layer, kind: "bulk", areaMm2: area, stepoverMm: bulkStepoverMm });
      for (let i = 0; i < surface.length; i += 1) if (mask[i]) surface[i] = limit[i];
    }

    // --- detail pass -----------------------------------------------------
    const finalLimit = new Float32Array(model.cols * model.rows);
    for (let i = 0; i < finalLimit.length; i += 1) finalLimit[i] = -tipZ[i];
    let finalArea = 0;
    for (let i = 0; i < inside.length; i += 1) if (inside[i]) finalArea += model.gridMm * model.gridMm;
    cuttingLines += emitRaster(builder, model, inside, dropCutterAt, detailStepoverMm, detailCut, entryFeed, tolerance);
    layerReport.push({ layer: layerReport.length + 1, kind: "detail", areaMm2: finalArea, stepoverMm: detailStepoverMm });

    const code = builder.finish();
    const metrics = builder.metrics();
    return { code, metrics, layerReport, mean: meanSegmentLength(metrics, cuttingLines), tolerance };
  };

  // Negotiate the linearisation tolerance against what the controller can
  // actually stream. A tighter tolerance means shorter segments, and below
  // about 0.25 mm per segment the Wi-Fi line rate, not the feed word, decides
  // the real speed -- which silently halves the chip load. Start tight and
  // loosen only as far as needed; every candidate stays far under the machine's
  // own positioning repeatability, so none of them costs visible detail.
  const tolerances = [linearizeToleranceMm, 0.008, 0.012, 0.016, 0.02];
  let chosen = null;
  let lastError = null;
  for (const tolerance of tolerances) {
    const result = attempt(tolerance);
    try {
      result.deliverable = assertFeedDeliverable(detailCut, result.mean, MACHINE.programLinesPerSecond);
      chosen = result;
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!chosen) throw lastError;

  return {
    stage: "finish",
    tool: toolSpec,
    code: chosen.code,
    cuts: [bulkCut, detailCut],
    layers: chosen.layerReport,
    linearizeToleranceMm: chosen.tolerance,
    gearsRejected: shared.rejectedGears,
    metrics: { ...chosen.metrics, meanSegmentMm: chosen.mean, deliverableFeedMmPerMin: chosen.deliverable },
  };
}

function dropCutterField(model, toolSpec, maxDepthMm) {
  // The drop-cutter constraint tipZ >= -(depth + offset) over the footprint is a
  // greyscale dilation of the depth field by the tool's own profile, so it can
  // be computed for the whole grid at once instead of per query.
  //
  // The footprint must be at least as wide as the tool can actually sweep. A
  // footprint one cell too narrow leaves an unconstrained annulus where the
  // taper flank still dips below the surface, and the tool quietly gouges by
  // the depth of that annulus -- 0.12 mm here before this margin was added.
  const radius = sweepRadiusMm(toolSpec, maxDepthMm + 0.2);
  const cells = Math.ceil(radius / model.gridMm) + 1;
  const depth = depthField(model);
  const out = new Float32Array(model.cols * model.rows);
  // Structuring element: tool profile offset at each cell displacement.
  const span = cells * 2 + 1;
  const element = new Float32Array(span * span).fill(Number.NaN);
  for (let j = -cells; j <= cells; j += 1) {
    for (let i = -cells; i <= cells; i += 1) {
      const d = Math.hypot(i * model.gridMm, j * model.gridMm);
      const offset = profileOffset(toolSpec, d);
      if (offset !== null) element[(j + cells) * span + (i + cells)] = offset;
    }
  }
  for (let r = 0; r < model.rows; r += 1) {
    for (let c = 0; c < model.cols; c += 1) {
      let tip = Number.NEGATIVE_INFINITY;
      for (let j = -cells; j <= cells; j += 1) {
        const rr = r + j;
        if (rr < 0 || rr >= model.rows) continue;
        const elementRow = (j + cells) * span + cells;
        const base = rr * model.cols;
        for (let i = -cells; i <= cells; i += 1) {
          const cc = c + i;
          if (cc < 0 || cc >= model.cols) continue;
          const offset = element[elementRow + i];
          if (!(offset >= 0)) continue;
          const constraint = -depth[base + cc] - offset;
          if (constraint > tip) tip = constraint;
        }
      }
      out[r * model.cols + c] = Number.isFinite(tip) ? Math.min(0, tip) : 0;
    }
  }
  return out;
}

/**
 * Exact drop-cutter query at a CONTINUOUS position.
 *
 * The per-cell field is right for deciding masks and layer limits, but the
 * toolpath visits positions between cells. Looking the field up by nearest cell
 * lets the tool dip below the design by one gradient step; eroding the field
 * instead costs real depth everywhere. Evaluating the constraint at the actual
 * position is exact and costs one footprint scan per sampled point.
 */
function makeDropCutter(model, toolSpec, maxDepthMm) {
  const radius = sweepRadiusMm(toolSpec, maxDepthMm + 0.2);
  const cells = Math.ceil(radius / model.gridMm) + 1;
  const depth = depthField(model);
  return (x, y) => {
    const c0 = model.colOf(x);
    const r0 = model.rowOf(y);
    let tip = Number.NEGATIVE_INFINITY;
    for (let j = -cells; j <= cells; j += 1) {
      const rr = r0 + j;
      if (rr < 0 || rr >= model.rows) continue;
      const dy = model.yOf(rr) - y;
      const base = rr * model.cols;
      for (let i = -cells; i <= cells; i += 1) {
        const cc = c0 + i;
        if (cc < 0 || cc >= model.cols) continue;
        const offset = profileOffset(toolSpec, Math.hypot(model.xOf(cc) - x, dy));
        if (offset === null) continue;
        const constraint = -depth[base + cc] - offset;
        if (constraint > tip) tip = constraint;
      }
    }
    return Number.isFinite(tip) ? Math.min(0, tip) : 0;
  };
}

function profileOffset(toolSpec, d) {
  if (toolSpec.geometry === "tapered-ball") {
    const r = toolSpec.tipRadiusMm;
    const taper = (toolSpec.taperHalfAngleDeg * Math.PI) / 180;
    const tangent = r * Math.cos(taper);
    if (d <= tangent) return r - Math.sqrt(Math.max(0, r * r - d * d));
    return r + (d - r / Math.cos(taper)) / Math.tan(taper);
  }
  if (toolSpec.geometry === "flat") return d <= toolSpec.diameterMm / 2 ? 0 : null;
  throw new Error(`no profile for ${toolSpec.id}`);
}

/** Sample a tip-Z limit function along a straight XY path. */
function samplePath(model, limitAt, from, to) {
  const length = Math.hypot(to.x - from.x, to.y - from.y);
  const steps = Math.max(1, Math.round(length / model.gridMm));
  const points = [];
  for (let s = 0; s <= steps; s += 1) {
    const t = s / steps;
    const x = from.x + (to.x - from.x) * t;
    const y = from.y + (to.y - from.y) * t;
    points.push({ x, y, z: Math.min(0, limitAt(x, y)) });
  }
  return points;
}

function emitRaster(builder, model, mask, limitAt, stepover, cut, entryFeed, tolerance) {
  const runs = rasterRuns(model, mask, stepover, model.bounds.minY, model.bounds.maxY);
  let emitted = 0;
  let engaged = false;
  let previousEnd = null;

  // Linking adjacent rows instead of retracting between them is what keeps a
  // 3D raster affordable. Each retract/travel/ramp cycle costs several lines
  // and a slow entry, and at 400 rows that overhead was about a third of the
  // whole stage. A link is only taken when the next row starts close enough
  // that the connecting move stays inside ground the tool has already cleared.
  const maxLinkMm = stepover * 2.5;

  for (const run of runs) {
    const points = samplePath(model, limitAt, { x: run.x0, y: run.y }, { x: run.x1, y: run.y });
    if (points.length < 2) continue;
    const reduced = linearize(points, tolerance);
    if (reduced.length < 2) continue;

    const linkable =
      engaged && previousEnd && Math.hypot(reduced[0].x - previousEnd.x, reduced[0].y - previousEnd.y) <= maxLinkMm;

    if (linkable) {
      const link = linearize(samplePath(model, limitAt, previousEnd, reduced[0]), tolerance);
      for (let i = 1; i < link.length; i += 1) {
        builder.cutTo(link[i].x, link[i].y, link[i].z, cut.feedMmPerMin);
        emitted += 1;
      }
    } else {
      builder.retract();
      builder.travelTo(reduced[0].x, reduced[0].y);
      builder.approach(0.2);
      // Ramp in along the start of the run, following the surface so the
      // lead-in cannot cut through anything standing proud between its ends.
      let leadLength = 0;
      const lead = [reduced[0]];
      for (let i = 1; i < reduced.length && leadLength < 10; i += 1) {
        leadLength += Math.hypot(reduced[i].x - reduced[i - 1].x, reduced[i].y - reduced[i - 1].y);
        lead.push(reduced[i]);
      }
      const before = builder.lines.length;
      builder.rampEntryAlong(lead, entryFeed, { maxAngleDeg: 20 });
      emitted += builder.lines.length - before;
      engaged = true;
    }

    for (let i = 0; i < reduced.length; i += 1) {
      builder.cutTo(reduced[i].x, reduced[i].y, reduced[i].z, cut.feedMmPerMin);
      emitted += 1;
    }
    previousEnd = reduced[reduced.length - 1];
  }
  if (engaged) builder.retract();
  return emitted;
}

// ---------------------------------------------------------------------------
// PROFILE — trochoidal through-cut leaving discrete tabs
// ---------------------------------------------------------------------------

export function generateProfile(context) {
  const {
    partEdge,
    plate,
    stock,
    sacrificialDepthMm = 0.1,
    tabCount = 6,
    tabWidthMm = 4,
    tabHeightMm = 0.8,
    trochoidalKerfMm = 4.2,
    trochoidalStepMm = 0.5,
    toolId = "spetool-w03010",
  } = context;

  const toolSpec = TOOLS[toolId];
  const throughDepth = stock.thicknessMm + sacrificialDepthMm;
  if (throughDepth > toolSpec.cuttingLengthMm) {
    throw new UnmachinableStageError("profile", `through depth ${throughDepth} mm exceeds the ${toolSpec.cuttingLengthMm} mm flute length`);
  }

  const axial = Math.min(toolSpec.diameterMm * toolSpec.maxAxialFractionOfDiameter, throughDepth);
  const levels = Math.ceil(throughDepth / axial);
  const levelDepth = throughDepth / levels;

  const cut = solveCut({
    stage: "profile",
    toolId,
    materialId: MATERIAL,
    axialDepthMm: levelDepth,
    radialEngagementMm: trochoidalStepMm,
  });
  const entryFeed = rampFeed(cut, 0.4);

  // Cutter-centre path: the part edge plus one tool radius, so the kerf lies in
  // the waste and the part keeps its outline.
  const centre = resample(offsetPolygon(partEdge, toolSpec.diameterMm / 2), 0.4);
  const perimeter = polygonPerimeterMm(centre);
  const tabs = planTabs(centre, perimeter, tabCount, tabWidthMm);

  const builder = new ProgramBuilder({
    stage: "profile",
    plateThicknessMm: plate.thicknessMm,
    plateConfirmed: plate.confirmed,
    stockThicknessMm: stock.thicknessMm,
    maxDepthMm: throughDepth + 1e-6,
  });
  builder.comment(`PROFILE ${toolSpec.name}`);
  builder.comment(`manual router gear ${cut.gear} approx ${cut.rpmNominal} rpm - set it by hand`);
  builder.comment(`trochoidal kerf ${trochoidalKerfMm} mm, ${trochoidalStepMm} mm radial, ${levels} levels x ${levelDepth.toFixed(3)} mm`);
  builder.comment(`${tabs.length} tabs ${tabWidthMm} mm wide x ${tabHeightMm} mm high, removed by the Release stage`);

  const loopRadius = Math.max(0.05, (trochoidalKerfMm - toolSpec.diameterMm) / 2);
  let cuttingLines = 0;

  for (let level = 1; level <= levels; level += 1) {
    const z = -Math.min(throughDepth, level * levelDepth);
    const tabFloor = -(throughDepth - tabHeightMm);
    const path = trochoidalPath(centre, loopRadius, trochoidalStepMm);

    let open = false;
    for (const node of path) {
      const inTab = tabs.some((tab) => withinTab(tab, node.s, perimeter));
      const nodeZ = inTab ? Math.max(z, tabFloor) : z;
      if (inTab && nodeZ >= tabFloor && z < tabFloor) {
        // Level is below the tab floor: hold the tab, do not cut here.
        if (open) {
          builder.retract();
          open = false;
        }
        continue;
      }
      if (!open) {
        builder.retract();
        builder.travelTo(node.x, node.y);
        builder.approach(0.2);
        const ramp = rampSegment(path, node, 20);
        builder.rampTo(ramp, nodeZ, entryFeed, { maxAngleDeg: 12 });
        open = true;
        cuttingLines += 1;
      }
      builder.cutTo(node.x, node.y, nodeZ, cut.feedMmPerMin);
      cuttingLines += 1;
    }
    if (open) builder.retract();
  }

  const code = builder.finish();
  const metrics = builder.metrics();
  const deliverable = assertFeedDeliverable(cut, meanSegmentLength(metrics, cuttingLines), MACHINE.programLinesPerSecond);

  return {
    stage: "profile",
    tool: toolSpec,
    code,
    cuts: [cut],
    levels,
    levelDepthMm: levelDepth,
    throughDepthMm: throughDepth,
    tabs,
    perimeterMm: perimeter,
    // The TRUE swept kerf, and the number Release must clear. It is exact by
    // construction: the trochoidal loop radius is derived from this value as
    // (kerf - diameter)/2, so the swept band is diameter + 2*loopRadius = this.
    //
    // Do NOT replace it with the kerfWidthMm that assertNoFullImmersionSlotting
    // reports (about 4.75 mm). That measures the widest spread of cutter-centre
    // points inside a coarse bucket, so it adds the forward travel through the
    // bucket to the loop width. It is the right heuristic for "is this a slot?"
    // and the wrong number for "how much material is there to clear".
    kerfWidthMm: trochoidalKerfMm,
    radialEngagementFraction: trochoidalStepMm / toolSpec.diameterMm,
    metrics: { ...metrics, deliverableFeedMmPerMin: deliverable },
  };
}

// ---------------------------------------------------------------------------
// RELEASE — remove the tabs, last cut first retract, no post-separation travel
// ---------------------------------------------------------------------------

export function generateRelease(context) {
  const { profile, plate, stock, toolId = "spetool-w03010", passes = 4 } = context;
  const toolSpec = TOOLS[toolId];
  const { tabs, throughDepthMm, tabHeightMm = 0.8, kerfWidthMm = 4.2 } = profile;
  if (!tabs || tabs.length < 2) throw new UnmachinableStageError("release", "profile produced no tabs to remove");

  // THE TAB IS WIDER THAN THE CUTTER. Profile opens a kerf of kerfWidthMm and
  // leaves the last tabHeightMm of it solid, so the remnant spans the WHOLE
  // kerf. Running the cutter down the centreline alone removes only its own
  // diameter and leaves a sliver (kerf - diameter)/2 wide on each side -- 0.51
  // mm of nickel silver, 0.8 mm tall, six times over. The part would not come
  // free; it would have to be broken out of the sheet by hand, on a wedding
  // piece, after the cut. Each tab is therefore cleared in lanes: centreline
  // first, then one lane either side.
  const sliverMm = Math.max(0, (kerfWidthMm - toolSpec.diameterMm) / 2);
  const lanes = sliverMm < 0.02 ? [0] : [0, sliverMm, -sliverMm];

  const axial = tabHeightMm / passes;
  const { cuts: [cut, laneCut] } = solveSharedGear([
    {
      stage: "release",
      toolId,
      materialId: MATERIAL,
      axialDepthMm: axial,
      // Full width on the centreline: a tab remnant has no side to escape to.
      // This is the one declared slotting exemption to the light-engagement
      // rule, and it is why the halved slotting chip-load band is named here.
      radialEngagementMm: toolSpec.diameterMm,
      chipLoadClass: "single-flute-oflute-slotting",
    },
    {
      // The side lanes take the full remaining tab height in one pass, because
      // by then they are only removing a sliver.
      stage: "release-kerf",
      toolId,
      materialId: MATERIAL,
      axialDepthMm: Math.max(axial, tabHeightMm),
      radialEngagementMm: Math.max(0.05, sliverMm),
    },
  ]);
  const entryFeed = rampFeed(cut, 0.4);

  const builder = new ProgramBuilder({
    stage: "release",
    plateThicknessMm: plate.thicknessMm,
    plateConfirmed: plate.confirmed,
    stockThicknessMm: stock.thicknessMm,
    maxDepthMm: throughDepthMm + 1e-6,
  });
  builder.comment(`RELEASE ${toolSpec.name}`);
  builder.comment(`manual router gear ${cut.gear} approx ${cut.rpmNominal} rpm - set it by hand`);
  builder.comment("the buckle must be independently secured to the sacrificial backing before this stage");
  builder.comment(`${tabs.length} tabs, each ramped through ${tabHeightMm} mm at <=${axial.toFixed(3)} mm per pass`);

  const tabFloor = -(throughDepthMm - tabHeightMm);
  let cuttingLines = 0;

  tabs.forEach((tab, index) => {
    const last = index === tabs.length - 1;
    builder.comment(last ? "final tab - the part becomes free on this cut" : `tab ${index + 1} of ${tabs.length}`);
    builder.retract();
    builder.travelTo(tab.points[0].x, tab.points[0].y);
    builder.approach(0.2);

    // Descend through the slot Profile already opened. This is air if Profile
    // completed, but it runs at cutting feed on a ramp rather than as a rapid,
    // so an incompletely cut slot is simply machined instead of crashed into.
    // A stage timestamp is not proof that the slot is open.
    builder.rampTo(tab.points, tabFloor, entryFeed, { maxAngleDeg: 25, maxDropPerPassMm: 1.0 });
    cuttingLines += tab.points.length * Math.ceil(3.355 / 1.0);

    // Now the tab itself, in bounded passes.
    builder.rampTo(tab.points, -throughDepthMm, cut.feedMmPerMin, { maxAngleDeg: 10, maxDropPerPassMm: axial });
    cuttingLines += tab.points.length * passes;

    // A ramp only reaches full depth at the end of its last pass, so the
    // leading part of the tab would still be attached and the part would not
    // actually come free. Traverse the whole tab once more at full depth, then
    // sweep the lanes either side so the full kerf width is cleared.
    for (let lane = 0; lane < lanes.length; lane += 1) {
      const path = offsetAlong(tab.points, lanes[lane]);
      const head = path[0];
      const atTail = Math.hypot(builder.x - path[path.length - 1].x, builder.y - path[path.length - 1].y) < 1e-4;
      const level = atTail ? [...path].reverse() : path;
      if (lane > 0) {
        // Step sideways onto the next lane at depth. The move is short and the
        // cutter is already through, so it is a cut, never a rapid.
        builder.cutTo(level[0].x, level[0].y, -throughDepthMm, laneCut.feedMmPerMin);
        cuttingLines += 1;
      } else if (Math.hypot(builder.x - head.x, builder.y - head.y) > 1e-4 && !atTail) {
        builder.cutTo(head.x, head.y, -throughDepthMm, cut.feedMmPerMin);
        cuttingLines += 1;
      }
      const feed = lane === 0 ? cut.feedMmPerMin : laneCut.feedMmPerMin;
      for (let i = 1; i < level.length; i += 1) {
        builder.cutTo(level[i].x, level[i].y, -throughDepthMm, feed);
        cuttingLines += 1;
      }
    }

    // Vertical retract immediately: on the last tab the part is now loose and
    // any XY motion would drag the cutter through a free piece of metal.
    builder.retract();
  });

  const code = builder.finish();
  const metrics = builder.metrics();
  const deliverable = assertFeedDeliverable(cut, meanSegmentLength(metrics, cuttingLines), MACHINE.programLinesPerSecond);

  return {
    stage: "release",
    tool: toolSpec,
    code,
    cuts: [cut, laneCut],
    tabs: tabs.length,
    lanesPerTab: lanes.length,
    kerfClearedMm: lanes.length === 1 ? toolSpec.diameterMm : toolSpec.diameterMm + 2 * sliverMm,
    metrics: { ...metrics, deliverableFeedMmPerMin: deliverable },
  };
}

/**
 * Shift a short open polyline sideways by distanceMm, along its own normals.
 *
 * Used to sweep the lanes either side of a tab centreline. The tab is a few
 * millimetres of a smooth outline and the offsets are well under a millimetre,
 * so per-vertex normals are accurate here; this is not a general offsetter.
 */
export function offsetAlong(points, distanceMm) {
  if (!distanceMm) return points.map((p) => ({ ...p }));
  return points.map((point, index) => {
    const prev = points[Math.max(0, index - 1)];
    const next = points[Math.min(points.length - 1, index + 1)];
    const dx = next.x - prev.x;
    const dy = next.y - prev.y;
    const length = Math.hypot(dx, dy) || 1;
    return { x: point.x + (dy / length) * distanceMm, y: point.y - (dx / length) * distanceMm };
  });
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

export function resample(points, spacingMm) {
  const out = [];
  let carry = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length < 1e-9) continue;
    let t = carry;
    while (t < length) {
      out.push({ x: a.x + ((b.x - a.x) * t) / length, y: a.y + ((b.y - a.y) * t) / length });
      t += spacingMm;
    }
    carry = t - length;
  }
  return out;
}

export function planTabs(centre, perimeter, count, widthMm) {
  const tabs = [];
  const cumulative = [];
  let total = 0;
  for (let i = 0; i < centre.length; i += 1) {
    cumulative.push(total);
    const a = centre[i];
    const b = centre[(i + 1) % centre.length];
    total += Math.hypot(b.x - a.x, b.y - a.y);
  }
  for (let k = 0; k < count; k += 1) {
    const s = (perimeter * (k + 0.5)) / count;
    const half = widthMm / 2;
    const points = [];
    for (let i = 0; i < centre.length; i += 1) {
      const distance = circularDistance(cumulative[i], s, perimeter);
      if (distance <= half) points.push({ ...centre[i], s: cumulative[i] });
    }
    if (points.length < 2) continue;
    tabs.push({ index: k, centreS: s, widthMm, points: points.map(({ x, y }) => ({ x, y })) });
  }
  return tabs;
}

function circularDistance(a, b, period) {
  const d = Math.abs(a - b) % period;
  return Math.min(d, period - d);
}

export function withinTab(tab, s, perimeter) {
  return circularDistance(s, tab.centreS, perimeter) <= tab.widthMm / 2;
}

/**
 * Trochoidal slot path: the cutter advances along the contour while looping, so
 * radial engagement is the advance per loop rather than the full tool diameter.
 * Returns nodes carrying their arc position `s` so tabs can be skipped.
 */
export function trochoidalPath(centre, loopRadiusMm, stepMm) {
  const nodes = [];
  let s = 0;
  const cumulative = [];
  let total = 0;
  for (let i = 0; i < centre.length; i += 1) {
    cumulative.push(total);
    const a = centre[i];
    const b = centre[(i + 1) % centre.length];
    total += Math.hypot(b.x - a.x, b.y - a.y);
  }
  const pointsPerLoop = Math.max(8, Math.ceil((2 * Math.PI * loopRadiusMm) / 0.4));
  while (s < total) {
    const { point, normal } = alongContour(centre, cumulative, total, s);
    for (let k = 0; k < pointsPerLoop; k += 1) {
      const angle = (2 * Math.PI * k) / pointsPerLoop;
      nodes.push({
        x: point.x + normal.x * loopRadiusMm * Math.cos(angle) + normal.tx * loopRadiusMm * Math.sin(angle),
        y: point.y + normal.y * loopRadiusMm * Math.cos(angle) + normal.ty * loopRadiusMm * Math.sin(angle),
        s,
      });
    }
    s += stepMm;
  }
  return nodes;
}

function alongContour(centre, cumulative, total, s) {
  const target = s % total;
  let index = 0;
  while (index < cumulative.length - 1 && cumulative[index + 1] <= target) index += 1;
  const a = centre[index];
  const b = centre[(index + 1) % centre.length];
  const segment = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const t = (target - cumulative[index]) / segment;
  const tx = (b.x - a.x) / segment;
  const ty = (b.y - a.y) / segment;
  return {
    point: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t },
    normal: { x: -ty, y: tx, tx, ty },
  };
}

function rampSegment(path, node, count) {
  const index = path.indexOf(node);
  const points = [];
  for (let i = 0; i < count; i += 1) points.push(path[(index + i) % path.length]);
  return points.map(({ x, y }) => ({ x, y }));
}
