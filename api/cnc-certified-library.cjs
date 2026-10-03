const { createHash } = require("crypto");
const { readFileSync } = require("fs");
const { join } = require("path");
const { gunzipSync } = require("zlib");

const RU2100 = "Whiteside RU2100 · 1/4″ two-flute upcut";
const W01015 = "SpeTool W01015-SPE-X · 1/4″ shank · 1/32″ cutting radius tapered ball nose";
const W03010 = "SpeTool W03010 · 1/8″ single-flute O-flute upcut";
const W01015_TAC = "SpeTool W01015-SPE-X · TAC tapered ball nose · 1/32″ radius";

// ---------------------------------------------------------------------------
// rambo-buckle-c752-v1 — the five Kiri:Moto operations certified 2026-09-30.
// Retained so an already-installed job keeps resolving its library, and so the
// audit keeps being exercised against a second, differently-formatted posting.
// Superseded for production by v2: the 2026-09-30 machinability audit measured
// 20.27 h of programmed feed, a Rough that cut air 85.3% of the time, a Profile
// running 74 full-immersion slot passes at 1.25 µm/tooth, and a Release with no
// tabs at all.
// ---------------------------------------------------------------------------
const V1_ORDER = ["rough", "cleanup", "finish", "profile", "release"];

const V1 = Object.freeze({
  id: "rambo-buckle-c752-v1",
  name: "Rambo buckle · C752 nickel silver",
  version: 1,
  superseded: true,
  supersededBy: "rambo-buckle-c752-v2",
  certifiedAt: "2026-09-30T14:00:00.000Z",
  provider: "kiri-moto",
  generator: "kiri-moto",
  material: "C752 nickel silver",
  clearanceZMm: 4.99,
  stock: { widthMm: 260, heightMm: 130, thicknessMm: 3.914, thicknessMeasuredOnThisBlank: false },
  design: { widthMm: 114, heightMm: 88, offsetXMm: 8, offsetYMm: 21, reliefDepthMm: 0.8 },
  profile: { depthMm: 4.024, sacrificialAllowanceMm: 0.11 },
  order: V1_ORDER,
  thicknessSensitiveStages: ["profile", "release"],
  omittedStages: [],
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

// ---------------------------------------------------------------------------
// rambo-buckle-c752-v2 — the openclaw-cam rebuild (qa-artifacts/cnc/cam-v3).
//
// Four stages, not five. Cleanup and detail are deliberately absent and say so
// in omittedStages: the only tool that can reach what Rough leaves is the
// W01015 itself, so a separate cleanup stage would be the same tool on the same
// geometry — Finish now descends in bounded 0.25 mm layers instead, which is
// what Cleanup existed to provide. No V-bit detail pass, because the W01015
// finish resolves the artwork and a tool change adds a re-probe.
//
// Every number below is pinned from qa-artifacts/cnc/cam-v3/manifest.json and
// independently re-measured from the exact .nc bytes. 3.91 h total, down from
// v1's 20.27 h.
//
// BLANK-THICKNESS DEPENDENCY. stock.thicknessMeasuredOnThisBlank is false:
// 3.855 mm was probed on the PREVIOUS, damaged sheet. Profile and Release cut
// to Z -3.955 (through 3.855 plus 0.100 mm into sacrificial backing), so both
// are invalid if the current blank differs materially. Rough and Finish are
// relief-only and do not depend on it. The Start gate enforces this against the
// probed value for the thicknessSensitiveStages below; it is not a note.
// ---------------------------------------------------------------------------
const V2_ORDER = ["rough", "finish", "profile", "release"];

const V2 = Object.freeze({
  id: "rambo-buckle-c752-v2",
  name: "The Rambo's buckle · C752 nickel silver",
  version: 2,
  superseded: false,
  certifiedAt: "2026-10-01T14:49:02.224Z",
  provider: "openclaw-cam",
  generator: "openclaw-cam",
  material: "C752 nickel silver",
  clearanceZMm: 4.99,
  router: "Genmitsu GM7100E · 710 W · 65 mm manual AC router · 6 detents 6,500–30,000 rpm",
  stock: {
    widthMm: 260,
    heightMm: 130,
    thicknessMm: 3.855,
    // FALSE. Probed on the previous damaged sheet, not on the blank in the machine.
    thicknessMeasuredOnThisBlank: false,
    thicknessMeasuredOn: "the previous damaged C752 sheet (probed 2026-09-30)",
  },
  design: { widthMm: 114, heightMm: 88, offsetXMm: 0, offsetYMm: 0, reliefDepthMm: 0.787 },
  profile: { depthMm: 3.955, sacrificialAllowanceMm: 0.1 },
  order: V2_ORDER,
  // Profile and Release cut through the blank. Their through-depth is derived
  // from a thickness measured on a different sheet, so Start re-checks them
  // against the probed stock and refuses when the two disagree.
  thicknessSensitiveStages: ["profile", "release"],
  totals: { hours: 3.9119617093156993, minutes: 234.71770255894197, lines: 252630 },
  omittedStages: [
    {
      stage: "cleanup",
      reason: "Folded into Finish. The 3.175 mm rougher reaches only part of this relief, and the only tool that can reach the remainder is the W01015 itself, so a separate cleanup stage would be the same tool on the same geometry. Finish descends in bounded 0.25 mm layers instead, which is what the cleanup stage existed to provide.",
    },
    {
      stage: "detail",
      reason: "No V-bit detail pass: the W01015 finish resolves the artwork and a tool change adds a re-probe.",
    },
  ],
  stages: {
    rough: {
      file: "rambo-buckle-c752-rough-spetool-w03010.nc",
      asset: "rambo-buckle-c752-rough-spetool-w03010.nc.gz",
      sha256: "43642568b0fb08f87a9d5cb7cc309fa2b066694d573c906fc2022c117e503b72",
      bytes: 171257,
      lines: 10533,
      tool: W03010,
      rpmNominal: 10600,
      gear: 2,
      estimatedSeconds: 1143,
      minZ: -0.434,
      maxCutFeed: 490,
      maxDescentPerCutMove: 0.2328,
      bounds: { minX: 17.6, maxX: 112.4, minY: 26.5563, maxY: 101.1687 },
      maxVerticalEntryDepth: 0,
      cutsThroughStock: false,
      note: "3D offset, ≤0.15 mm per layer, 0.794 mm stepover, leaves 0.12 mm for Finish.",
    },
    finish: {
      file: "rambo-buckle-c752-finish-spetool-w01015-spe-x.nc",
      asset: "rambo-buckle-c752-finish-spetool-w01015-spe-x.nc.gz",
      sha256: "381498978c562783cc352457d9fcb73096fd79edfca60a5786c63100145ca306",
      bytes: 3876322,
      lines: 223365,
      tool: W01015_TAC,
      rpmNominal: 14950,
      gear: 3,
      estimatedSeconds: 12074,
      minZ: -0.787,
      maxCutFeed: 550,
      maxDescentPerCutMove: 0.5441,
      bounds: { minX: 12.6, maxX: 117.4, minY: 23.08, maxY: 106.92 },
      maxVerticalEntryDepth: 0,
      cutsThroughStock: false,
      note: "Bulk 0.6 mm stepover at 462 mm/min then detail 0.16 mm at 550 mm/min, ≤0.25 mm per layer. No feature filter — resolution is set by the 1.5875 mm tip.",
    },
    profile: {
      file: "rambo-buckle-c752-profile-spetool-w03010.nc",
      asset: "rambo-buckle-c752-profile-spetool-w03010.nc.gz",
      sha256: "de9ff840bfa2e1149e117cb8f55a357eac706a5c7997c7c7856ffa194e628dce",
      bytes: 388334,
      lines: 18094,
      tool: W03010,
      rpmNominal: 10600,
      gear: 2,
      estimatedSeconds: 782,
      minZ: -3.955,
      maxCutFeed: 582,
      maxDescentPerCutMove: 0.1671,
      bounds: { minX: 11.2835, maxX: 118.7157, minY: 21.8009, maxY: 108.1971 },
      maxVerticalEntryDepth: 0,
      cutsThroughStock: true,
      tabs: 6,
      note: "Trochoidal 4.75 mm kerf, 0.5 mm radial (16% engagement, no full immersion), 3 levels × 1.318 mm. Six 4 mm × 0.8 mm tabs, removed by Release.",
    },
    release: {
      file: "rambo-buckle-c752-release-spetool-w03010.nc",
      asset: "rambo-buckle-c752-release-spetool-w03010.nc.gz",
      sha256: "e8e3f55436be971196de5f3a9d63d72521fbdbdde1244e48cbdc6eb8e3377522",
      bytes: 17598,
      lines: 638,
      tool: W03010,
      rpmNominal: 10600,
      gear: 2,
      estimatedSeconds: 84,
      minZ: -3.955,
      maxCutFeed: 576,
      maxDescentPerCutMove: 0.0933,
      bounds: { minX: 11.4764, maxX: 118.5505, minY: 22.3584, maxY: 107.2577 },
      maxVerticalEntryDepth: 0,
      cutsThroughStock: true,
      tabs: 6,
      sacrificialDepthMm: 0.1,
      note: "Six tab removals, each ramped then levelled at full depth across all three kerf lanes. Final cut is followed immediately by a vertical retract and no post-separation XY. Secure the buckle to the sacrificial backing first.",
    },
  },
});

const LIBRARIES = Object.freeze({ [V1.id]: V1, [V2.id]: V2 });
const DEFAULT_LIBRARY_ID = V2.id;

// Kept for callers written against the single-library module.
const LIBRARY_ID = V1.id;
const ORDER = V1_ORDER;
const MANIFEST = V1;

function closeEnough(actual, expected, epsilon = 0.0002) {
  return Number.isFinite(actual) && Math.abs(actual - expected) <= epsilon;
}

function auditProgram(code, stage, contract, manifest) {
  const clearanceZMm = Number((manifest && manifest.clearanceZMm) || 4.99);
  if (!/\bG21\b/.test(code) || !/\bG90\b/.test(code)) throw new Error(stage + " is not absolute metric G-code");
  if (/\b(?:G10|G28|G30|G53|G91|G92|M3|M4|M5|M6)\b/i.test(code)) throw new Error(stage + " contains a forbidden controller, spindle, or tool-change command");
  if (!/M30\s*$/m.test(code.trim())) throw new Error(stage + " does not end with M30");

  const lineCount = (code.match(/\n/g) || []).length;
  if (lineCount !== contract.lines) throw new Error(stage + " line count does not match its certificate");

  let x = 0, y = 0, z = 0, feed = 0, motion = null, minZ = Infinity;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  let rapidBelowSurface = 0, verticalEntryDepth = 0, lastMotion = "", maxDescentPerCutMove = 0;
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
      if (before.z > z) maxDescentPerCutMove = Math.max(maxDescentPerCutMove, before.z - z);
      const verticalOnly = x === before.x && y === before.y && z < before.z;
      if (verticalOnly) verticalEntryDepth = Math.max(verticalEntryDepth, Math.max(0, -z));
    }
  }

  if (rapidBelowSurface) throw new Error(stage + " contains a rapid move at or below the stock surface");
  // The program must park at the certified clearance plane, Z only, so the next
  // stage never inherits a tool left down in the work.
  const retract = lastMotion.match(/^G0\s+Z(-?\d+(?:\.\d+)?)(?:\s+F\d+(?:\.\d+)?)?$/i);
  if (!retract || !closeEnough(Number(retract[1]), clearanceZMm, 0.0002)) throw new Error(stage + " does not finish with the certified safe retract");
  if (!closeEnough(minZ, contract.minZ)) throw new Error(stage + " depth does not match its certificate");
  if (verticalEntryDepth > contract.maxVerticalEntryDepth + 0.0002) throw new Error(stage + " contains an uncertified vertical entry");
  // Pinned per stage so a re-posting cannot quietly deepen one cutting move.
  // Only libraries that declare the ceiling are held to it, and only those
  // carry the measurement into their certificate — so adding this check does
  // not rewrite an already-issued audit hash.
  const pinsDescent = Number.isFinite(contract.maxDescentPerCutMove);
  if (pinsDescent && maxDescentPerCutMove > contract.maxDescentPerCutMove + 0.0002) {
    throw new Error(stage + " descends further in one cutting move than its certificate allows");
  }
  for (const key of ["minX", "maxX", "minY", "maxY"]) {
    const actual = ({ minX, maxX, minY, maxY })[key];
    if (!closeEnough(actual, contract.bounds[key], 0.001)) throw new Error(stage + " motion bounds do not match its certificate");
  }
  const metrics = { lines: lineCount, minZ, minX, maxX, minY, maxY, rapidBelowSurface, verticalEntryDepth, finalRetractMm: clearanceZMm };
  if (pinsDescent) metrics.maxDescentPerCutMove = maxDescentPerCutMove;
  return metrics;
}

