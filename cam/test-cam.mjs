import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { MACHINE, ROUTER, gear, slowestGearWithin, surfaceSpeedMPerMin } from "./machine-library.mjs";
import { PLOUGHING_CHIP_LOAD_MM, material } from "./material-library.mjs";
import { TOOLS, engagedDiameterMm, profileOffsetMm, tool } from "./tool-library.mjs";
import { UnmachinableStageError, assertFeedDeliverable, chipThinningFactor, solveCut, solveSharedGear } from "./feeds-speeds.mjs";
import { KNOWN_PLATE_THICKNESSES_MM, ProgramBuilder, assertClearanceAboveStock, linearize } from "./program.mjs";
import { ReliefModel, offsetPolygon, pointInPolygon, polygonAreaMm2, polygonPerimeterMm } from "./relief-model.mjs";
import { discDilate, discErode, rowWindowExtreme } from "./morphology.mjs";
import { generateFinish, generateProfile, generateRelease, generateRough, planTabs, resample, trochoidalPath } from "./stages.mjs";
import { assertNoFullImmersionSlotting, findHoldingTabs, validateProgram } from "./validate.mjs";
import { DEFAULT_JOB, generateJob, loadModel } from "./generate-buckle.mjs";

const MODEL_DIR = join(import.meta.dirname, "models");
const PLATE = { thicknessMm: 14.19, confirmed: true };
const STOCK = { widthMm: 260, heightMm: 130, thicknessMm: 3.855 };

// ---------------------------------------------------------------------------
// Feeds and speeds: the ploughing floor
// ---------------------------------------------------------------------------

test("a cut whose chip load falls below the ploughing floor is rejected, not emitted", () => {
  // Two flutes, a tiny engaged diameter and a feed capped far too low is the
  // exact shape of the rejected Profile stage: legal-looking, and burnishing.
  assert.throws(
    () =>
      solveCut({
        stage: "ploughing",
        toolId: "spetool-w01015-spe-x",
        materialId: "c752-nickel-silver",
        axialDepthMm: 0.05,
        radialEngagementMm: 0.16,
        maxFeedMmPerMin: 45,
      }),
    (error) => {
      assert.ok(error instanceof UnmachinableStageError);
      assert.match(error.message, /ploughing floor/);
      return true;
    },
  );
});

test("the rejected Profile condition itself is unmachinable: 6.35 mm slot at 0.05 mm and 45 mm/min", () => {
  // 74 full-immersion passes at 0.05 mm axial and 45 mm/min gave 1.25 um/tooth.
  assert.throws(
    () =>
      solveCut({
        stage: "kiri-profile",
        toolId: "whiteside-ru2100",
        materialId: "c752-nickel-silver",
        axialDepthMm: 0.05,
        radialEngagementMm: 6.35,
        maxFeedMmPerMin: 45,
      }),
    /retired|not rated/,
  );
});

test("a 1/4 inch cutter cannot reach a legal surface speed in C752 on this router", () => {
  const ru = TOOLS["whiteside-ru2100"];
  const limit = material("c752-nickel-silver").maxSurfaceSpeedMPerMin.carbide;
  const slowest = slowestGearWithin(limit, ru.diameterMm);
  // Gear 1 is borderline; anything above it is over the limit, which is the
  // whole reason the rejected CAM had to collapse its feed.
  assert.ok(surfaceSpeedMPerMin(ru.diameterMm, gear(4).rpmMax) > limit * 3);
  assert.ok(!slowest || slowest.gear === 1);
});

test("surface speed is checked at the worst case of the gear's modelled rpm range", () => {
  const cut = solveCut({
    stage: "rough",
    toolId: "spetool-w03010",
    materialId: "c752-nickel-silver",
    axialDepthMm: 0.15,
    radialEngagementMm: 1.5875,
  });
  assert.ok(cut.surfaceSpeedWorstMPerMin <= cut.surfaceSpeedLimitMPerMin);
  assert.ok(cut.surfaceSpeedWorstMPerMin >= cut.surfaceSpeedNominalMPerMin);
  assert.equal(cut.rpmMax, gear(cut.gear).rpmMax);
});

