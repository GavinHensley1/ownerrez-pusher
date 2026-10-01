import assert from "node:assert/strict";
import test from "node:test";
import { analyzeProgram, approvedProgramDepth, assertPlungeFeedWithinLimit, cleanProgramLine, limitVerticalPlungeFeed, measuredStockProtection, validateProgramEnvelope, validateProgramStockEnvelope } from "./cnc-program.mjs";

const safe = `; sample\nG21\nG90\nG17\nG0 Z2\nM3 S9000\nG0 X0 Y0\nG1 Z-1 F100\nG1 X100 Y80 F200\nG0 Z2\nM5\nM2`;

test("cleans comments and analyzes a bounded generated program", () => {
  assert.equal(cleanProgramLine("G1 X1 ; note"), "G1 X1");
  const result = analyzeProgram(safe);
  assert.equal(result.maxSpindleRpm, 9000);
  assert.deepEqual(result.bounds.X, { min: 0, max: 100 });
  assert.equal(validateProgramEnvelope(result, { widthMm: 360, heightMm: 360, maxDepthMm: 68, maxSafeZMm: 5 }), true);
});

test("manual-router programs omit controller spindle commands while controller programs require them", () => {
  const manual = safe.replace("M3 S9000\n", "").replace("M5\n", "");
  const analyzed = analyzeProgram(manual, { spindleMode: "manual" });
  assert.equal(analyzed.spindleMode, "manual");
  assert.equal(analyzed.lines.at(-1), "G0 Z2");
  assert(!analyzed.lines.includes("M2"));
  assert.throws(() => analyzeProgram(manual), /Controller-spindle G-code must contain both M3 and M5/);
  assert.throws(() => analyzeProgram(safe, { spindleMode: "manual" }), /Manual-router G-code must not contain/);
});

test("manual-router analysis omits only terminal M2/M30", () => {
  const manual = "G21\nG90\nG17\nG0 Z3\nG0 X0 Y0\nM30";
  const analyzed = analyzeProgram(manual, { spindleMode: "manual" });
  assert.deepEqual(analyzed.lines, ["G21", "G90", "G17", "G0 Z3", "G0 X0 Y0"]);
  assert.throws(() => analyzeProgram(manual.replace("G0 X0 Y0\nM30", "M2\nG0 X0 Y0"), { spindleMode: "manual" }), /terminal command/);
});

test("caps pure vertical plunge feeds without changing cutting moves", () => {
  const source = "G1 Z-0.2 F150\nG1 X10 Z-0.3 F480\nG1 Z-0.4 F40";
  assert.equal(limitVerticalPlungeFeed(source, 60), "G1 Z-0.2 F60\nG1 X10 Z-0.3 F480\nG1 Z-0.4 F40");
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

test("permits a bounded sacrificial through-cut only for profile and final release", () => {
  const setup = { stockThicknessMm: 3.914, maxCutDepthMm: 3.114 };
  assert.equal(approvedProgramDepth(setup, { operation: "rough", allowSacrificialCutThrough: true, sacrificialBackingConfirmed: true, profileDepthMm: 4.014 }), 3.114);
  assert.equal(approvedProgramDepth(setup, { operation: "profile", allowSacrificialCutThrough: true, sacrificialBackingConfirmed: true, profileDepthMm: 4.014 }), 4.014);
  assert.equal(approvedProgramDepth(setup, { operation: "release", allowSacrificialCutThrough: true, sacrificialBackingConfirmed: true, profileDepthMm: 4.014 }), 4.014);
  assert.throws(() => approvedProgramDepth(setup, { operation: "profile", allowSacrificialCutThrough: true, profileDepthMm: 4.014 }), /Sacrificial backing confirmation/);
  assert.throws(() => approvedProgramDepth(setup, { operation: "profile", allowSacrificialCutThrough: true, sacrificialBackingConfirmed: true, profileDepthMm: 4.2 }), /outside the approved/);
});


test("modal declarations must precede motion and G1 must establish a positive feed", () => {
  for (const program of ["G0 Z2\nG21\nG90", "G21\nG0 Z2\nG90", "G21\nG90\nG1 X1", "G21\nG90\nG1 X1 F0", "G21\nG90\nG1 X1 F-10", "G21\nG90\nX1"])
    assert.throws(() => analyzeProgram(program, {spindleMode:"manual"}));
});

test("compact and duplicate-word G-code cannot bypass downstream mode and bounds checks", () => {
  assert.throws(() => analyzeProgram("G21G90\nG0X0Y0Z2\nG1X100Y80Z-1F100", {spindleMode:"manual"}), /separated by whitespace/);
  for (const line of ["G91X1", "G92Z0", "G10L20P1Z0", "G1X1X2F100", "G0G1X1F100", "G1X1F0", "M3S1000"])
    assert.throws(() => analyzeProgram("G21\nG90\nG0 Z2\n" + line, {spindleMode:"manual"}));
});

test("vertical plunge limiter catches leading-dot Z forms and modal inherited feeds", () => {
  // Leading-dot Z is legal G-code and must not slip past the limiter.
  assert.equal(limitVerticalPlungeFeed("G1 Z-.5 F600", 60), "G1 Z-.5 F60");
  assert.equal(limitVerticalPlungeFeed("G1 Z.5 F600", 60), "G1 Z.5 F60");
  assert.equal(limitVerticalPlungeFeed("g1 z-2.0 f600", 60), "g1 z-2.0 F60");
  // A plunge with an XY component is a ramp, not a plunge, and is left alone.
  assert.equal(limitVerticalPlungeFeed("G1 X10 Z-2.0 F600", 60), "G1 X10 Z-2.0 F600");

  // Feed is modal, so a plunge with no F word inherits an earlier feed. Rewriting it
  // would change every later move, so the program is refused instead.
  assert.throws(() => assertPlungeFeedWithinLimit("G1 X10 Y10 F900\nG1 Z-2.0", 60), /inherited from an earlier modal F/);
  assert.throws(() => assertPlungeFeedWithinLimit("G1 Z-2.0", 60), /no feed rate established/);
  // Within the limit, modal or explicit, it passes.
  assert.deepEqual(assertPlungeFeedWithinLimit("G1 X10 Y10 F30\nG1 Z-2.0", 60), { ok: true, limitMmPerMin: 60 });
  assert.deepEqual(assertPlungeFeedWithinLimit("G1 Z-2.0 F60", 60), { ok: true, limitMmPerMin: 60 });
  // The rewrite pass plus this assertion together leave no fast plunge behind.
  assert.deepEqual(assertPlungeFeedWithinLimit(limitVerticalPlungeFeed("G1 Z-.5 F600", 60), 60), { ok: true, limitMmPerMin: 60 });
});