function loadCertifiedLibrary(id) {
  const manifest = LIBRARIES[String(id || "")];
  if (!manifest) throw new Error("Unknown certified CNC program");
  const programs = {};
  for (const stage of manifest.order) {
    const meta = manifest.stages[stage];
    const compressed = readFileSync(join(__dirname, "cnc-certified-programs", meta.asset));
    const codeBuffer = gunzipSync(compressed);
    const sourceHash = createHash("sha256").update(codeBuffer).digest("hex");
    if (codeBuffer.length !== meta.bytes || sourceHash !== meta.sha256) throw new Error(stage + " asset does not match its fixed certificate");
    const metrics = auditProgram(codeBuffer.toString("utf8"), stage, meta, manifest);
    const audit = JSON.stringify({ libraryId: manifest.id, version: manifest.version, stage, metrics });
    const auditHash = createHash("sha256").update(sourceHash + "\n" + audit + "\n" + manifest.provider + "\n" + stage + "\n" + meta.tool).digest("hex");
    programs[stage] = {
      gzipBase64: compressed.toString("base64"),
      certificate: { provider: manifest.provider, certification: "verified", certifiedAt: manifest.certifiedAt, sourceHash, auditHash, audit, tool: meta.tool },
      file: meta.file,
      metrics,
    };
  }
  return { manifest, programs };
}

// The provider string a job may legitimately carry for a resolvable in-repo
// library. Anything that is NOT such a library still has to be kiri-moto with
// the full operator attestation; see api/app.js.
function certifiedLibraryProvider(id) {
  const manifest = LIBRARIES[String(id || "")];
  return manifest ? manifest.provider : "";
}

function certifiedLibraryOrder(id) {
  const manifest = LIBRARIES[String(id || "")];
  return manifest ? manifest.order.slice() : [];
}

// Stages whose depth is derived from a stock thickness that may not have been
// measured on the blank now in the machine.
function certifiedThicknessSensitiveStages(id) {
  const manifest = LIBRARIES[String(id || "")];
  return manifest ? (manifest.thicknessSensitiveStages || []).slice() : [];
}

module.exports = {
  LIBRARY_ID,
  ORDER,
  MANIFEST,
  LIBRARIES,
  DEFAULT_LIBRARY_ID,
  auditProgram,
  loadCertifiedLibrary,
  certifiedLibraryProvider,
  certifiedLibraryOrder,
  certifiedThicknessSensitiveStages,
};