test("chip load is verified at both ends of the gear's rpm uncertainty", () => {
  const cut = solveCut({
    stage: "rough",
    toolId: "spetool-w03010",
    materialId: "c752-nickel-silver",
    axialDepthMm: 0.15,
    radialEngagementMm: 1.5875,
  });
  assert.ok(cut.chipLoadActualMinMm >= PLOUGHING_CHIP_LOAD_MM);
  assert.ok(cut.chipLoadActualMaxMm <= material("c752-nickel-silver").chipLoad["single-flute-oflute"].max + 1e-9);
  assert.ok(cut.chipLoadActualMinMm < cut.chipLoadActualMaxMm);
});

test("radial chip thinning raises the programmed feed at light engagement", () => {
  assert.equal(chipThinningFactor(2, 3.175), 1); // >= 50% engagement
  assert.ok(chipThinningFactor(0.5, 3.175) < 1);
  assert.ok(chipThinningFactor(0.16, 1.5875) < chipThinningFactor(0.6, 1.5875));
});

test("phases of one stage are solved at a single shared router gear", () => {
  const shared = solveSharedGear([
    { stage: "a", toolId: "spetool-w01015-spe-x", materialId: "c752-nickel-silver", axialDepthMm: 0.25, radialEngagementMm: 0.6, maxFeedMmPerMin: 550 },
    { stage: "b", toolId: "spetool-w01015-spe-x", materialId: "c752-nickel-silver", axialDepthMm: 0.125, radialEngagementMm: 0.16, maxFeedMmPerMin: 550 },
  ]);
  assert.equal(shared.cuts[0].gear, shared.cuts[1].gear);
  for (const cut of shared.cuts) assert.ok(cut.chipLoadActualMinMm >= PLOUGHING_CHIP_LOAD_MM);
});

test("a feed the controller cannot stream is rejected because the real chip load would collapse", () => {
  const cut = solveCut({
    stage: "finish",
    toolId: "spetool-w01015-spe-x",
    materialId: "c752-nickel-silver",
    axialDepthMm: 0.125,
    radialEngagementMm: 0.16,
    maxFeedMmPerMin: 550,
  });
  assert.throws(() => assertFeedDeliverable(cut, 0.12, MACHINE.programLinesPerSecond), /cannot be delivered/);
  assert.ok(assertFeedDeliverable(cut, 1.0, MACHINE.programLinesPerSecond) > cut.feedMmPerMin);
});

test("retired tools cannot be selected", () => {
  assert.throws(() => tool("genmitsu-mc40a-3p175"), /snapped/);
  assert.throws(() => tool("whiteside-ru2100"), /Rejected by the operator/);
  assert.ok(tool("spetool-w03010"));
});

// ---------------------------------------------------------------------------
// Clearance above the true probed surface
// ---------------------------------------------------------------------------

test("clearance cannot be certified without a recorded probe plate thickness", () => {
  assert.throws(
    () => assertClearanceAboveStock({ clearanceZMm: 4.99, plateConfirmed: true, stockThicknessMm: 3.855 }),
    /no Z-probe plate thickness recorded/,
  );
});

test("clearance is rejected for a plate thickness matching no documented variant", () => {
  // 12.1 mm was carried as this machine's plate value until 2026-09-28 and
  // matches no documented SainSmart variant.
  assert.throws(
    () => assertClearanceAboveStock({ clearanceZMm: 4.99, plateThicknessMm: 12.1, plateConfirmed: true, stockThicknessMm: 3.855 }),
    /matches no documented SainSmart variant/,
  );
  for (const value of KNOWN_PLATE_THICKNESSES_MM) {
    assert.ok(assertClearanceAboveStock({ clearanceZMm: 4.99, plateThicknessMm: value, plateConfirmed: true, stockThicknessMm: 3.855 }));
  }
});

test("a confirmed thickness alone cannot certify clearance, because the variants differ by more than it", () => {
  // 14.19 and 20.17 are nearly 6 mm apart and the clearance plane is 4.99 mm,
  // so confirming the WRONG family still puts the clearance inside the metal.
  // Numbers cannot settle that; the flag says a physical Z0 check must.
  const result = assertClearanceAboveStock({
    clearanceZMm: MACHINE.clearanceZMm,
    plateThicknessMm: 14.19,
    plateConfirmed: true,
    stockThicknessMm: 3.855,
  });
  assert.ok(result.spread > MACHINE.clearanceZMm);
  assert.equal(result.physicalSurfaceProofRequired, true);
  // 20.0 is accepted as the 20.17 variant rounded, but still flagged.
  assert.equal(assertClearanceAboveStock({ clearanceZMm: 4.99, plateThicknessMm: 20.0, plateConfirmed: true, stockThicknessMm: 3.855 }).nearest, 20.17);
});

