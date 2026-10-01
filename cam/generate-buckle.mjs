// Generate the complete Rambo buckle program set for C752 nickel silver.
//
//   node cam/generate-buckle.mjs [output-dir]
//
// Placement is a PARAMETER, not a constant. The current blank has damage inside
// the present footprint (two bored circles at work X0 Y0 and X25.87 Y83.43, plus
// pre-existing holes on the right), so where this buckle actually goes is an
// open physical question. --offset-x / --offset-y move the whole job.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { MACHINE } from "./machine-library.mjs";
import { assertClearanceAboveStock } from "./program.mjs";
import { compareSurfaces, sweepFinish } from "./fidelity.mjs";
import { ReliefModel, offsetPolygon, pointInPolygon, polygonAreaMm2, polygonPerimeterMm, sweepProgram } from "./relief-model.mjs";
import { generateFinish, generateProfile, generateRelease, generateRough } from "./stages.mjs";
import { assertNoFullImmersionSlotting, findHoldingTabs, validateProgram } from "./validate.mjs";

export const DEFAULT_JOB = Object.freeze({
  id: "rambo-buckle-c752-v2",
  name: "The Rambo's buckle · C752 nickel silver",
  material: "c752-nickel-silver",
  // Measured by the operator's own bed/stock probes on 2026-09-30.
  stock: Object.freeze({ widthMm: 260, heightMm: 130, thicknessMm: 3.855 }),
  // Operator-chosen plate value, 2026-10-01. NOT a constant: it is validated
  // against the documented SainSmart variants and must stay editable.
  plate: Object.freeze({ thicknessMm: 14.19, confirmed: true }),
  // Baseline placement, matching the current certified library. Treated as a
  // parameter pending the blank-damage decision.
  placement: Object.freeze({ offsetXMm: 0, offsetYMm: 0 }),
  stockToLeaveMm: 0.12,
  sacrificialDepthMm: 0.1,
  tabCount: 6,
  tabWidthMm: 4,
  tabHeightMm: 0.8,
});

export function loadModel(modelDir = join(import.meta.dirname, "models")) {
  const relief = ReliefModel.decode(readFileSync(join(modelDir, "rambo-buckle-relief.bin")));
  const silhouette = JSON.parse(readFileSync(join(modelDir, "rambo-buckle-silhouette.json"), "utf8"));
  // The stored silhouette is the cutter-CENTRE path of the 6.35 mm tool that
  // originally cut it, so the real part edge sits one of its radii inside.
  const partEdge = offsetPolygon(silhouette.points, -silhouette.profileToolRadiusMm);
  return { relief, silhouette, partEdge };
}

export function generateJob(job = DEFAULT_JOB, modelDir) {
  const { relief, partEdge } = loadModel(modelDir);
  const context = {
    model: relief,
    partEdge,
    plate: job.plate,
    stock: job.stock,
    stockToLeaveMm: job.stockToLeaveMm,
    sacrificialDepthMm: job.sacrificialDepthMm,
    tabCount: job.tabCount,
    tabWidthMm: job.tabWidthMm,
    tabHeightMm: job.tabHeightMm,
  };

  const rough = generateRough(context);

  // Surface the roughing pass actually leaves behind, obtained by sweeping the
  // program that was just emitted. Using the theoretical reachable surface
  // instead would tell Finish that more had been removed than really was, and
  // its first bulk layer would then exceed its own axial limit wherever Rough
  // fell short of theory -- which on this relief is most of it.
  const roughSwept = new ReliefModel(
    sweepProgram(rough.code, rough.tool, relief.bounds, { gridMm: relief.gridMm, maxDepthMm: 1.0 }),
  );
  const roughedSurface = new Float32Array(relief.cols * relief.rows);
  for (let i = 0; i < roughedSurface.length; i += 1) {
    roughedSurface[i] = Math.min(relief.depthUm[i] / 1000, roughSwept.depthUm[i] / 1000);
  }

  const finish = generateFinish({ ...context, roughedSurface });
  const profile = generateProfile(context);
  const release = generateRelease({ ...context, profile: { ...profile, tabHeightMm: job.tabHeightMm } });

  return { job, stages: { rough, finish, profile, release }, partEdge, relief };
}

