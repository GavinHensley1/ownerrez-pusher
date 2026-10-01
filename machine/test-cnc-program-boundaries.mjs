// G-code word boundaries. Whitespace between words is OPTIONAL in RS-274 and
// GRBL executes compact lines, but \b does not match between a digit and a
// letter, so every guard anchored on \b silently stopped working on compact
// input. analyzeProgram's whitespace rule meant this was latent rather than
// live; these tests keep the line-level guards genuinely load-bearing so they
// still protect if that rule is ever relaxed, and because the plunge helpers are
// exported and can be called directly on unvalidated text.
import test from "node:test";
import assert from "node:assert/strict";
import { analyzeProgram, assertPlungeFeedWithinLimit, limitVerticalPlungeFeed } from "./cnc-program.mjs";

const PREAMBLE = "G21\nG90\n";

test("the vertical plunge limit catches every legal Z number form, spaced or compact", () => {
  const overLimit = [
    "G1 Z-0.5 F600", "G1Z-0.5F600",      // the compact form that used to pass at 600
    "G1 Z-.5 F600", "G1Z-.5F600",        // leading-dot, which `Z[-+]?\d` misses
    "G1 Z.5 F600", "G1Z.5F600",
    "G01 Z-1 F600", "G01Z-1F600",        // G01 spelled with a leading zero
    "G1 Z+0.5 F600", "G1Z+0.5F600",      // explicit plus sign
  ];
  for (const line of overLimit) {
    assert.throws(() => assertPlungeFeedWithinLimit(`${PREAMBLE}F30\n${line}\n`, 60), /plunge at 600/, `${line} must be refused`);
  }
});

test("an inherited modal feed is still caught in compact form", () => {
  // No F word on the plunge line at all: the rate comes from an earlier modal F.
  assert.throws(() => assertPlungeFeedWithinLimit(`${PREAMBLE}F600\nG1Z-0.5\n`, 60), /inherited from an earlier modal F/);
});

test("legitimate plunges at or below the limit are not refused", () => {
  for (const line of ["G1 Z-0.5 F30", "G1Z-0.5F30", "G1 Z-0.5 F60", "G1Z-.06F30"]) {
    assert.deepEqual(assertPlungeFeedWithinLimit(`${PREAMBLE}${line}\n`, 60), { ok: true, limitMmPerMin: 60 });
  }
  // A move WITH X/Y is not a vertical plunge and keeps its own feed.
  assert.deepEqual(assertPlungeFeedWithinLimit(`${PREAMBLE}G1X10Y10Z-0.5F600\n`, 60), { ok: true, limitMmPerMin: 60 });
});

test("the clamping rewrite also reaches the compact form", () => {
  assert.match(limitVerticalPlungeFeed(`${PREAMBLE}G1Z-0.5F600\n`, 60), /G1Z-0\.5F60\n/);
  assert.match(limitVerticalPlungeFeed(`${PREAMBLE}G1 Z-0.5 F600\n`, 60), /G1 Z-0\.5 F60\n/);
  // Below the limit is left byte-identical rather than rewritten.
  assert.match(limitVerticalPlungeFeed(`${PREAMBLE}G1Z-0.5F30\n`, 60), /G1Z-0\.5F30\n/);
});

test("compact unsafe coordinate and mode words are refused, not just spaced ones", () => {
  // analyzeProgram refuses compact input outright; assert the REASON is a safety
  // refusal in every case rather than silently depending on which guard fired.
  for (const line of ["G1X0G92Z0", "G0X1G53", "G1X1G91", "G1X1G28", "G1X1G10"]) {
    assert.throws(() => analyzeProgram(`${PREAMBLE}${line}\n`), /not allowed|separated by whitespace|Unsupported/, `${line} must be refused`);
  }
});

test("G92 variants are caught without catching unrelated higher G numbers", () => {
  assert.throws(() => analyzeProgram(`${PREAMBLE}G92 X0\n`), /Unsafe coordinate\/probe command/);
  assert.throws(() => analyzeProgram(`${PREAMBLE}G92.1\n`), /Unsafe coordinate\/probe command/);
  // G921 is not a G92. It is simply an unsupported code, and must be reported as
  // that rather than as an unsafe-coordinate command, so the boundary is proven
  // to be a boundary and not a prefix match.
  assert.throws(() => analyzeProgram(`${PREAMBLE}G921\n`), /Unsupported G-code G921/);
});

test("M30 is still allowed only as the terminal command", () => {
  const body = `${PREAMBLE}G0 Z5\nG1 Z-0.5 F30\nG0 Z5\n`;
  // Terminal M30 is fine.
  assert.ok(analyzeProgram(`${body}M30\n`, { spindleMode: "manual" }));
  // A non-terminal one is not, in either spacing.
  assert.throws(() => analyzeProgram(`${PREAMBLE}G1X1M30\nG0 Z5\n`, { spindleMode: "manual" }), /M2\/M30|separated by whitespace/);
});