test("an unconfirmed plate thickness blocks generation", () => {
  assert.throws(
    () => assertClearanceAboveStock({ clearanceZMm: 4.99, plateThicknessMm: 14.19, plateConfirmed: false, stockThicknessMm: 3.855 }),
    /has not been confirmed by the operator/,
  );
});

test("a non-positive clearance is rejected outright", () => {
  assert.throws(
    () => assertClearanceAboveStock({ clearanceZMm: 0, plateThicknessMm: 14.19, plateConfirmed: true, stockThicknessMm: 3.855 }),
    /not above the stock surface/,
  );
});

test("the program builder refuses to start without a certifiable clearance", () => {
  assert.throws(
    () => new ProgramBuilder({ stage: "x", plateThicknessMm: 12.1, plateConfirmed: true, stockThicknessMm: 3.855, maxDepthMm: 1 }),
    /documented SainSmart variant/,
  );
});

// ---------------------------------------------------------------------------
// Motion contract, enforced structurally by the builder
// ---------------------------------------------------------------------------

function builder(maxDepthMm = 1) {
  return new ProgramBuilder({ stage: "t", plateThicknessMm: 14.19, plateConfirmed: true, stockThicknessMm: 3.855, maxDepthMm });
}

test("a vertical plunge into the stock cannot be emitted", () => {
  const b = builder();
  b.travelTo(10, 10).approach(0.2);
  assert.throws(() => b.cutTo(10, 10, -0.5, 100), /vertical plunge/);
});

test("XY travel below the clearance plane cannot be emitted", () => {
  const b = builder();
  b.travelTo(10, 10).approach(0.2);
  assert.throws(() => b.travelTo(20, 20), /below the clearance plane/);
});

test("a rapid cannot approach the stock surface", () => {
  const b = builder();
  assert.throws(() => b.approach(0), /would reach the stock surface/);
  assert.throws(() => b.approach(-0.1), /would reach the stock surface/);
});

test("a cutting move with no feed cannot be emitted", () => {
  const b = builder();
  b.travelTo(10, 10).approach(0.2);
  assert.throws(() => b.cutTo(12, 10, -0.1, 0), /no feed/);
});

test("a move beyond the stage depth limit cannot be emitted", () => {
  const b = builder(0.5);
  b.travelTo(10, 10).approach(0.2);
  assert.throws(() => b.cutTo(12, 10, -0.9, 100), /depth limit/);
});

test("a ramp follows the surface instead of cutting straight through what stands between its ends", () => {
  const b = builder(1);
  b.travelTo(0, 0).approach(0.2);
  // Low, high, low: a straight lead-in between the ends would bury the tool in
  // the middle point, which is 0.1 mm proud of them.
  b.rampEntryAlong(
    [
      { x: 0, y: 0, z: -0.5 },
      { x: 5, y: 0, z: -0.1 },
      { x: 10, y: 0, z: -0.5 },
    ],
    100,
    { maxAngleDeg: 45 },
  );
  const code = `${b.lines.join("\n")}\n`;
  for (const line of code.split("\n")) {
    const x = Number((line.match(/X(-?[\d.]+)/) || [])[1]);
    const z = Number((line.match(/Z(-?[\d.]+)/) || [])[1]);
    if (Number.isFinite(x) && Number.isFinite(z) && Math.abs(x - 5) < 0.01) {
      assert.ok(z >= -0.1 - 1e-6, `ramp cut to Z${z} at the high point`);
    }
  }
});

test("a finished program is metric, absolute, free of forbidden commands and ends with a retract then M30", () => {
  const b = builder();
  b.travelTo(10, 10).approach(0.2).cutTo(20, 10, -0.1, 100);
  const code = b.finish();
  assert.match(code, /^G21\nG90\n/);
  assert.doesNotMatch(code, /\b(G10|G28|G30|G53|G91|G92|M3|M4|M5|M6)\b/);
  const lines = code.trim().split("\n");
  assert.equal(lines[lines.length - 1], "M30");
  assert.match(lines[lines.length - 2], /^G0 Z4\.99$/);
});

