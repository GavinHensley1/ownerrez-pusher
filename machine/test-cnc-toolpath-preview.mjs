// Regression tests for the stage preview footprint.
//
// THE BUG THESE LOCK DOWN: cncRenderToolpath sized each drawn cell from gap() —
// the smallest spacing between any two distinct coordinates anywhere in the
// program. The certified roughing stage has a 0.001 mm minimum X and Y gap, so
// the cell collapsed to 1.0 px while the RU2100 that cuts it is 6.35 mm, about
// 28 px at preview scale. A stage that physically clears solid material rendered
// as 1 px dots separated by black, which reads as "not cut".
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { canvasCoverage, loadBrowserScript } from "./cnc-browser-harness.mjs";

const root = new URL("../", import.meta.url);
const RU2100 = "Whiteside RU2100 · 1/4″ two-flute upcut";
const W01015 = "SpeTool W01015-SPE-X · 1/4″ shank · 1/32″ cutting radius tapered ball nose";

const STAGES = {
  rough: { asset: "rambo-buckle-c752-rough-ru2100.nc.gz", tool: RU2100, diameterMm: 6.35 },
  cleanup: { asset: "rambo-buckle-c752-cleanup-w01015.nc.gz", tool: W01015, diameterMm: 1.5875 },
  finish: { asset: "rambo-buckle-c752-finish-xy-w01015.nc.gz", tool: W01015, diameterMm: 1.5875 },
};

const certifiedGcode = (asset) => gunzipSync(readFileSync(new URL(`api/cnc-certified-programs/${asset}`, root))).toString("utf8");

const job = {
  id: "preview-test",
  camCertificates: JSON.stringify({
    rough: { tool: RU2100 }, cleanup: { tool: W01015 }, finish: { tool: W01015 },
    profile: { tool: RU2100 }, release: { tool: RU2100 },
  }),
  planTools: JSON.stringify({ roughBit: RU2100, finishBit: W01015, detailBit: "30° V-bit 0.1mm" }),
};

function render(stage) {
  const harness = loadBrowserScript(new URL("index.html", root).pathname);
  harness.setJob(job);
  harness.cncRenderToolpath(certifiedGcode(STAGES[stage].asset), stage);
  return { harness, coverage: canvasCoverage(harness.canvases[0]) };
}

test("the footprint comes from the certified tool, never from coordinate spacing", () => {
  const harness = loadBrowserScript(new URL("index.html", root).pathname);
  harness.setJob(job);
  for (const [stage, expected] of Object.entries(STAGES)) {
    const footprint = harness.cncToolFootprint(certifiedGcode(expected.asset), stage, job);
    assert.equal(footprint.known, true, `${stage} must resolve a tool diameter`);
    assert.equal(footprint.diameterMm, expected.diameterMm, `${stage} diameter`);
    assert.match(footprint.source, /certified tool/, `${stage} must name where the diameter came from`);
  }
});

test("an unresolvable tool is reported, not guessed", () => {
  const harness = loadBrowserScript(new URL("index.html", root).pathname);
  harness.setJob({ id: "no-tools", camCertificates: "{}", planTools: "{}" });
  const footprint = harness.cncToolFootprint("G21\nG1 X1 Y1 Z-1\n", "rough", { id: "no-tools" });
  assert.equal(footprint.known, false);
  assert.equal(footprint.diameterMm, 0);
  assert.match(footprint.source, /unavailable/);
});

test("a G-code header beats the tool name, because it states the real engagement", () => {
  const harness = loadBrowserScript(new URL("index.html", root).pathname);
  harness.setJob(job);
  const header = "; RADIAL ENGAGEMENT: 0.800 mm actual / 6.350 mm = 12.6% | AXIAL STEP 0.0250\nG21\nG1 X1 Y1 Z-1\n";
  const footprint = harness.cncToolFootprint(header, "rough", job);
  assert.equal(footprint.diameterMm, 6.35);
  assert.equal(footprint.stepoverMm, 0.8);
  assert.match(footprint.source, /RADIAL ENGAGEMENT/);
});

test("roughing renders contiguous coverage, not 1 px dots", () => {
  const { coverage } = render("rough");
  // Before the fix: 16.0% painted with a 171 px worst interior background run.
  // After: 51.3% painted with a 51 px run. The remaining black is legitimate —
  // roughing only reaches 0.160 mm of an 0.8 mm relief, so most of the field is
  // genuinely untouched by this stage.
  assert.ok(coverage.paintedFraction > 0.4, `roughing painted only ${(coverage.paintedFraction * 100).toFixed(1)}%`);
  assert.ok(coverage.worstInteriorGapPx < 80, `worst interior gap ${coverage.worstInteriorGapPx}px is too wide to be a stepover`);
});

