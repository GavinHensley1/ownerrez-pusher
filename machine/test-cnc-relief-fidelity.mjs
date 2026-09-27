import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const line = (name) => {
  const source = html.split("\n").find((entry) => entry.startsWith(`function ${name}`));
  assert.ok(source, `${name} must exist as a standalone function`);
  return source;
};

test("continuous finish depth interpolates through all four approved anchors", () => {
  const make = new Function(`${line("cncClamp")}\n${line("cncPlanContinuousDepth")}\nreturn cncPlanContinuousDepth;`);
  const depth = make();
  const bands = [0, 0.8, 2.5, 4];
  assert.equal(depth(1, bands, 4), 0);
  assert.ok(Math.abs(depth(2 / 3, bands, 4) - 0.8) < 1e-9);
  assert.ok(Math.abs(depth(1 / 3, bands, 4) - 2.5) < 1e-9);
  assert.equal(depth(0, bands, 4), 4);
  const samples = Array.from({ length: 101 }, (_, index) => depth(1 - index / 100, bands, 4));
  for (let index = 1; index < samples.length; index += 1) assert.ok(samples[index] >= samples[index - 1]);
  assert.ok(new Set(samples.map((value) => value.toFixed(4))).size > 90);
});

test("finish fidelity gate rejects the prior four-height staircase", () => {
  const make = new Function(`${line("cncFinishFidelity")}\n${line("cncAssertFinishFidelity")}\nreturn cncAssertFinishFidelity;`);
  const assertFidelity = make();
  const rows = ["; 114.0x88.0 mm, depth 4 mm, 713x550 grid, ~0.16 mm stepover, stage finish", "; RELIEF MODE: continuous piecewise-linear depth | minimum feature 2.00 mm", "; TOOL COMPENSATION: ball radius 0.79375 mm"];
  for (let index = 0; index < 12000; index += 1) rows.push(`G1 X${(index * 0.16).toFixed(3)} Z${[-4, -2.7, -0.74, 0][index % 4].toFixed(3)}`);
  assert.throws(() => assertFidelity(rows.join("\n")), /only 4 Z heights/);
});

test("finish fidelity gate accepts a dense continuous protected-feature path", () => {
  const make = new Function(`${line("cncFinishFidelity")}\n${line("cncAssertFinishFidelity")}\nreturn cncAssertFinishFidelity;`);
  const assertFidelity = make();
  const rows = ["; 114.0x88.0 mm, depth 4 mm, 713x550 grid, ~0.16 mm stepover, stage finish", "; RELIEF MODE: continuous piecewise-linear depth | minimum feature 2.00 mm", "; TOOL COMPENSATION: ball radius 0.79375 mm"];
  for (let index = 0; index < 12000; index += 1) rows.push(`G1 X${((index % 713) * 0.16).toFixed(3)} Z${(-4 * (index % 1001) / 1000).toFixed(3)}`);
  const result = assertFidelity(rows.join("\n"));
  assert.ok(result.uniqueDepths >= 1000);
  assert.equal(result.stepoverMm, 0.16);
});

test("flat cutter envelope preserves a narrow raised island and leaves roughing stock", () => {
  const make = new Function(`${line("cncClamp")}\n${line("cncCompensateToolpath")}\nreturn cncCompensateToolpath;`);
  const compensate = make();
  const source = new Float32Array(25).fill(0);
  source[12] = 1;
  const mask = new Uint8Array(25).fill(1);
  const result = compensate(source, mask, 5, 5, 1, 1, 3, 1.6, "flat", 0.5);
  assert.ok(result[12] > 0.99, "the raised island remains at the surface");
  assert.ok(result[11] > 0.99, "the full flat-cutter radius protects adjacent stock");
  assert.ok(result[0] >= 0.16, "roughing leaves at least 0.5 mm of stock above deep relief");
});

test("ball cutter envelope raises the commanded center near a protected peak", () => {
  const make = new Function(`${line("cncClamp")}\n${line("cncCompensateToolpath")}\nreturn cncCompensateToolpath;`);
  const compensate = make();
  const source = new Float32Array(25).fill(0);
  source[12] = 1;
  const mask = new Uint8Array(25).fill(1);
  const result = compensate(source, mask, 5, 5, 0.5, 0.5, 3, 0.79375, "ball", 0);
  assert.ok(result[12] > 0.99);
  assert.ok(result[11] > source[11], "ball geometry prevents the flank from gouging the peak");
});

test("project offset places the adjacent proof without redefining durable X/Y zero", () => {
  const make = new Function(`${line("cncOffsetProgram")}\nreturn cncOffsetProgram;`);
  const offset = make();
  const source = "; test\nG21\nG0 X0 Y0\nG1 X111.438 Y86.077 Z-2.972\nG0 X0 Y0";
  const result = offset(source, 0, 100);
  assert.match(result, /PROJECT OFFSET: X0\.000 Y100\.000/);
  assert.match(result, /G0 X0 Y100\.000/);
  assert.match(result, /G1 X111\.438 Y186\.077 Z-2\.972/);
  assert.doesNotMatch(result, /Y86\.077/);
});