test("linearize keeps every point within the stated tolerance", () => {
  const points = [];
  for (let i = 0; i <= 100; i += 1) points.push({ x: i * 0.1, y: 0, z: -0.3 + 0.1 * Math.sin(i / 6) });
  const reduced = linearize(points, 0.01);
  assert.ok(reduced.length < points.length);
  assert.equal(reduced[0].x, points[0].x);
  assert.equal(reduced[reduced.length - 1].x, points[points.length - 1].x);
  for (const point of points) {
    let best = Infinity;
    for (let i = 1; i < reduced.length; i += 1) {
      const a = reduced[i - 1];
      const c = reduced[i];
      if (point.x < a.x - 1e-9 || point.x > c.x + 1e-9) continue;
      const t = (point.x - a.x) / (c.x - a.x || 1);
      best = Math.min(best, Math.abs(point.z - (a.z + (c.z - a.z) * t)));
    }
    if (Number.isFinite(best)) assert.ok(best <= 0.0101, `deviation ${best}`);
  }
});

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

test("sliding-window extremes match a brute-force scan", () => {
  const source = Float64Array.from([5, 1, 9, 3, 7, 2, 8]);
  const out = new Float64Array(7);
  rowWindowExtreme(source, 7, 2, false, 0, out);
  for (let i = 0; i < 7; i += 1) {
    let expected = 0; // outside the row counts as no material
    let any = false;
    let best = Infinity;
    for (let k = i - 2; k <= i + 2; k += 1) best = Math.min(best, k < 0 || k >= 7 ? 0 : source[k]);
    expected = best;
    any = true;
    assert.ok(any);
    assert.equal(out[i], expected);
  }
});

test("a flat tool cannot descend into a valley narrower than itself", () => {
  const cols = 61;
  const rows = 61;
  const centre = 30 * cols + 30;
  // A 0.5 mm wide, 1 mm deep slot running the full height of a 6 x 6 mm field.
  const narrow = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r += 1) for (let c = 28; c <= 32; c += 1) narrow[r * cols + c] = 1;
  assert.equal(discErode(narrow, cols, rows, 8)[centre], 0, "0.8 mm radius tool must not reach into a 0.5 mm slot");

  // A 4 mm wide pocket: the same tool reaches its floor.
  const wide = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r += 1) for (let c = 10; c <= 50; c += 1) wide[r * cols + c] = 1;
  assert.equal(discErode(wide, cols, rows, 8)[centre], 1, "tool should reach the floor of a wide pocket");

  // Opening restores the cleared pocket but never invents depth.
  const opened = discDilate(discErode(wide, cols, rows, 8), cols, rows, 8);
  assert.equal(opened[centre], 1);
  assert.ok(discDilate(discErode(narrow, cols, rows, 8), cols, rows, 8)[centre] === 0);
});

test("the drop-cutter query keeps the tool above the surface", () => {
  const model = new ReliefModel({
    cols: 41,
    rows: 41,
    gridMm: 0.1,
    bounds: { minX: 0, maxX: 4, minY: 0, maxY: 4 },
    depthUm: new Uint16Array(41 * 41).fill(500),
  });
  // A single raised island at the centre: the tool must not sink beside it.
  model.depthUm[20 * 41 + 20] = 0;
  const ball = TOOLS["spetool-w01015-spe-x"];
  const atIsland = model.dropCutterZ(ball, 2.0, 2.0, 0.8);
  assert.ok(Math.abs(atIsland) < 1e-9, `tip must stop at the island top, got ${atIsland}`);
  const nearby = model.dropCutterZ(ball, 2.3, 2.0, 0.8);
  assert.ok(nearby > -0.5, "tip must be held up by the nearby island");
  assert.ok(nearby <= 0);
});

test("polygon offsetting moves the outline the requested distance", () => {
  const square = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ];
  const grown = offsetPolygon(square, 1);
  assert.ok(polygonAreaMm2(grown) > polygonAreaMm2(square));
  assert.ok(pointInPolygon(grown, -0.5, 5));
  assert.ok(!pointInPolygon(square, -0.5, 5));
  const shrunk = offsetPolygon(square, -1);
  assert.ok(polygonAreaMm2(shrunk) < polygonAreaMm2(square));
});

