import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildResumeProgram, programPositionAtLine } from "./cnc-resume.mjs";
import { readRunCheckpoint, writeRunCheckpoint } from "./cnc-run-state.mjs";

const PROGRAM = [
  "G21", "G90", "G17", "G0 Z3.6", "G0 X10 Y10", "G1 Z-1.5 F60", "G1 X5 Z-1.5 F900",
  "G1 X0 Z0", "G0 Z3.6", "G0 X0 Y8", "G1 Z-1.5 F60", "G1 X10 Z-1.5 F900", "G0 Z3.6", "M2",
].join("\n");

test("finds the exact modal work position at an acknowledged line", () => {
  assert.deepEqual(programPositionAtLine(PROGRAM, 7, { spindleMode: "manual" }).position, { X: 5, Y: 10, Z: -1.5 });
});

test("manual-router resume retracts and continues at the next row boundary", () => {
  const resumed = buildResumeProgram(PROGRAM, 7, { spindleMode: "manual" });
  assert.equal(resumed.resumeAtLine, 9);
  assert.equal(resumed.skippedUnfinishedLines, 1);
  assert.match(resumed.gcode, /G21\nG90\nG17\nG0 Z3\.6\nG0 X0 Y8/);
  assert.doesNotMatch(resumed.gcode, /G1 X0 Z0/);
});

test("run checkpoints persist the last acknowledged line atomically", () => {
  const dir = mkdtempSync(join(tmpdir(), "cnc-run-")), path = join(dir, "run.json");
  const saved = writeRunCheckpoint(path, { version: 1, jobId: "rough", programCapturedAt: "now", state: "interrupted", lastCompletedLine: 152, totalLines: 3971, message: "read ETIMEDOUT", updatedAt: "later" });
  assert.deepEqual(readRunCheckpoint(path), saved);
  assert.equal(statSync(path).mode & 0o777, 0o600);
});
