// The openclaw-cam rebuild (qa-artifacts/cnc/cam-v3) as Project owns it.
//
// These tests exercise the real loader and the real audit, not the manifest's own
// claims about itself: every number is re-derived from the gzipped bytes the
// serverless function will actually read, and each safety property is proven by
// breaking it and watching the audit refuse.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const require = createRequire(import.meta.url);
const library = require("../api/cnc-certified-library.cjs");
const { LIBRARIES, DEFAULT_LIBRARY_ID, auditProgram, loadCertifiedLibrary, certifiedLibraryProvider, certifiedLibraryOrder, certifiedThicknessSensitiveStages } = library;

const V2_ID = "rambo-buckle-c752-v2";
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const CAM_V3 = join(REPO, "qa-artifacts", "cnc", "cam-v3");

test("v2 is the library the loader installs by default", () => {
  assert.equal(DEFAULT_LIBRARY_ID, V2_ID);
  assert.equal(certifiedLibraryProvider(V2_ID), "openclaw-cam");
  // An unknown id resolves to no provider, so every caller falls back to its own
  // stricter default rather than to "anything goes".
  assert.equal(certifiedLibraryProvider("rambo-buckle-c752-v9"), "");
  assert.deepEqual(certifiedLibraryOrder("rambo-buckle-c752-v9"), []);
});

test("v2 is four stages, and the two it drops record why", () => {
  const { manifest } = loadCertifiedLibrary(V2_ID);
  assert.deepEqual(manifest.order, ["rough", "finish", "profile", "release"]);
  assert.deepEqual(certifiedLibraryOrder(V2_ID), ["rough", "finish", "profile", "release"]);
  assert.equal(manifest.order.includes("cleanup"), false);
  assert.equal(manifest.order.includes("detail"), false);
  const omitted = manifest.omittedStages.map((o) => o.stage).sort();
  assert.deepEqual(omitted, ["cleanup", "detail"]);
  for (const entry of manifest.omittedStages) assert.ok(entry.reason.length > 40, entry.stage + " records a reason");
  // 3.91 h, down from v1's 20.27 h.
  assert.ok(manifest.totals.hours > 3.8 && manifest.totals.hours < 4.0, "programmed hours " + manifest.totals.hours);
  assert.equal(LIBRARIES["rambo-buckle-c752-v1"].superseded, true);
  assert.equal(LIBRARIES["rambo-buckle-c752-v1"].supersededBy, V2_ID);
});

test("every v2 program is byte-identical to the committed cam-v3 artifact", () => {
  const { manifest, programs } = loadCertifiedLibrary(V2_ID);
  const camManifest = JSON.parse(readFileSync(join(CAM_V3, "manifest.json"), "utf8"));
  for (const stage of manifest.order) {
    const meta = manifest.stages[stage];
    const installed = gunzipSync(Buffer.from(programs[stage].gzipBase64, "base64"));
    const artifact = readFileSync(join(CAM_V3, meta.file));
    assert.ok(installed.equals(artifact), stage + " installed bytes equal the committed .nc");
    const sha = createHash("sha256").update(installed).digest("hex");
    assert.equal(sha, meta.sha256, stage + " SHA-256");
    // And the same hash the generator independently recorded.
    const fromCam = camManifest.stages.find((s) => s.stage === stage);
    assert.equal(fromCam.sha256, meta.sha256, stage + " matches the generator manifest");
    assert.equal(fromCam.bytes, meta.bytes);
    assert.equal(fromCam.lines, meta.lines);
    assert.equal(fromCam.minZ, meta.minZ);
    assert.deepEqual(fromCam.bounds, meta.bounds);
  }
});

test("v2 motion safety is measured from the bytes, not asserted", () => {
  const { manifest, programs } = loadCertifiedLibrary(V2_ID);
  for (const stage of manifest.order) {
    const m = programs[stage].metrics, meta = manifest.stages[stage];
    assert.equal(m.rapidBelowSurface, 0, stage + " never rapids at or below the surface");
    assert.equal(m.verticalEntryDepth, 0, stage + " never plunges vertically into the metal");
    assert.equal(m.finalRetractMm, 4.99, stage + " parks at the clearance plane");
    assert.equal(m.lines, meta.lines);
    assert.ok(m.maxDescentPerCutMove <= meta.maxDescentPerCutMove + 0.0002, stage + " descent per cutting move");
    assert.equal(programs[stage].certificate.provider, "openclaw-cam");
    assert.equal(programs[stage].certificate.certification, "verified");
    assert.match(programs[stage].certificate.auditHash, /^[a-f0-9]{64}$/);
  }
  // Rough and Finish stay inside the relief; Profile and Release go through.
  assert.ok(manifest.stages.rough.minZ > -1 && manifest.stages.finish.minZ > -1);
  assert.equal(manifest.stages.profile.minZ, -3.955);
  assert.equal(manifest.stages.release.minZ, -3.955);
  assert.equal(manifest.stages.profile.tabs, 6);
  assert.equal(manifest.stages.release.tabs, 6);
});

