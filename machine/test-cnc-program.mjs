import assert from "node:assert/strict";
import test from "node:test";
import { analyzeProgram, cleanProgramLine, measuredStockProtection, validateProgramEnvelope, validateProgramStockEnvelope } from "./cnc-program.mjs";

const safe = `; sample\nG21\nG90\nG17\nG0 Z2\nM3 S9000\nG0 X0 Y0\nG1 Z-1 F100\nG1 X100 Y80 F200\nG0 Z2\nM5\nM2`;

test("cleans comments and analyzes a bounded generated program", () => {
  assert.equal(cleanProgramLine("G1 X1 ; note"), "G1 X1");
  const result = analyzeProgram(safe);
  assert.equal(result.maxSpindleRpm, 9000);
  assert.deepEqual(result.bounds.X, { min: 0, max: 100 });
  assert.equal(validateProgramEnvelope(result, { widthMm: 360, heightMm: 360, maxDepthMm: 68, maxSafeZMm: 5 }), true);
});

test("rejects embedded probing, settings, relative motion, and excessive RPM", () => {
  for (const bad of [
    safe.replace("G1 Z-1", "G38.2 Z-20"),
    safe.replace("G17", "$22=1"),
    safe.replace("G90", "G91"),
    safe.replace("S9000", "S10000"),
    safe.replace("X100", "A100"),
  ]) assert.throws(() => analyzeProgram(bad));
});

test("permits a small negative profile offset but not an unbounded one", () => {
  assert.doesNotThrow(() => analyzeProgram(safe.replace("X0", "X-1.588")));
  assert.throws(() => analyzeProgram(safe.replace("X0", "X-11")), /at most 10 mm/);
});

test("rejects a program outside the software travel envelope", () => {
  assert.throws(() => validateProgramEnvelope(analyzeProgram(safe.replace("X100", "X361")), { widthMm: 360, heightMm: 360, maxDepthMm: 68, maxSafeZMm: 5 }), /exceeds/);
  assert.throws(() => validateProgramEnvelope(analyzeProgram(safe.replace("Z-1", "Z-69")), { widthMm: 360, heightMm: 360, maxDepthMm: 68, maxSafeZMm: 5 }), /depth/);
});

test("requires the complete program to fit actual stock from stock-corner zero", () => {
  const analysis = analyzeProgram(safe);
  assert.equal(validateProgramStockEnvelope(analysis, { widthMm: 304.8, heightMm: 304.8, reserveMm: 5 }), true);
  assert.throws(() => validateProgramStockEnvelope(analysis, { widthMm: 99, heightMm: 304.8 }), /X maximum/);
  assert.throws(() => validateProgramStockEnvelope(analyzeProgram(safe.replace("X0", "X-1")), { widthMm: 304.8, heightMm: 304.8 }), /outside the stock-corner zero/);
});

test("derives a protected no-cut-through depth from two measured surfaces", () => {
  assert.deepEqual(measuredStockProtection(10, 22), { stockThicknessMm: 12, safetyFloorMm: 0.8, maxCutDepthMm: 11.2 });
  assert.deepEqual(measuredStockProtection(-30, -10), { stockThicknessMm: 20, safetyFloorMm: 1, maxCutDepthMm: 19 });
  assert.throws(() => measuredStockProtection(10, 10.5), /outside the safe/);
});