function offsetCode(code, dx, dy) {
  if (!dx && !dy) return code;
  return code
    .split("\n")
    .map((line) => {
      if (!/^G[01]\b/.test(line)) return line;
      return line
        .replace(/X(-?\d+(?:\.\d+)?)/, (_, v) => `X${round(Number(v) + dx)}`)
        .replace(/Y(-?\d+(?:\.\d+)?)/, (_, v) => `Y${round(Number(v) + dy)}`);
    })
    .join("\n");
}

function round(value) {
  const r = Math.round(value * 10000) / 10000;
  return Object.is(r, -0) ? "0" : String(r);
}

function main() {
  const args = process.argv.slice(2);
  const outputDir = args.find((a) => !a.startsWith("--")) || join(import.meta.dirname, "out");
  const readFlag = (name, fallback) => {
    const hit = args.find((a) => a.startsWith(`--${name}=`));
    return hit ? Number(hit.split("=")[1]) : fallback;
  };

  const job = {
    ...DEFAULT_JOB,
    placement: {
      offsetXMm: readFlag("offset-x", DEFAULT_JOB.placement.offsetXMm),
      offsetYMm: readFlag("offset-y", DEFAULT_JOB.placement.offsetYMm),
    },
  };

  const started = Date.now();
  const { stages, partEdge, relief } = generateJob(job);
  mkdirSync(outputDir, { recursive: true });

  const order = ["rough", "finish", "profile", "release"];
  const report = [];
  let totalMinutes = 0;
  let totalLines = 0;

  for (const name of order) {
    const stage = stages[name];
    const code = offsetCode(stage.code, job.placement.offsetXMm, job.placement.offsetYMm);
    const file = `rambo-buckle-c752-${name}-${stage.tool.id}.nc`;
    writeFileSync(join(outputDir, file), code);

    const maxDepth =
      name === "profile" || name === "release" ? job.stock.thicknessMm + job.sacrificialDepthMm : relief.stats().maxDepthMm;
    const check = validateProgram(code, {
      clearanceZMm: MACHINE.clearanceZMm,
      maxDepthMm: maxDepth + 0.001,
      maxCutFeedMmPerMin: Math.max(...stage.cuts.map((c) => c.feedMmPerMin)),
    });

    // Feed time, and the time the controller can actually deliver given its
    // measured line rate. The slower of the two is the honest estimate.
    const feedMinutes = check.metrics.cutTimeMin;
    const transportMinutes = check.metrics.lines / MACHINE.programLinesPerSecond / 60;
    const minutes = Math.max(feedMinutes, transportMinutes);
    totalMinutes += minutes;
    totalLines += check.metrics.lines;

    const entry = {
      stage: name,
      file,
      tool: stage.tool.name,
      sha256: createHash("sha256").update(code).digest("hex"),
      bytes: Buffer.byteLength(code),
      lines: check.metrics.lines,
      cutMoves: check.metrics.cutMoves,
      meanCutSegmentMm: check.metrics.meanCutSegmentMm,
      minZ: check.metrics.minZ,
      bounds: check.metrics.bounds,
      steepestEntryDeg: check.metrics.steepestEntryDeg,
      feedMinutes,
      transportMinutes,
      minutes,
      valid: check.ok,
      problems: check.problems,
      cuts: stage.cuts.map((c) => ({
        phase: c.stage,
        gear: c.gear,
        rpmNominal: c.rpmNominal,
        rpmRange: [c.rpmMin, c.rpmMax],
        feedMmPerMin: c.feedMmPerMin,
        axialDepthMm: c.axialDepthMm,
        radialEngagementMm: c.radialEngagementMm,
        engagedDiameterMm: c.engagedDiameterMm,
        surfaceSpeedMPerMin: c.surfaceSpeedNominalMPerMin,
        surfaceSpeedWorstMPerMin: c.surfaceSpeedWorstMPerMin,
        surfaceSpeedLimitMPerMin: c.surfaceSpeedLimitMPerMin,
        chipLoadUmPerTooth: [c.chipLoadActualMinMm * 1000, c.chipLoadActualMaxMm * 1000],
        materialRemovalRateMm3PerMin: c.materialRemovalRateMm3PerMin,
      })),
    };

    if (name === "profile") {
      entry.immersion = assertNoFullImmersionSlotting(code, stage.tool.diameterMm);
      entry.holding = findHoldingTabs(code, job.stock.thicknessMm + job.sacrificialDepthMm);
      entry.perimeterMm = stage.perimeterMm;
      entry.levels = stage.levels;
      entry.levelDepthMm = stage.levelDepthMm;
    }
    if (name === "release") entry.tabs = stage.tabs;
    if (name === "finish") entry.layers = stage.layers;
    if (name === "rough") {
      entry.levels = stage.levels;
      entry.levelDepthMm = stage.levelDepthMm;
    }

    report.push(entry);
  }

  // Prove the regenerated Finish still cuts the design, by sweeping its own
  // tool over the relief model it came from. A program can satisfy every motion
  // and machinability rule and still not be the buckle.
  let fidelity = null;
  if (!args.includes("--no-fidelity")) {
    const inner = offsetPolygon(partEdge, -0.5);
    const insideMask = new Uint8Array(relief.cols * relief.rows);
    for (let r = 0; r < relief.rows; r += 1) {
      for (let c = 0; c < relief.cols; c += 1) {
        if (pointInPolygon(inner, relief.xOf(c), relief.yOf(r))) insideMask[r * relief.cols + c] = 1;
      }
    }
    const achieved = sweepFinish(stages.finish.code, stages.finish.tool, relief);
    fidelity = compareSurfaces(relief, achieved, { insideMask });
  }

  const clearance = assertClearanceAboveStock({
    clearanceZMm: MACHINE.clearanceZMm,
    plateThicknessMm: job.plate.thicknessMm,
    plateConfirmed: job.plate.confirmed,
    stockThicknessMm: job.stock.thicknessMm,
  });

  const manifest = {
    id: job.id,
    name: job.name,
    generatedAt: new Date().toISOString(),
    generator: "openclaw-cam",
    material: job.material,
    stock: job.stock,
    plate: { ...job.plate, ...clearance },
    clearanceZMm: MACHINE.clearanceZMm,
    fidelity,
    placement: job.placement,
    router: {
      model: MACHINE.router.name,
      manualSpeedControl: true,
      gearRpmIsModelled: true,
      statedRange: [MACHINE.router.statedRpmMin, MACHINE.router.statedRpmMax],
    },
    part: { perimeterMm: polygonPerimeterMm(partEdge), areaMm2: polygonAreaMm2(partEdge) },
    omittedStages: [
      {
        stage: "cleanup",
        reason:
          "Folded into Finish. The 3.175 mm rougher reaches only part of this relief, but the only tool that can reach the remainder is the W01015 itself, so a separate cleanup stage would be the same tool on the same geometry. Finish now descends in bounded layers instead, which is what the cleanup stage existed to provide.",
      },
      { stage: "detail", reason: "No V-bit detail pass: the W01015 finish resolves the artwork and a tool change adds a re-probe." },
    ],
    totals: { minutes: totalMinutes, hours: totalMinutes / 60, lines: totalLines },
    stages: report,
  };
  writeFileSync(join(outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  // --- human-readable summary -------------------------------------------
  const before = { rough: 1.03, cleanup: 3.83, finish: 4.89, profile: 9.59, release: 0.93 };
  const beforeTotal = Object.values(before).reduce((a, b) => a + b, 0);
  const out = [];
  out.push(`${job.name}  (${job.id})`);
  out.push(`placement X+${job.placement.offsetXMm} Y+${job.placement.offsetYMm} on ${job.stock.widthMm}x${job.stock.heightMm}x${job.stock.thicknessMm} mm`);
  out.push(`part perimeter ${manifest.part.perimeterMm.toFixed(1)} mm, area ${manifest.part.areaMm2.toFixed(0)} mm2`);
  out.push("");
  out.push("stage     tool                  gear  rpm     feed   axial  radial  chip um/t    SS m/min  minutes");
  for (const entry of report) {
    for (const cut of entry.cuts) {
      out.push(
        [
          (cut.phase === entry.stage ? entry.stage : cut.phase).padEnd(14),
          entry.tool.split("·")[0].trim().slice(0, 20).padEnd(21),
          String(cut.gear).padEnd(5),
          String(cut.rpmNominal).padEnd(7),
          String(cut.feedMmPerMin).padEnd(6),
          cut.axialDepthMm.toFixed(3).padEnd(6),
          cut.radialEngagementMm.toFixed(2).padEnd(7),
          `${cut.chipLoadUmPerTooth[0].toFixed(1)}-${cut.chipLoadUmPerTooth[1].toFixed(1)}`.padEnd(12),
          `${cut.surfaceSpeedMPerMin.toFixed(0)}/${cut.surfaceSpeedLimitMPerMin}`.padEnd(9),
          cut === entry.cuts[0] ? entry.minutes.toFixed(1) : "",
        ].join(" "),
      );
    }
  }
  out.push("");
  out.push("stage      before (h)   after (h)   lines      valid");
  for (const entry of report) {
    out.push(
      `${entry.stage.padEnd(10)} ${String(before[entry.stage] ?? 0).padEnd(12)} ${(entry.minutes / 60).toFixed(2).padEnd(11)} ${String(entry.lines).padEnd(10)} ${entry.valid ? "yes" : `NO: ${entry.problems.join("; ")}`}`,
    );
  }
  out.push(`${"cleanup".padEnd(10)} ${String(before.cleanup).padEnd(12)} ${"omitted".padEnd(11)}`);
  out.push(`${"TOTAL".padEnd(10)} ${beforeTotal.toFixed(2).padEnd(12)} ${(totalMinutes / 60).toFixed(2).padEnd(11)} ${totalLines}`);
  out.push("");
  const profileEntry = report.find((r) => r.stage === "profile");
  out.push(
    `profile: kerf ${profileEntry.immersion.kerfWidthMm.toFixed(2)} mm vs ${(stages.profile.tool.diameterMm).toFixed(3)} mm tool, full-immersion slotting: ${profileEntry.immersion.slotting ? "YES" : "no"}; holding tabs found: ${profileEntry.holding.tabs}`,
  );
  out.push(`release: ${report.find((r) => r.stage === "release").tabs} tab removals`);
  if (fidelity) {
    out.push(
      `fidelity vs certified surface: mean |dev| ${fidelity.meanAbsDeviationUm.toFixed(1)} um, worst over-cut ${fidelity.maxTooDeepUm.toFixed(0)} um, worst under-cut ${fidelity.maxNotReachedUm.toFixed(0)} um`,
    );
  }
  out.push(
    `clearance Z${MACHINE.clearanceZMm} with a ${job.plate.thicknessMm} mm plate; physical Z0 proof required before Start: ${clearance.physicalSurfaceProofRequired ? "YES" : "no"}`,
  );
  out.push(`generated in ${((Date.now() - started) / 1000).toFixed(1)} s -> ${outputDir}`);
  out.push("");
  process.stdout.write(out.join("\n"));

  if (report.some((entry) => !entry.valid)) process.exitCode = 1;
}

if (process.argv[1] && process.argv[1].endsWith("generate-buckle.mjs")) main();
