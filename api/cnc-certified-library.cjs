const { createHash } = require("crypto");
const { readFileSync } = require("fs");
const { join } = require("path");
const { gunzipSync } = require("zlib");

const LIBRARY_ID = "rambo-buckle-c752-v1";
const ORDER = ["rough", "cleanup", "finish", "profile", "release"];
const RU2100 = "Whiteside RU2100 · 1/4″ two-flute upcut";
const W01015 = "SpeTool W01015-SPE-X · 1/4″ shank · 1/32″ cutting radius tapered ball nose";

const MANIFEST = Object.freeze({
  id: LIBRARY_ID,
  name: "Rambo buckle · C752 nickel silver",
  version: 1,
  certifiedAt: "2026-09-30T14:00:00.000Z",
  provider: "kiri-moto",
  material: "C752 nickel silver",
  stock: { widthMm: 260, heightMm: 130, thicknessMm: 3.914 },
  design: { widthMm: 114, heightMm: 88, offsetXMm: 8, offsetYMm: 21, reliefDepthMm: 0.8 },
  order: ORDER,
  stages: {
    rough: {
      file: "rambo-buckle-c752-rough-ru2100.nc",
      asset: "rambo-buckle-c752-rough-ru2100.nc.gz",
      sha256: "f8ec8a70558be73f2936b29ad153813b755e8e2ceafc899df181629432f68ac1",
      bytes: 3942718,
      lines: 173219,
      tool: RU2100,
      estimatedSeconds: 3994,
      minZ: -0.16,
      maxCutFeed: 300,
      bounds: { minX: 19.8766, maxX: 105.3998, minY: 33.0295, maxY: 101.0939 },
      maxVerticalEntryDepth: 0,
    },
    cleanup: {
      file: "rambo-buckle-c752-cleanup-w01015.nc",
      asset: "rambo-buckle-c752-cleanup-w01015.nc.gz",
      sha256: "66b53711b202a88d4dcf9e2c2276ced460ff11e196cbb9f8e2929f72c70a3241",
      bytes: 8220593,
      lines: 373167,
      tool: W01015,
      estimatedSeconds: 14238,
      minZ: -0.26,
      maxCutFeed: 120,
      bounds: { minX: 18.91, maxX: 110.8267, minY: 30.9958, maxY: 101.8262 },
      maxVerticalEntryDepth: 0,
    },
    finish: {
      file: "rambo-buckle-c752-finish-xy-w01015.nc",
      asset: "rambo-buckle-c752-finish-xy-w01015.nc.gz",
      sha256: "16a7564d9dc04902db95870acc14c918da98e7dd82945540461a420320e45911",
      bytes: 6730486,
      lines: 282477,
      tool: W01015,
      estimatedSeconds: 18075,
      minZ: -0.7975,
      maxCutFeed: 240,
      bounds: { minX: 8, maxX: 121.88, minY: 21, maxY: 108.96 },
      maxVerticalEntryDepth: 0.0163,
    },
    profile: {
      file: "rambo-buckle-c752-profile-ru2100.nc",
      asset: "rambo-buckle-c752-profile-ru2100.nc.gz",
      sha256: "f370f64cc39ed1d8facbd4fa0b9ec99e35f4153ec70261364a0a09da75a2f76a",
      bytes: 105369,
      lines: 4747,
      tool: RU2100,
      estimatedSeconds: 900,
      minZ: -3.71,
      maxCutFeed: 180,
      bounds: { minX: 10.1792, maxX: 119.8208, minY: 20.697, maxY: 109.303 },
      maxVerticalEntryDepth: 0,
      holdingSkinMm: 0.204,
    },
    release: {
      file: "rambo-buckle-c752-release-ru2100.nc",
      asset: "rambo-buckle-c752-release-ru2100.nc.gz",
      sha256: "4d3ea878bc18a61ce6bdedde4b17a27d08edaa01cbbba554814cd0be06e0674e",
      bytes: 10186,
      lines: 460,
      tool: RU2100,
      estimatedSeconds: 120,
      minZ: -4.024,
      maxCutFeed: 180,
      bounds: { minX: 10.1792, maxX: 119.8208, minY: 20.697, maxY: 109.303 },
      maxVerticalEntryDepth: 0,
      sacrificialDepthMm: 0.11,
    },
  },
});

function closeEnough(actual, expected, epsilon = 0.0002) {
  return Number.isFinite(actual) && Math.abs(actual - expected) <= epsilon;
}

