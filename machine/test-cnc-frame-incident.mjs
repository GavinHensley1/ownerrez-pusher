import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assertFrameValid, readFrameIncident, writeFrameIncident } from "./cnc-frame-incident.mjs";

test("frame-invalid transport incident persists across process restarts and blocks motion", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "cnc-frame-incident-"));
  const file = path.join(root, "incident.json");
  try {
    assert.equal(readFrameIncident(file), null);
    const written = writeFrameIncident(file, { reason: "GRBL response timeout for motion command", duringMotion: true, jobId: "metal-rough" });
    assert.equal(written.frameValid, false);
    assert.equal(written.duringMotion, true);
    const restored = readFrameIncident(file);
    assert.equal(restored.reason, "GRBL response timeout for motion command");
    assert.throws(() => assertFrameValid(restored), /Re-establish X\/Y and Z through visible Project controls/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