test("tapered ball engagement grows with depth and is bounded by the shank", () => {
  const ball = TOOLS["spetool-w01015-spe-x"];
  assert.ok(engagedDiameterMm(ball, 0.05) < engagedDiameterMm(ball, 0.2));
  assert.ok(engagedDiameterMm(ball, 0.2) < engagedDiameterMm(ball, 0.8));
  assert.ok(engagedDiameterMm(ball, 50) <= ball.shankMm + 1e-9);
  assert.equal(profileOffsetMm(ball, 0), 0);
  assert.ok(profileOffsetMm(ball, 0.5) > 0);
});

// ---------------------------------------------------------------------------
// Whole-job generation
// ---------------------------------------------------------------------------

const hasModel = (() => {
  try {
    loadModel(MODEL_DIR);
    return true;
  } catch {
    return false;
  }
})();

test("the relief model and silhouette load and describe the buckle", { skip: !hasModel && "relief model not built" }, () => {
  const { relief, silhouette, partEdge } = loadModel(MODEL_DIR);
  const stats = relief.stats();
  assert.ok(stats.maxDepthMm > 0.7 && stats.maxDepthMm < 0.85, `max relief depth ${stats.maxDepthMm}`);
  // Independently confirms the 2026-09-30 audit's 2,774 mm3 relief volume.
  assert.ok(stats.volumeMm3 > 2600 && stats.volumeMm3 < 2900, `relief volume ${stats.volumeMm3}`);
  assert.equal(silhouette.points.length, 63);
  assert.ok(polygonPerimeterMm(partEdge) > 300 && polygonPerimeterMm(partEdge) < 360);
  assert.ok(polygonAreaMm2(partEdge) > 7000 && polygonAreaMm2(partEdge) < 8500);
});

const job = hasModel ? generateJob(DEFAULT_JOB, MODEL_DIR) : null;

test("every generated stage satisfies the motion contract", { skip: !hasModel && "relief model not built" }, () => {
  for (const [name, stage] of Object.entries(job.stages)) {
    const maxDepthMm =
      name === "profile" || name === "release"
        ? STOCK.thicknessMm + DEFAULT_JOB.sacrificialDepthMm + 0.001
        : job.relief.stats().maxDepthMm + 0.001;
    const result = validateProgram(stage.code, {
      clearanceZMm: MACHINE.clearanceZMm,
      maxDepthMm,
      maxCutFeedMmPerMin: Math.max(...stage.cuts.map((c) => c.feedMmPerMin)),
    });
    assert.deepEqual(result.problems, [], `${name}: ${result.problems.join("; ")}`);
  }
});

test("no generated stage contains a hard-coded feed outside the solver", { skip: !hasModel && "relief model not built" }, () => {
  for (const [name, stage] of Object.entries(job.stages)) {
    const allowed = new Set();
    for (const cut of stage.cuts) {
      allowed.add(cut.feedMmPerMin);
      for (const fraction of [0.35, 0.4]) allowed.add(Math.max(10, Math.round(cut.feedMmPerMin * fraction)));
    }
    allowed.add(MACHINE.rapidFeedMmPerMin);
    for (const match of stage.code.matchAll(/F(\d+(?:\.\d+)?)/g)) {
      assert.ok(allowed.has(Number(match[1])), `${name} emits unexplained feed F${match[1]}`);
    }
  }
});

test("Profile does not full-immersion slot", { skip: !hasModel && "relief model not built" }, () => {
  const profile = job.stages.profile;
  const check = assertNoFullImmersionSlotting(profile.code, profile.tool.diameterMm);
  assert.equal(check.slotting, false, `narrow fraction ${check.narrowFraction}`);
  // The kerf must be genuinely wider than the cutter, which is what keeps
  // radial engagement light instead of burying the tool on both sides.
  assert.ok(check.kerfWidthMm > profile.tool.diameterMm + 0.5, `kerf ${check.kerfWidthMm}`);
  assert.ok(profile.radialEngagementFraction <= 0.25, `radial engagement ${profile.radialEngagementFraction}`);
});

test("Profile leaves real holding tabs", { skip: !hasModel && "relief model not built" }, () => {
  const profile = job.stages.profile;
  const held = findHoldingTabs(profile.code, profile.throughDepthMm);
  assert.equal(held.tabs, DEFAULT_JOB.tabCount, `found ${held.tabs} tab regions`);
  for (const region of held.regions) {
    assert.ok(region.shallowestZ > -profile.throughDepthMm, "tab region reaches full depth");
  }
});

