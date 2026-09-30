import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildBufferedStopResume, buildCheckpointReplayResume, buildResumeProgram, programPositionAtLine } from "./cnc-resume.mjs";
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

test("buffered stop rewinds to the current row after stopping mid-motion", () => {
  const stopped = { X: 7.5, Y: 10, Z: -1.5 };
  const resumed = buildBufferedStopResume(PROGRAM, 8, stopped, { spindleMode: "manual" });
  assert.equal(resumed.interruptedLine, 7);
  assert.equal(resumed.resumeAtLine, 4);
  assert.equal(resumed.replayedLines, 3);
  assert.match(resumed.gcode, /G21\nG90\nG17\nG0 Z3\.6\nG0 X10 Y10/);
});

test("buffered stop accepts a controller position one line ahead of the durable checkpoint", () => {
  const oneBufferedLineAhead = { X: 0, Y: 10, Z: 0 };
  const resumed = buildBufferedStopResume(PROGRAM, 7, oneBufferedLineAhead, { spindleMode: "manual" });
  assert.equal(resumed.acknowledgedLine, 7);
  assert.equal(resumed.interruptedLine, 8);
  assert.equal(resumed.acknowledgedDeltaLines, 1);
  assert.equal(resumed.resumeAtLine, 4);
  assert.equal(resumed.replayedLines, 4);
  assert.equal(resumed.positionErrorMm, 0);
});

test("buffered stop rejects a controller position beyond the bounded forward window", () => {
  const longerProgram = ["G21", "G90", "G17", "G0 Z3.6", ...Array.from({ length: 24 }, (_, index) => `G1 X${index + 1} Z-1 F100`), "G0 Z3.6", "M2"].join("\n");
  assert.throws(
    () => buildBufferedStopResume(longerProgram, 5, { X: 22, Y: 0, Z: -1 }, { spindleMode: "manual", forwardSearchWindow: 4 }),
    /guarded checkpoint window/,
  );
});

test("buffered stop recovers the interrupted row after Z was safely retracted", () => {
  const stoppedAndRetracted = { X: 7.5, Y: 10, Z: 20 };
  const resumed = buildBufferedStopResume(PROGRAM, 8, stoppedAndRetracted, { spindleMode: "manual" });
  assert.equal(resumed.positionMatchMode, "xy-retracted");
  assert.equal(resumed.interruptedLine, 7);
  assert.equal(resumed.resumeAtLine, 4);
  assert.equal(resumed.positionErrorMm, 0);
  assert.match(resumed.gcode, /G21\nG90\nG17\nG0 Z3\.6\nG0 X10 Y10/);
});

test("checkpoint replay safely repositions after post-stop jogs without restarting line 1", () => {
  const resumed = buildCheckpointReplayResume(PROGRAM, 8, { spindleMode: "manual" });
  assert.equal(resumed.positionMatchMode, "checkpoint-reposition");
  assert.equal(resumed.resumeAtLine, 4);
  assert.equal(resumed.replayedLines, 5);
  assert.match(resumed.gcode, /G21\nG90\nG17\nG0 Z3\.6\nG0 X10 Y10/);
});

test("run checkpoints persist the last acknowledged line atomically", () => {
  const dir = mkdtempSync(join(tmpdir(), "cnc-run-")), path = join(dir, "run.json");
  const saved = writeRunCheckpoint(path, { version: 1, jobId: "rough", programCapturedAt: "now", state: "interrupted", lastCompletedLine: 152, totalLines: 3971, message: "read ETIMEDOUT", updatedAt: "later" });
  assert.deepEqual(readRunCheckpoint(path), saved);
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("run checkpoints persist post-stop positioning evidence", () => {
  const dir = mkdtempSync(join(tmpdir(), "cnc-run-position-")), path = join(dir, "run.json");
  const saved = writeRunCheckpoint(path, { version: 1, jobId: "detail", programCapturedAt: "now", state: "interrupted", lastCompletedLine: 8, totalLines: 14, message: "Stopped", updatedAt: "later", stopWorkPosition: { X: 7.5, Y: 10, Z: 3.6 }, postStopPosition: { X: 0, Y: -5, Z: 20 }, postStopMoveCount: 4, positionReason: "probe_tool", positionUpdatedAt: "after" });
  assert.deepEqual(saved.postStopPosition, { X: 0, Y: -5, Z: 20 });
  assert.equal(saved.postStopMoveCount, 4);
  assert.deepEqual(readRunCheckpoint(path), saved);
});
