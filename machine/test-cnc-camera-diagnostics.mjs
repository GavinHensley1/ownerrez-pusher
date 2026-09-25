import assert from "node:assert/strict";
import { cameraBridgeFresh, cameraFresh, consumeDiagnosticChunk, createDiagnostics, parseDiagnosticLine, selectAnalyzedCandidate } from "./cnc-camera-diagnostics.mjs";

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("tracks black intervals", () => {
  const state = createDiagnostics();
  parseDiagnosticLine(state, "frame:4 pblack:100 pts:4 t:4.0", 100);
  assert.deepEqual(state.blackFrames, [4]);
  assert.equal(state.lastBlackAt, 100);
});

test("tracks the frame analyzed by ffmpeg", () => {
  const state = createDiagnostics();
  parseDiagnosticLine(state, "[Parsed_showinfo_4 @ 0x1] n:   12 pts:12 pts_time:12", 100);
  assert.equal(state.lastAnalyzedFrame, 12);
});

test("publisher selects only the exact analyzed frame", () => {
  const state = createDiagnostics();
  parseDiagnosticLine(state, "frame:0 pblack:100 pts:0 t:0", 100);
  parseDiagnosticLine(state, "frame:1 pblack:100 pts:1 t:1", 200);
  parseDiagnosticLine(state, "[Parsed_showinfo_4 @ 0x1] n: 1 pts:1", 200);
  const candidate = selectAnalyzedCandidate([{ sequence: 1 }, { sequence: 2 }], state);
  assert.equal(candidate.sequence, 2);
  assert.equal(state.blackFrames.includes(candidate.sequence - 1), true);
});

test("tracks scene changes", () => {
  const state = createDiagnostics();
  parseDiagnosticLine(state, "lavfi.scd.score: 12.500, lavfi.scd.time: 3", 300);
  assert.equal(state.lastSceneScore, 12.5);
  assert.equal(state.lastSceneChangeAt, 300);
});

test("preserves diagnostics split across stderr chunks", () => {
  const state = createDiagnostics();
  let remainder = consumeDiagnosticChunk(state, "", "frame:8 pblack:", 400);
  assert.deepEqual(state.blackFrames, []);
  remainder = consumeDiagnosticChunk(state, remainder, "100 pts:8 t:8.0\n[Parsed_showinfo_4 @ 0x1] n:", 500);
  assert.deepEqual(state.blackFrames, [8]);
  assert.equal(remainder, "[Parsed_showinfo_4 @ 0x1] n:");
  remainder = consumeDiagnosticChunk(state, remainder, " 8 pts:8\n", 600);
  assert.equal(remainder, "");
  assert.equal(state.lastAnalyzedFrame, 8);
});

test("freshness fails closed", () => {
  const now = 10_000;
  const valid = { ...createDiagnostics(), validated: true };
  assert.equal(cameraFresh({ state: "ready", monitoring: true, lastFrameAt: 9_000, diagnostics: valid }, now), true);
  assert.equal(cameraFresh({ state: "ready", monitoring: true, lastFrameAt: 9_000, frameAgeMs: 500, diagnostics: valid }, now), true);
  assert.equal(cameraFresh({ state: "ready", monitoring: true, lastFrameAt: 1, frameAgeMs: null, diagnostics: valid }, now), false);
  assert.equal(cameraFresh({ state: "ready", monitoring: true, lastFrameAt: 1, frameAgeMs: false, diagnostics: valid }, now), false);
  assert.equal(cameraFresh({ state: "ready", monitoring: true, lastFrameAt: 1_000, diagnostics: valid }, now), false);
  assert.equal(cameraFresh({ state: "ready", monitoring: true, lastFrameAt: 11_000, diagnostics: valid }, now), false);
  assert.equal(cameraFresh({ state: "ready", monitoring: true, lastFrameAt: 9_000 }, now), false);
  assert.equal(cameraFresh({ state: "ready", monitoring: true, lastFrameAt: 9_000, diagnostics: { ...valid, black: true } }, now), false);
});

test("daemon bridge freshness trusts only the monitor's fail-closed verdict", () => {
  const now = 10_000;
  const good = { state: "ready", fresh: true, monitoring: true, lastFrameAt: 9_000 };
  assert.equal(cameraBridgeFresh(good, now), true);
  assert.equal(cameraBridgeFresh({ ...good, fresh: false }, now), false);
  assert.equal(cameraBridgeFresh({ ...good, fresh: undefined }, now), false);
  assert.equal(cameraBridgeFresh({ ...good, lastFrameAt: 11_000 }, now), false);
  assert.equal(cameraBridgeFresh({ ...good, lastFrameAt: 1_000 }, now), false);
  assert.equal(cameraBridgeFresh({ ...good, lastFrameAt: 1, frameAgeMs: null }, now), false);
});

let passed = 0;
for (const entry of tests) {
  await entry.fn();
  passed += 1;
  process.stdout.write(`ok ${passed} - ${entry.name}\n`);
}
process.stdout.write(`${passed}/${tests.length} camera diagnostics tests passed\n`);
