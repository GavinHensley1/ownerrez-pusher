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

test("persists the explicit manual-router contract for spindle-free staged programs", () => {
  const dir = mkdtempSync(join(tmpdir(), "cnc-program-manual-")), path = join(dir, "last.json");
  const manual = GCODE.replace("M3 S9000\n", "").replace("M5\n", "");
  const saved = saveProgram(path, { version: 1, jobId: "buckle-rough", gcode: manual, state: "accepted", context: { stockWidthMm: 140, stockHeightMm: 241, stockReserveMm: 5, manualRouter: true } });
  assert.equal(saved.context.manualRouter, true);
  assert.equal(saved.analysis.spindleMode, "manual");
  assert.deepEqual(readProgram(path), saved);
});

test("persists certified external CAM provenance for metal without weakening hashes", () => {
  const dir = mkdtempSync(join(tmpdir(), "cnc-program-cam-")), path = join(dir, "last.json"), hash = "a".repeat(64), audit = "b".repeat(64);
  const manual = GCODE.replace("M3 S9000\n", "").replace("M5\n", "");
  const saved = saveProgram(path, { version: 1, jobId: "metal-kiri-rough", gcode: manual, state: "accepted", context: { stockWidthMm: 260, stockHeightMm: 130, stockReserveMm: 5, manualRouter: true, operation: "rough", material: "C752 nickel silver", camProvider: "kiri-moto", camCertification: "verified", camSourceHash: hash, camAuditHash: audit, camStage: "rough", camTool: "Whiteside RU2100" } });
  assert.equal(saved.context.camProvider, "kiri-moto");
  assert.equal(saved.context.camCertification, "verified");
  assert.equal(saved.context.camSourceHash, hash);
  assert.equal(saved.context.camAuditHash, audit);
  assert.equal(saved.context.camStage, "rough");
  assert.equal(saved.context.camTool, "Whiteside RU2100");
  assert.deepEqual(readProgram(path), saved);
});

test("persists the distinct W01015 cleanup CAM stage", () => {
  const dir = mkdtempSync(join(tmpdir(), "cnc-program-cleanup-")), path = join(dir, "last.json"), hash = "c".repeat(64), audit = "d".repeat(64);
  const manual = GCODE.replace("M3 S9000\n", "").replace("M5\n", "");
  const saved = saveProgram(path, { version: 1, jobId: "metal-kiri-cleanup", gcode: manual, state: "accepted", context: { stockWidthMm: 260, stockHeightMm: 130, stockReserveMm: 5, manualRouter: true, operation: "cleanup", material: "C752 nickel silver", camProvider: "kiri-moto", camCertification: "verified", camSourceHash: hash, camAuditHash: audit, camStage: "cleanup", camTool: "SpeTool W01015-SPE-X" } });
  assert.equal(saved.context.operation, "cleanup");
  assert.equal(saved.context.camStage, "cleanup");
  assert.equal(saved.context.camTool, "SpeTool W01015-SPE-X");
});