function auditProgram(code, stage, contract) {
  if (!/\bG21\b/.test(code) || !/\bG90\b/.test(code)) throw new Error(stage + " is not absolute metric G-code");
  if (/\b(?:G10|G28|G30|G53|G91|G92|M3|M4|M5|M6)\b/i.test(code)) throw new Error(stage + " contains a forbidden controller, spindle, or tool-change command");
  if (!/M30\s*$/m.test(code.trim())) throw new Error(stage + " does not end with M30");

  const lineCount = (code.match(/\n/g) || []).length;
  if (lineCount !== contract.lines) throw new Error(stage + " line count does not match its certificate");

  let x = 0, y = 0, z = 0, feed = 0, motion = null, minZ = Infinity;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  let rapidBelowSurface = 0, verticalEntryDepth = 0, lastMotion = "";
  for (const rawLine of code.split(/\r?\n/)) {
    const line = rawLine.replace(/;.*/, "").replace(/\([^)]*\)/g, "").trim();
    if (!line) continue;
    const gm = line.match(/(?:^|\s)G0*([01])(?:\s|$)/i);
    if (gm) motion = Number(gm[1]);
    const before = { x, y, z };
    const words = {};
    for (const match of line.matchAll(/([XYZF])\s*(-?\d+(?:\.\d+)?)/gi)) words[match[1].toUpperCase()] = Number(match[2]);
    if (Number.isFinite(words.X)) x = words.X;
    if (Number.isFinite(words.Y)) y = words.Y;
    if (Number.isFinite(words.Z)) z = words.Z;
    if (Number.isFinite(words.F)) feed = words.F;
    const moved = x !== before.x || y !== before.y || z !== before.z;
    if ((motion === 0 || motion === 1) && moved) lastMotion = line;
    if (motion === 0 && moved && z <= 0) rapidBelowSurface++;
    if (motion === 1 && moved && z < 0) {
      minZ = Math.min(minZ, z, before.z);
      minX = Math.min(minX, x, before.x); maxX = Math.max(maxX, x, before.x);
      minY = Math.min(minY, y, before.y); maxY = Math.max(maxY, y, before.y);
      if (feed > contract.maxCutFeed + 0.001) throw new Error(stage + " exceeds its certified cutting feed");
      const verticalOnly = x === before.x && y === before.y && z < before.z;
      if (verticalOnly) verticalEntryDepth = Math.max(verticalEntryDepth, Math.max(0, -z));
    }
  }

  if (rapidBelowSurface) throw new Error(stage + " contains a rapid move at or below the stock surface");
  if (!/^G0\s+Z4\.9900(?:\s+F300)?$/i.test(lastMotion)) throw new Error(stage + " does not finish with the certified safe retract");
  if (!closeEnough(minZ, contract.minZ)) throw new Error(stage + " depth does not match its certificate");
  if (verticalEntryDepth > contract.maxVerticalEntryDepth + 0.0002) throw new Error(stage + " contains an uncertified vertical entry");
  for (const key of ["minX", "maxX", "minY", "maxY"]) {
    const actual = ({ minX, maxX, minY, maxY })[key];
    if (!closeEnough(actual, contract.bounds[key], 0.001)) throw new Error(stage + " motion bounds do not match its certificate");
  }
  return { lines: lineCount, minZ, minX, maxX, minY, maxY, rapidBelowSurface, verticalEntryDepth, finalRetractMm: 4.99 };
}

function loadCertifiedLibrary(id) {
  if (id !== LIBRARY_ID) throw new Error("Unknown certified CNC program");
  const programs = {};
  for (const stage of ORDER) {
    const meta = MANIFEST.stages[stage];
    const compressed = readFileSync(join(__dirname, "cnc-certified-programs", meta.asset));
    const codeBuffer = gunzipSync(compressed);
    const sourceHash = createHash("sha256").update(codeBuffer).digest("hex");
    if (codeBuffer.length !== meta.bytes || sourceHash !== meta.sha256) throw new Error(stage + " asset does not match its fixed certificate");
    const metrics = auditProgram(codeBuffer.toString("utf8"), stage, meta);
    const audit = JSON.stringify({ libraryId: LIBRARY_ID, version: MANIFEST.version, stage, metrics });
    const auditHash = createHash("sha256").update(sourceHash + "\n" + audit + "\n" + MANIFEST.provider + "\n" + stage + "\n" + meta.tool).digest("hex");
    programs[stage] = {
      gzipBase64: compressed.toString("base64"),
      certificate: { provider: MANIFEST.provider, certification: "verified", certifiedAt: MANIFEST.certifiedAt, sourceHash, auditHash, audit, tool: meta.tool },
      file: meta.file,
      metrics,
    };
  }
  return { manifest: MANIFEST, programs };
}

module.exports = { LIBRARY_ID, ORDER, MANIFEST, auditProgram, loadCertifiedLibrary };
