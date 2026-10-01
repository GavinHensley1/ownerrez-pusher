// Tests for the achievable-detail measurement and the PNG codec it previews with.
//
// The point of these is that the detail verdict is a MEASUREMENT, so it has to
// be falsifiable. Each test builds a surface whose correct answer is known from
// geometry alone, and checks the code agrees.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { TOOLS } from "./tool-library.mjs";
import {
  achievableSurface,
  bottomingSignature,
  distanceInsideSet,
  maxDepthForGrooveWidthMm,
  minGrooveWidthMm,
} from "./achievable-detail.mjs";
import { decodePng, encodePng, luminance } from "./png.mjs";

const BALL = TOOLS["spetool-w01015-spe-x"];

// ---------------------------------------------------------------------------
// Closed-form tool geometry
// ---------------------------------------------------------------------------

test("groove width and reachable depth are exact inverses of each other", () => {
  for (const depth of [0.05, 0.1, 0.25, 0.4, 0.62, 0.78]) {
    const width = minGrooveWidthMm(BALL, depth);
    const back = maxDepthForGrooveWidthMm(BALL, width);
    assert.ok(Math.abs(back - depth) < 1e-6, `${depth} -> ${width} -> ${back}`);
  }
});

test("at full ball depth the tool needs a valley as wide as its own tip", () => {
  // The chord at the ball's equator IS the tip diameter. This is the number the
  // whole detail verdict rests on, so it is pinned rather than assumed.
  assert.ok(Math.abs(minGrooveWidthMm(BALL, BALL.tipRadiusMm) - BALL.diameterMm) < 1e-6);
  assert.ok(Math.abs(minGrooveWidthMm(BALL, 0.62) - 1.549) < 0.002);
  assert.ok(Math.abs(minGrooveWidthMm(BALL, 0.28) - 1.210) < 0.002);
});

test("a narrow valley bottoms the tool out long before its intended depth", () => {
  // These are the numbers that decide which artwork survives: a 0.4 mm valley
  // gets 26 um of relief, not 0.6 mm.
  assert.ok(maxDepthForGrooveWidthMm(BALL, 0.4) < 0.03);
  assert.ok(maxDepthForGrooveWidthMm(BALL, 0.8) < 0.12);
  assert.ok(maxDepthForGrooveWidthMm(BALL, 1.2) < 0.3);
  // And it is monotonic: wider is always deeper, never the reverse.
  let previous = -Infinity;
  for (let w = 0.2; w <= 1.58; w += 0.05) {
    const d = maxDepthForGrooveWidthMm(BALL, w);
    assert.ok(d > previous, `not monotonic at ${w}`);
    previous = d;
  }
});

// ---------------------------------------------------------------------------
// Sweeping a known surface
// ---------------------------------------------------------------------------

function flatFieldWithGroove(cols, rows, grid, grooveWidthMm, grooveDepthMm) {
  const depth = new Float32Array(cols * rows);
  const half = grooveWidthMm / 2;
  const centre = (cols * grid) / 2;
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      depth[r * cols + c] = Math.abs(c * grid - centre) <= half ? grooveDepthMm : 0;
    }
  }
  return depth;
}

test("the tool reaches the floor of a groove wider than itself, and misses a narrow one", () => {
  const cols = 120;
  const rows = 24;
  const grid = 0.05;

  const wide = flatFieldWithGroove(cols, rows, grid, 3.0, 0.5);
  const wideResult = achievableSurface(wide, cols, rows, grid, BALL, 0.5);
  const midWide = wideResult.achievedDepth[Math.floor(rows / 2) * cols + Math.floor(cols / 2)];
  assert.ok(Math.abs(midWide - 0.5) < 0.01, `wide groove should reach 0.5 mm, got ${midWide}`);

  const narrow = flatFieldWithGroove(cols, rows, grid, 0.6, 0.5);
  const narrowResult = achievableSurface(narrow, cols, rows, grid, BALL, 0.5);
  const midNarrow = narrowResult.achievedDepth[Math.floor(rows / 2) * cols + Math.floor(cols / 2)];
  const predicted = maxDepthForGrooveWidthMm(BALL, 0.6);
  assert.ok(midNarrow < 0.12, `narrow groove should bottom out, got ${midNarrow}`);
  // The sweep and the closed form must agree; they are independent derivations.
  assert.ok(Math.abs(midNarrow - predicted) < 0.03, `sweep ${midNarrow} vs closed form ${predicted}`);
});

