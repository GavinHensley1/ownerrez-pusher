import assert from "node:assert/strict";
import test from "node:test";
import { inspectEffectiveCutFrame } from "./cnc-effective-frame.mjs";
import { inspectSavedFrame } from "./cnc-frame-recovery.mjs";

const origin = { X: -92, Y: -145, Z: -36.319 };
function fixture() {
  return {
    modalLines: ["[GC:G0 G54 G17 G21 G90 G94 M5 M9 T0 F0 S0]", "ok"],
    parameterLines: ["[G54:-92.000,-145.000,-36.319,0.000]", "[G92:0.000,0.000,0.000,0.000]", "[TLO:0.000]", "ok"],
    status: { state: "Idle", MPos: "-92.000,-145.000,11.681,0.000", WCO: "-92.000,-145.000,-36.319,0.000" },
    expectedOrigin: { ...origin },
  };
}

test("reproduces saved G54 continuity accepting an unverified active WCS", () => {
  const input = fixture();
  input.modalLines[0] = input.modalLines[0].replace("G54", "G55");
  // G55 could place the cutter 1.04 mm below the assumed physical stock datum.
  // This reproduces an assurance gap, not the cause of the actual incident.
  input.status.WCO = "-92,-145,-37.359,0";
  const old = inspectSavedFrame({ status: input.status, workOffset: origin,
    xyLock: { xyOriginMPos: origin, lastKnownMPos: { X: -92, Y: -145 } },
    probeLock: { zOriginMPos: origin.Z, lastKnownMPos: { Z: 11.681 } } });
  assert.equal(old.xy, true);
  assert.equal(old.z, true);
  assert(Math.abs((-0.06 + -37.359) - origin.Z - (-1.1)) < 1e-9);
  assert.throws(() => inspectEffectiveCutFrame(input), /active G54/);
});

test("verifies XYZ calibrated origins without issuing commands or altering inputs", () => {
  const input = fixture(), before = structuredClone(input);
  const result = inspectEffectiveCutFrame(input);
  assert.equal(result.verified, true);
  assert.deepEqual(result.workPosition, { X: 0, Y: 0, Z: 48 });
  assert.deepEqual(input, before);
  delete input.status.WCO;
  assert.equal(inspectEffectiveCutFrame(input).reportedWco, null);
});

test("rejects G92 and tool-length offsets, including sub-tolerance offsets", () => {
  for (const [record, replacement, message] of [
    [1, "[G92:0,0,-1.04]", /G92 Z/], [1, "[G92:0.001,0,0]", /G92 X/],
    [2, "[TLO:-1.04]", /tool-length offset/],
  ]) {
    const input = fixture(); input.parameterLines[record] = replacement;
    assert.throws(() => inspectEffectiveCutFrame(input), message);
  }
  const input = fixture(); input.modalLines[0] = input.modalLines[0].replace("G94", "G94 G43.1");
  assert.throws(() => inspectEffectiveCutFrame(input), /inactive tool-length/);
});

test("rejects stale G54, contradictory effective WCO, non-Idle and inverse-time feed", () => {
  const changed = fixture(); changed.parameterLines[0] = "[G54:-92,-145,-37.359]";
  assert.throws(() => inspectEffectiveCutFrame(changed), /G54 Z differs/);
  const wco = fixture(); wco.status.WCO = "-92,-145,-37.359";
  assert.throws(() => inspectEffectiveCutFrame(wco), /WCO Z differs/);
  const held = fixture(); held.status.state = "Hold:0";
  assert.throws(() => inspectEffectiveCutFrame(held), /Idle/);
  const feed = fixture(); feed.modalLines[0] = feed.modalLines[0].replace("G94", "G93");
  assert.throws(() => inspectEffectiveCutFrame(feed), /G94/);
});

test("rejects missing, ambiguous, malformed, or non-machine-coordinate evidence", () => {
  for (const label of ["G54", "G92", "TLO"]) {
    const missing = fixture(); missing.parameterLines = missing.parameterLines.filter(line => !line.startsWith(`[${label}:`));
    assert.throws(() => inspectEffectiveCutFrame(missing), /missing or ambiguous/);
    const duplicate = fixture(); duplicate.parameterLines.push(duplicate.parameterLines.find(line => line.startsWith(`[${label}:`)));
    assert.throws(() => inspectEffectiveCutFrame(duplicate), /missing or ambiguous/);
  }
  const absent = fixture(); absent.modalLines = ["ok"];
  assert.throws(() => inspectEffectiveCutFrame(absent), /GC response/);
  const noMpos = fixture(); delete noMpos.status.MPos; noMpos.status.WPos = "0,0,48";
  assert.throws(() => inspectEffectiveCutFrame(noMpos), /MPos/);
  const malformed = fixture(); malformed.parameterLines[1] = "[G92:0,,0]";
  assert.throws(() => inspectEffectiveCutFrame(malformed), /invalid/);
  const noOrigin = fixture(); noOrigin.expectedOrigin.Z = null;
  assert.throws(() => inspectEffectiveCutFrame(noOrigin), /origin is unavailable/);
});
