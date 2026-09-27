import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import test from "node:test";
import { decodeProgram } from "./cnc-program-codec.mjs";

test("compressed CNC transport expands to the exact multi-megabyte program", () => {
  const source = Array.from({ length: 160000 }, (_, index) => `G1 X${(index % 713 * 0.16).toFixed(3)} Z${(-3 * (index % 1000) / 1000).toFixed(3)}`).join("\n");
  const packed = gzipSync(source).toString("base64");
  assert.equal(decodeProgram({ gcodeGzip: packed }), source);
});

test("plain CNC transport remains backward compatible", () => {
  assert.equal(decodeProgram({ gcode: "G21\nG90\nG0 Z3.2" }), "G21\nG90\nG0 Z3.2");
});

test("compressed CNC transport fails closed on invalid or oversized input", () => {
  assert.throws(() => decodeProgram({ gcodeGzip: "not-gzip" }), /could not be expanded/);
  const packed = gzipSync("G1 X0 Z0").toString("base64");
  assert.throws(() => decodeProgram({ gcodeGzip: packed }, { maxPackedBytes: 1 }), /invalid or too large/);
});