test("the sweep never gouges: achieved depth never exceeds the design", () => {
  const cols = 90;
  const rows = 30;
  const grid = 0.05;
  const design = flatFieldWithGroove(cols, rows, grid, 1.0, 0.6);
  const { achievedDepth } = achievableSurface(design, cols, rows, grid, BALL, 0.6);
  for (let i = 0; i < design.length; i += 1) {
    assert.ok(achievedDepth[i] <= design[i] + 1e-4, `gouged at ${i}: ${achievedDepth[i]} > ${design[i]}`);
  }
});

// ---------------------------------------------------------------------------
// The bottoming signature
// ---------------------------------------------------------------------------

test("bottoming is detected in a tool-cut valley and not in a flat floor", () => {
  const cols = 140;
  const rows = 40;
  const grid = 0.05;

  // A valley the tool cannot enter: its floor becomes an arc of the tool's own
  // radius, which is exactly what the signature looks for.
  const narrow = flatFieldWithGroove(cols, rows, grid, 0.6, 0.6);
  const cut = achievableSurface(narrow, cols, rows, grid, BALL, 0.6).achievedDepth;
  const narrowSig = bottomingSignature(cut, cols, rows, grid, BALL.tipRadiusMm);
  const row = Math.floor(rows / 2);
  let flagged = 0;
  for (let c = Math.floor(cols / 2) - 6; c <= Math.floor(cols / 2) + 6; c += 1) {
    if (narrowSig.bottomed[row * cols + c]) flagged += 1;
  }
  assert.ok(flagged > 0, "a tool-bottomed valley must be flagged");

  // A broad flat floor is a floor the tool reached on purpose: not flagged.
  const wide = flatFieldWithGroove(cols, rows, grid, 4.0, 0.4);
  const wideCut = achievableSurface(wide, cols, rows, grid, BALL, 0.4).achievedDepth;
  const wideSig = bottomingSignature(wideCut, cols, rows, grid, BALL.tipRadiusMm);
  const centre = row * cols + Math.floor(cols / 2);
  assert.equal(wideSig.bottomed[centre], 0, "a flat floor must not be reported as tool-limited");
});

// ---------------------------------------------------------------------------
// Distance transform
// ---------------------------------------------------------------------------

test("the distance transform measures true Euclidean distance to the set edge", () => {
  const cols = 41;
  const rows = 41;
  const member = new Uint8Array(cols * rows).fill(1);
  // Clear a border so the set edge is at a known place.
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      if (r === 0 || c === 0 || r === rows - 1 || c === cols - 1) member[r * cols + c] = 0;
    }
  }
  const squared = distanceInsideSet(member, cols, rows);
  // The centre of a 41x41 box with a 1-cell border is 20 cells from the edge.
  assert.equal(Math.round(Math.sqrt(squared[20 * cols + 20])), 20);
  // A cell one in from the border is 1 away.
  assert.equal(Math.round(Math.sqrt(squared[1 * cols + 20])), 1);
  // Non-members are zero.
  assert.equal(squared[0], 0);
});

// ---------------------------------------------------------------------------
// PNG codec
// ---------------------------------------------------------------------------

test("PNG round-trips pixel for pixel", () => {
  const width = 37;
  const height = 23;
  const rgb = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i += 1) {
    rgb[i * 3] = i % 256;
    rgb[i * 3 + 1] = (i * 7) % 256;
    rgb[i * 3 + 2] = (i * 31) % 256;
  }
  const decoded = decodePng(encodePng(width, height, rgb));
  assert.equal(decoded.width, width);
  assert.equal(decoded.height, height);
  assert.equal(decoded.channels, 3);
  assert.deepEqual(Buffer.from(decoded.data), rgb);
});

test("PNG decoding handles every row filter, and refuses what it cannot read", () => {
  // The project's own artwork exercises the adaptive filters; this checks the
  // decoder against a file it did not produce itself.
  const artwork = decodePng(
    readArtwork("the-rambos-heightmap-2026-09-29.png"),
  );
  assert.equal(artwork.width, 1448);
  assert.equal(artwork.height, 1086);
  const grey = luminance(artwork);
  assert.equal(grey.length, artwork.width * artwork.height);
  // A render on a white background: the corners must be near-white, which only
  // holds if the row filters were undone correctly.
  assert.ok(grey[0] > 240, `top-left is ${grey[0]}`);
  assert.ok(grey[artwork.width - 1] > 240);

  assert.throws(() => decodePng(Buffer.from("not a png at all")), /Not a PNG/);
});

function readArtwork(name) {
  return readFileSync(new URL(`../assets/cnc/${name}`, import.meta.url));
}
