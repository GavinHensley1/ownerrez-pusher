// Resume must not quietly leave part of the carve uncut, and must not drag the
// cutter sideways through stock to get back to work.
//
// TWO AUDITED DEFECTS THESE LOCK DOWN:
// 1. buildResumeProgram scans FORWARD from the stop point to the next safe
//    retract and resumes there, silently abandoning every cutting move in
//    between. The job then ran to "Carve complete" at 100% with a hole in the
//    toolpath, so the operator had no way to know material was missed.
// 2. The retract/rewind line a resume starts on can be a COMBINED `G0 X Y Z`.
//    Executed with the cutter still down in the stock, that moves all three axes
//    at once and drags the tool sideways through the material while it lifts.
import test from "node:test";
import assert from "node:assert/strict";
import { buildCheckpointReplayResume, buildResumeProgram } from "./cnc-resume.mjs";

const MANUAL = { spindleMode: "manual" };
// analysis.lines counts EVERY executable line, so the G21/G90/G17 preamble
// occupies lines 1-3 and the first move is line 4. Express that once instead of
// hand-counting it into every assertion.
const PREAMBLE = ["G21", "G90", "G17"];
const program = (...moves) => [...PREAMBLE, ...moves].join("\n");
// 1-based program line for the Nth move.
const at = (move) => PREAMBLE.length + move;

// Stops mid-pass: cutting moves remain before the next retract.
const MID_PASS = program(
  "G0 Z5",            // move 1
  "G0 X0 Y0",         // move 2
  "G1 Z-0.5 F30",     // move 3
  "G1 X10 Y0 F200",   // move 4  <- stop after this
  "G1 X20 Y0 F200",   // move 5  abandoned cutting move
  "G1 X30 Y0 F200",   // move 6  abandoned cutting move
  "G0 Z5",            // move 7  next safe retract
  "G0 X40 Y0",        // move 8
  "G1 Z-0.5 F30",     // move 9
  "G1 X50 Y0 F200",   // move 10
  "G0 Z5",            // move 11
);

test("a resume that would abandon cutting moves is REFUSED, not silently truncated", () => {
  assert.throws(() => buildResumeProgram(MID_PASS, at(4), MANUAL), (error) => {
    assert.match(error.message, /abandon 2 cutting moves/);
    // Name the span, so the operator can see exactly what would be skipped.
    assert.match(error.message, new RegExp(`between line ${at(5)} and the next safe retract at line ${at(7)}`));
    assert.match(error.message, /reporting the carve complete/);
    assert.match(error.message, /Restart the stage from line 1/);
    return true;
  });
});

test("a resume that only skips rapids is still allowed", () => {
  // Stopping immediately before the retract abandons nothing, which is the
  // legitimate case this guard must not break.
  const resumed = buildResumeProgram(MID_PASS, at(6), MANUAL);
  assert.equal(resumed.resumeAtLine, at(7));
  assert.equal(resumed.skippedUnfinishedLines, 0);
  assert.match(resumed.gcode, /G1 X50 Y0 F200/);
});

test("the guard counts abandoned moves, it does not just look for any gap", () => {
  // Only rapids between the stop point and the retract: permitted.
  const rapidsOnly = program("G0 Z5", "G0 X0 Y0", "G1 Z-0.5 F30", "G1 X10 Y0 F200", "G0 X15 Y0", "G0 Z5", "G1 X20 Y0 F200", "G0 Z5");
  assert.ok(buildResumeProgram(rapidsOnly, at(4), MANUAL).gcode);
});

test("a resume beginning on a combined rapid lifts Z vertically FIRST", () => {
  // The next safe retract is a single combined move. Starting there with the
  // cutter down in the stock would drag it through the material.
  const combined = program(
    "G0 Z5",                 // move 1
    "G0 X0 Y0",              // move 2
    "G1 Z-0.5 F30",          // move 3
    "G1 X10 Y0 F200",        // move 4  <- stop after this
    "G0 X90 Y90 Z5",         // move 5  combined retract + reposition
    "G1 Z-0.5 F30",          // move 6
    "G1 X95 Y90 F200",       // move 7
    "G0 Z5",                 // move 8
  );
  const resumed = buildResumeProgram(combined, at(4), MANUAL);
  const body = resumed.gcode.split("\n").filter((line) => line && !line.startsWith(";"));
  // First motion command must be a pure vertical lift to the retract height.
  assert.equal(body[3], "G0 Z5", `expected a vertical lift first, got ${body[3]}`);
  // The original combined move follows, now safe because Z is already clear.
  assert.equal(body[4], "G0 X90 Y90 Z5");
  assert.match(resumed.gcode, /cannot drag X\/Y through stock/);
});

test("a resume beginning on a pure vertical retract adds no redundant lift", () => {
  const resumed = buildResumeProgram(MID_PASS, at(6), MANUAL);
  const lifts = resumed.gcode.split("\n").filter((line) => line.trim() === "G0 Z5");
  // Exactly the program's own two remaining retracts, with nothing inserted.
  assert.equal(lifts.length, 2);
  assert.doesNotMatch(resumed.gcode, /cannot drag X\/Y through stock/);
});

test("the checkpoint replay also lifts before a combined rewind target", () => {
  const combined = program(
    "G0 Z5",            // move 1
    "G0 X50 Y50 Z5",    // move 2  combined rewind target
    "G1 Z-0.5 F30",     // move 3
    "G1 X60 Y50 F200",  // move 4
    "G1 X70 Y50 F200",  // move 5  <- checkpoint here
    "G0 Z5",            // move 6
  );
  const resumed = buildCheckpointReplayResume(combined, at(5), MANUAL);
  assert.equal(resumed.resumeAtLine, at(2));
  const body = resumed.gcode.split("\n").filter((line) => line && !line.startsWith(";"));
  assert.equal(body[3], "G0 Z5");
  assert.equal(body[4], "G0 X50 Y50 Z5");
});

test("the checkpoint replay REDOES work rather than dropping it", () => {
  // It rewinds backward, so unlike the forward scan it never abandons moves and
  // must not be subject to the abandonment refusal.
  const resumed = buildCheckpointReplayResume(MID_PASS, at(6), MANUAL);
  assert.equal(resumed.resumeAtLine, at(1));
  assert.match(resumed.gcode, /G1 X10 Y0 F200/);
  assert.match(resumed.gcode, /G1 X30 Y0 F200/);
});

test("retract detection reads every legal Z form, including trailing-dot", () => {
  // `\bZ(...)\b` missed "Z5." because the trailing \b fails after a dot.
  for (const retract of ["G0 Z5", "G0 Z5.", "G0 Z5.0", "G0 Z+5", "G0 Z0"]) {
    const source = program("G0 Z5", "G0 X0 Y0", "G1 Z-0.5 F30", "G1 X10 Y0 F200", retract, "G1 X20 Y0 F200", "G0 Z5");
    assert.equal(buildResumeProgram(source, at(4), MANUAL).resumeAtLine, at(5), `${retract} must be seen as a safe retract`);
  }
});

test("a below-surface rapid is NOT mistaken for a safe retract", () => {
  const source = program("G0 Z5", "G0 X0 Y0", "G1 Z-0.5 F30", "G1 X10 Y0 F200", "G0 Z-0.2", "G0 Z5", "G1 X20 Y0 F200", "G0 Z5");
  // Must skip the below-surface rapid and land on the real retract.
  assert.equal(buildResumeProgram(source, at(4), MANUAL).resumeAtLine, at(6));
});
