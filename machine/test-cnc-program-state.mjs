import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readProgram, saveProgram } from "./cnc-program-state.mjs";

const GCODE = "G21\nG90\nM3 S9000\nG0 X0 Y0 Z3\nG1 X10 Y10 Z-3 F480\nM5\nM2";

test("accepted CNC programs are atomically persisted with their analyzed envelope", () => {
  const dir = mkdtempSync(join(tmpdir(), "cnc-program-")), path = join(dir, "last.json");
  const saved = saveProgram(path, { version: 1, jobId: "wood-3mm", gcode: GCODE, state: "accepted", context: { stockWidthMm: 304.8, stockHeightMm: 304.8, stockReserveMm: 5 } });
  assert.equal(saved.analysis.bounds.Z.min, -3);
  assert.equal(saved.analysis.executableLines, 7);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.doesNotMatch(readFileSync(path, "utf8"), /undefined/);
  assert.deepEqual(readProgram(path), saved);
});