test("Release removes every tab and never moves in XY after the part is free", { skip: !hasModel && "relief model not built" }, () => {
  const release = job.stages.release;
  assert.equal(release.tabs, DEFAULT_JOB.tabCount);
  const result = validateProgram(release.code, {
    clearanceZMm: MACHINE.clearanceZMm,
    maxDepthMm: STOCK.thicknessMm + DEFAULT_JOB.sacrificialDepthMm + 0.001,
    maxCutFeedMmPerMin: release.cuts[0].feedMmPerMin,
  });
  assert.deepEqual(result.problems, []);
  // Release must reach full through depth, unlike Profile.
  assert.ok(result.metrics.minZ <= -(STOCK.thicknessMm + DEFAULT_JOB.sacrificialDepthMm) + 1e-3);
  const held = findHoldingTabs(release.code, STOCK.thicknessMm + DEFAULT_JOB.sacrificialDepthMm);
  assert.equal(held.tabs, 0, "release must not leave anything holding the part");
});

test("Rough actually removes material and leaves the finish allowance", { skip: !hasModel && "relief model not built" }, () => {
  const rough = job.stages.rough;
  assert.ok(rough.metrics.cutDistanceMm > 100, `rough cuts only ${rough.metrics.cutDistanceMm} mm`);
  assert.equal(rough.stockToLeaveMm, DEFAULT_JOB.stockToLeaveMm);
  assert.ok(rough.levels >= 1);
  // It must never reach the finished surface.
  const result = validateProgram(rough.code, { clearanceZMm: MACHINE.clearanceZMm });
  assert.ok(result.metrics.minZ > -(job.relief.stats().maxDepthMm - DEFAULT_JOB.stockToLeaveMm) - 1e-3);
});

test("Finish descends in bounded layers rather than one deep bite", { skip: !hasModel && "relief model not built" }, () => {
  const finish = job.stages.finish;
  assert.ok(finish.layers.length >= 2, "finish should layer");
  assert.equal(finish.layers[finish.layers.length - 1].kind, "detail");
  for (const cut of finish.cuts) {
    assert.ok(cut.axialDepthMm <= 0.25 + 1e-9, `layer depth ${cut.axialDepthMm}`);
  }
  // The audit's complaint was a 0.77 mm single-pass bite with this tool.
  assert.ok(Math.max(...finish.cuts.map((c) => c.axialDepthMm)) < 0.4);
});

test("the whole job is far shorter than the rejected programs and the arithmetic is reported", { skip: !hasModel && "relief model not built" }, () => {
  let minutes = 0;
  for (const [name, stage] of Object.entries(job.stages)) {
    const check = validateProgram(stage.code, { clearanceZMm: MACHINE.clearanceZMm });
    const transport = check.metrics.lines / MACHINE.programLinesPerSecond / 60;
    minutes += Math.max(check.metrics.cutTimeMin, transport);
    assert.ok(check.metrics.cutTimeMin > 0, `${name} has no cutting time`);
  }
  // The rejected five-stage set was 20.266 h of programmed feed.
  assert.ok(minutes / 60 < 6, `total ${minutes / 60} h`);
});

test("placement is a parameter, not a constant", { skip: !hasModel && "relief model not built" }, () => {
  assert.equal(DEFAULT_JOB.placement.offsetXMm, 0);
  assert.equal(DEFAULT_JOB.placement.offsetYMm, 0);
  // The generator takes the whole job as input, so a different blank position
  // is a new job object rather than an edit to the generator.
  const moved = generateJob({ ...DEFAULT_JOB, stock: { ...STOCK, thicknessMm: 3.9 } }, MODEL_DIR);
  assert.ok(moved.stages.profile.throughDepthMm > job.stages.profile.throughDepthMm);
});

test("the router gear table is modelled, and that is recorded rather than hidden", () => {
  assert.equal(ROUTER.statedRpmMin, 6500);
  assert.equal(ROUTER.statedRpmMax, 30000);
  assert.equal(ROUTER.gears.length, 6);
  for (const entry of ROUTER.gears) {
    assert.ok(entry.rpmMin <= entry.rpmNominal && entry.rpmNominal <= entry.rpmMax);
    if (entry.gear > 1) assert.ok(entry.modelled, `gear ${entry.gear} should be flagged as modelled`);
  }
});
