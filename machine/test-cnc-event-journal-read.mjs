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
  assert.deepEqual(readLatestCompletedStockProbe(path), { at: "2026-09-29T15:20:00.000Z", stockThicknessMm: 3.914, safetyFloorMm: 0.8, maxCutDepthMm: 3.114 });
});