test("the finish stage is effectively gap-free, since it clears the whole relief", () => {
  const { coverage } = render("finish");
  // Before the fix: 46.4% painted, 26 px worst run. After: 70.5%, 3 px.
  assert.ok(coverage.paintedFraction > 0.6, `finish painted only ${(coverage.paintedFraction * 100).toFixed(1)}%`);
  assert.ok(coverage.worstInteriorGapPx <= 6, `finish left a ${coverage.worstInteriorGapPx}px interior gap`);
});

test("every footprint stage beats plain sample dots", () => {
  // A 1 px dot per sample is what the old code effectively drew. The footprint
  // render must cover strictly more of the frame for each stage.
  const baseline = { rough: 0.16, cleanup: 0.267, finish: 0.464 };
  for (const stage of Object.keys(STAGES)) {
    const { coverage } = render(stage);
    assert.ok(coverage.paintedFraction > baseline[stage], `${stage} did not improve on the sample-dot baseline`);
  }
});

test("the caption says what black means and names the cutter", () => {
  const { harness } = render("rough");
  const note = harness.elements.cncGcodePrev;
  const meta = harness.elements.cncGcodeMeta.textContent;
  assert.match(meta, /6\.35 mm cutter clears \d+% of the preview frame/);
  assert.match(meta, /rapids not drawn/);
  assert.ok(note, "the preview container must exist");
});

test("depth bands stay ordered so colour cannot mislabel depth", () => {
  const harness = loadBrowserScript(new URL("index.html", root).pathname);
  assert.equal(harness.cncDepthBand(0, 0.8), 0, "at the surface");
  assert.equal(harness.cncDepthBand(-0.001, 0.8), 0, "within the surface tolerance");
  assert.equal(harness.cncDepthBand(-0.2, 0.8), 1, "shallow");
  assert.equal(harness.cncDepthBand(-0.5, 0.8), 2, "medium");
  assert.equal(harness.cncDepthBand(-0.8, 0.8), 3, "deepest");
});

// ENGAGEMENT, stated rather than implied.
//
// The primary reason Rough shows uncoloured regions is NOT a rendering fault: a
// machinability audit measured it spending the overwhelming majority of its feed
// time above Z0, cutting air, because stock-to-leave (~0.63 mm) nearly equals the
// 0.79 mm relief depth. Without that number on screen the operator is left to
// decide whether black means "not cut here" or "the preview is broken".
test("the preview reports what share of each stage's feed time is actually in material", () => {
  const { harness } = render("rough");
  const meta = harness.elements.cncGcodeMeta.textContent;
  const match = meta.match(/([\d.]+)% of feed time in material/);
  assert.ok(match, `meta must state the engagement share, got: ${meta}`);
  const inMaterial = Number(match[1]);
  // Independently computed from the certified program: 11.3% in material,
  // 88.7% above Z0, over a total feed time of 1.03 h, which reproduces the
  // audit's 1.03 h exactly and corroborates its ~85% air figure. The audit and
  // this differ slightly only in how a move exactly AT Z0 is counted; here a move
  // must be strictly below the surface to count as cutting.
  assert.ok(inMaterial > 5 && inMaterial < 20, `rough should be barely engaged, got ${inMaterial}%`);
});

test("a genuinely engaged stage reports a far higher share than rough", () => {
  const roughMeta = render("rough").harness.elements.cncGcodeMeta.textContent;
  const finishMeta = render("finish").harness.elements.cncGcodeMeta.textContent;
  const share = (text) => Number((text.match(/([\d.]+)% of feed time in material/) || [])[1]);
  const rough = share(roughMeta), finish = share(finishMeta);
  assert.ok(Number.isFinite(rough) && Number.isFinite(finish), `both stages must report a share: ${rough} / ${finish}`);
  // Finish is the stage doing the actual work -- the audit found it removing 90%
  // of the relief. If these two ever report the same engagement, the measurement
  // is not measuring anything.
  assert.ok(finish > rough * 2, `finish (${finish}%) should be far more engaged than rough (${rough}%)`);
});

test("engagement is omitted rather than guessed when there is no feed rate", () => {
  // No F word anywhere means no feed time can be computed. Saying nothing is
  // correct; printing 0% or 100% would be inventing a number.
  const harness = loadBrowserScript(new URL("index.html", root).pathname);
  harness.setJob(job);
  harness.cncRenderToolpath("G21\nG90\nG0 Z5\nG0 X0 Y0\nG1 Z-0.5\nG1 X10 Y0\nG0 Z5\n", "rough");
  assert.doesNotMatch(harness.elements.cncGcodeMeta.textContent, /% of feed time in material/);
});