test("v2 records that its stock thickness came from a different blank", () => {
  const { manifest } = loadCertifiedLibrary(V2_ID);
  assert.equal(manifest.stock.thicknessMeasuredOnThisBlank, false);
  assert.equal(manifest.stock.thicknessMm, 3.855);
  assert.match(manifest.stock.thicknessMeasuredOn, /previous damaged/i);
  // Through-depth is the measured sheet plus the sacrificial allowance, and that
  // is exactly the depth the two through-cut programs reach.
  assert.equal(manifest.profile.depthMm, 3.955);
  assert.equal(manifest.profile.sacrificialAllowanceMm, 0.1);
  assert.equal(+(manifest.stock.thicknessMm + manifest.profile.sacrificialAllowanceMm).toFixed(3), manifest.profile.depthMm);
  assert.equal(-manifest.profile.depthMm, manifest.stages.profile.minZ);
  assert.equal(-manifest.profile.depthMm, manifest.stages.release.minZ);
  // Exactly the stages that cut through are the ones declared thickness-sensitive.
  assert.deepEqual(certifiedThicknessSensitiveStages(V2_ID), ["profile", "release"]);
  for (const stage of manifest.order) {
    assert.equal(manifest.stages[stage].cutsThroughStock, manifest.thicknessSensitiveStages.includes(stage), stage);
  }
});

test("the v2 audit refuses each safety property it certifies", () => {
  const { manifest, programs } = loadCertifiedLibrary(V2_ID);
  const contract = manifest.stages.release;
  const raw = gunzipSync(Buffer.from(programs.release.gzipBase64, "base64")).toString("utf8");
  assert.doesNotThrow(() => auditProgram(raw, "release", contract, manifest));

  // A rapid taken to or below the surface — the 2026-09-30 damage mechanism.
  assert.throws(() => auditProgram(raw.replace("G0 Z4.99 F300", "G0 Z-0.0100 F300"), "release", contract, manifest), /rapid move at or below/);
  // Any controller, spindle or tool-change command at all.
  assert.throws(() => auditProgram(raw.replace("M30", "G92 X0\nM30"), "release", contract, manifest), /forbidden controller/);
  assert.throws(() => auditProgram(raw.replace("M30", "M3 S10000\nM30"), "release", contract, manifest), /forbidden controller/);
  // Not parking at the clearance plane.
  assert.throws(() => auditProgram(raw.replace(/G0 Z4\.99\nM30\s*$/, "G0 Z1.00\nM30\n"), "release", contract, manifest), /safe retract/);
  // A deeper cut than the certificate allows.
  assert.throws(() => auditProgram(raw.replace("Z-3.955", "Z-4.955"), "release", contract, manifest), /depth does not match|motion bounds|line count/);
  // A faster cutting feed than the solver produced.
  assert.throws(() => auditProgram(raw.replace(/F576/g, "F1576"), "release", contract, manifest), /certified cutting feed/);
  // A line-count change, which is how an edited program announces itself.
  assert.throws(() => auditProgram(raw + "\n(extra)\n", "release", contract, manifest), /line count/);
  // Mixing up two stages' certificates.
  assert.throws(() => auditProgram(raw, "release", manifest.stages.profile, manifest), /line count/);
});

test("the v2 audit catches a deepened single cutting move that stays in bounds", () => {
  const { manifest, programs } = loadCertifiedLibrary(V2_ID);
  const contract = manifest.stages.rough;
  const raw = gunzipSync(Buffer.from(programs.rough.gzipBase64, "base64")).toString("utf8");
  assert.doesNotThrow(() => auditProgram(raw, "rough", contract, manifest));
  // Pin the ceiling one notch below what the program actually does, which is the
  // same comparison a re-posting with a more aggressive descent would fail.
  const tightened = { ...contract, maxDescentPerCutMove: contract.maxDescentPerCutMove - 0.01 };
  assert.throws(() => auditProgram(raw, "rough", tightened, manifest), /descends further in one cutting move/);
});

test("v1 still loads and its certificates are unchanged by the v2 work", () => {
  const v1 = loadCertifiedLibrary("rambo-buckle-c752-v1");
  assert.deepEqual(v1.manifest.order, ["rough", "cleanup", "finish", "profile", "release"]);
  assert.equal(v1.manifest.provider, "kiri-moto");
  // v1's audit does not pin a per-move descent ceiling, so that measurement is
  // absent from its metrics — which is what keeps its issued audit hashes stable.
  for (const stage of v1.manifest.order) {
    assert.equal(v1.programs[stage].metrics.maxDescentPerCutMove, undefined, stage);
    assert.equal(v1.programs[stage].certificate.provider, "kiri-moto");
  }
  // Pinned so adding a measurement to the audit can never silently re-issue an
  // already-stored v1 certificate under an installed job.
  assert.deepEqual(
    Object.fromEntries(v1.manifest.order.map((s) => [s, v1.programs[s].certificate.auditHash])),
    {
      rough: "db9daa53b2abc87cba6f5595b2f72885ac9dc214b5f4793dbb75c36ffec870eb",
      cleanup: "9c26164d3372fd47d333cea157deb774aa23a037c33daca0e3511ae7da73149e",
      finish: "97f9a3d7c523789851e5086a9e4e8519f212d16cef72b23b79d50f073221bc6a",
      profile: "e3a32eba7c5e58e546e11d46904d6bdfdcc987116d9a56389d00d90cb3ae32fe",
      release: "fa2494e29d543a6210414b85bc403b258cd722fd51bed63209996d3d95b386d1",
    },
  );
  assert.throws(() => loadCertifiedLibrary("rambo-buckle-c752-v3"), /Unknown certified CNC program/);
});
