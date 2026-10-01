// One-time build step: reconstruct the buckle relief and silhouette from the
// certified Kiri:Moto programs and write them out as a reusable model.
//
//   node cam/build-relief-model.mjs <certified-dir> <output-dir>
//
// The certified .nc files are large and are NOT in this repository; they live in
// the workspace QA artifacts folder. The model this produces is small, is the
// only geometry the generator needs, and is what gets committed.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { TOOLS } from "./tool-library.mjs";
import {
  GRID_MM,
  ReliefModel,
  extractSilhouette,
  polygonAreaMm2,
  polygonPerimeterMm,
  sweepProgram,
} from "./relief-model.mjs";

const FINISH_FILE = "rambo-buckle-c752-finish-xy-w01015.nc";
const PROFILE_FILE = "rambo-buckle-c752-profile-ru2100.nc";

// Fixed hashes of the exact programs this model is derived from. If they ever
// differ, the model is stale and must not be silently rebuilt from something
// else: the whole point is that the geometry traces to the artwork the operator
// already visually accepted.
const SOURCE_HASHES = {
  [FINISH_FILE]: "16a7564d9dc04902db95870acc14c918da98e7dd82945540461a420320e45911",
  [PROFILE_FILE]: "f370f64cc39ed1d8facbd4fa0b9ec99e35f4153ec70261364a0a09da75a2f76a",
};

export function buildModel(certifiedDir) {
  const read = (file) => {
    const buffer = readFileSync(join(certifiedDir, file));
    const hash = createHash("sha256").update(buffer).digest("hex");
    if (hash !== SOURCE_HASHES[file]) {
      throw new Error(`${file} hash ${hash} does not match the certified source this model is derived from`);
    }
    return buffer.toString("utf8");
  };

  const finishCode = read(FINISH_FILE);
  const profileCode = read(PROFILE_FILE);

  const silhouette = extractSilhouette(profileCode);
  if (silhouette.length < 20) throw new Error(`silhouette extraction found only ${silhouette.length} points`);

  // The Profile contour is the cutter CENTRE path of a 6.35 mm cutter running
  // outside the part, so the true part edge sits one tool radius inside it.
  const PROFILE_TOOL_RADIUS_MM = TOOLS["whiteside-ru2100"].diameterMm / 2;

  const bounds = { minX: 8, maxX: 122, minY: 21, maxY: 109 };
  const relief = new ReliefModel(
    sweepProgram(finishCode, TOOLS["spetool-w01015-spe-x"], bounds, { gridMm: GRID_MM, maxDepthMm: 1.0 }),
  );

  return { relief, silhouette, profileToolRadiusMm: PROFILE_TOOL_RADIUS_MM, finishCode, profileCode };
}

function main() {
  const certifiedDir = process.argv[2];
  const outputDir = process.argv[3] || join(import.meta.dirname, "models");
  if (!certifiedDir) {
    process.stderr.write("usage: node cam/build-relief-model.mjs <certified-dir> [output-dir]\n");
    process.exit(2);
  }

  const started = Date.now();
  const { relief, silhouette, profileToolRadiusMm } = buildModel(certifiedDir);
  const stats = relief.stats();

  mkdirSync(outputDir, { recursive: true });

  const meta = {
    id: "rambo-buckle-relief-v1",
    derivedFrom: SOURCE_HASHES,
    builtAt: new Date().toISOString(),
    ...stats,
  };
  writeFileSync(join(outputDir, "rambo-buckle-relief.bin"), relief.encode(meta));

  const silhouetteDoc = {
    id: "rambo-buckle-silhouette-v1",
    derivedFrom: { [PROFILE_FILE]: SOURCE_HASHES[PROFILE_FILE] },
    frame: "cutter-centre path of the certified Profile stage",
    profileToolRadiusMm,
    pointCount: silhouette.length,
    perimeterMm: polygonPerimeterMm(silhouette),
    areaMm2: polygonAreaMm2(silhouette),
    points: silhouette.map((p) => ({ x: Number(p.x.toFixed(4)), y: Number(p.y.toFixed(4)) })),
  };
  writeFileSync(join(outputDir, "rambo-buckle-silhouette.json"), `${JSON.stringify(silhouetteDoc, null, 2)}\n`);

  process.stdout.write(
    [
      `relief     ${stats.cols} x ${stats.rows} @ ${stats.gridMm} mm`,
      `max depth  ${stats.maxDepthMm.toFixed(4)} mm`,
      `cut area   ${stats.touchedAreaMm2.toFixed(1)} mm2`,
      `volume     ${stats.volumeMm3.toFixed(1)} mm3`,
      `silhouette ${silhouette.length} points, perimeter ${silhouetteDoc.perimeterMm.toFixed(1)} mm, area ${silhouetteDoc.areaMm2.toFixed(0)} mm2`,
      `built in   ${((Date.now() - started) / 1000).toFixed(1)} s`,
      "",
    ].join("\n"),
  );
}

if (process.argv[1] && process.argv[1].endsWith("build-relief-model.mjs")) main();
