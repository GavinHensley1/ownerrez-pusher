import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readLatestCompletedStockProbe } from "./cnc-event-journal.mjs";

test("restores only the latest valid completed stock measurement", () => {
  const path = join(mkdtempSync(join(tmpdir(), "cnc-events-")), "events.jsonl");
  writeFileSync(path, [
    JSON.stringify({ at: "2026-09-29T15:00:00.000Z", type: "probe.completed", detail: { kind: "stock", stockThicknessMm: 4, maxCutDepthMm: 3.2 } }),
    "malformed",
    JSON.stringify({ at: "2026-09-29T15:10:00.000Z", type: "probe.completed", detail: { kind: "bed", stockThicknessMm: null, maxCutDepthMm: null } }),
    JSON.stringify({ at: "2026-09-29T15:20:00.000Z", type: "probe.completed", detail: { kind: "stock", stockThicknessMm: 3.914, maxCutDepthMm: 3.114 } }),
  ].join("\n") + "\n");
  // These legacy entries predate the absolute-reference fields, so they read back
  // as null rather than being skipped: still usable for reporting thickness, but a
  // caller that needs to prove Z continuity or the plate used must refuse them.
  assert.deepEqual(readLatestCompletedStockProbe(path), {
    at: "2026-09-29T15:20:00.000Z", stockThicknessMm: 3.914, safetyFloorMm: 0.8, maxCutDepthMm: 3.114,
    probeThickness: null, stockSurfaceMPos: null, bedSurfaceMPos: null, zOriginMPos: null,
  });
});

test("carries the plate used and the absolute Z references when the entry has them", () => {
  // restoreProbeAfterXyOnlyReset needs these to answer "which plate was this taken
  // with" and "is the controller's Z origin still the same one". Dropping them is
  // why that path read probeThickness as undefined and always threw, and why it
  // could adopt any G54 Z as the stock surface without a continuity check.
  const path = join(mkdtempSync(join(tmpdir(), "cnc-events-")), "events.jsonl");
  writeFileSync(path, JSON.stringify({
    at: "2026-10-01T12:00:00.000Z", type: "probe.completed",
    detail: { kind: "stock", stockThicknessMm: 3.855, maxCutDepthMm: 3.055, probeThickness: 14.19, stockSurfaceMPos: -36.319, bedSurfaceMPos: -40.174, zOriginMPos: -36.319 },
  }) + "\n");
  assert.deepEqual(readLatestCompletedStockProbe(path), {
    at: "2026-10-01T12:00:00.000Z", stockThicknessMm: 3.855, safetyFloorMm: 0.8, maxCutDepthMm: 3.055,
    probeThickness: 14.19, stockSurfaceMPos: -36.319, bedSurfaceMPos: -40.174, zOriginMPos: -36.319,
  });
});

test("a non-numeric absolute reference reads as null, never as zero", () => {
  // Coercing a missing origin to 0 would make the continuity check compare against
  // machine zero and pass for a machine that happens to sit near it.
  const path = join(mkdtempSync(join(tmpdir(), "cnc-events-")), "events.jsonl");
  writeFileSync(path, JSON.stringify({
    at: "2026-10-01T12:00:00.000Z", type: "probe.completed",
    detail: { kind: "stock", stockThicknessMm: 3.855, maxCutDepthMm: 3.055, probeThickness: "", stockSurfaceMPos: null, zOriginMPos: "n/a" },
  }) + "\n");
  const prior = readLatestCompletedStockProbe(path);
  assert.equal(prior.probeThickness, null);
  assert.equal(prior.stockSurfaceMPos, null);
  assert.equal(prior.zOriginMPos, null);
});
