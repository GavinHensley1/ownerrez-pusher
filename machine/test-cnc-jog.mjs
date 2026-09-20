import assert from "node:assert/strict";
import test from "node:test";
import { splitJogDistance } from "./cnc-jog.mjs";

test("splits large XY jogs into guarded 10 mm segments", () => {
  assert.deepEqual(splitJogDistance("X", 100), Array(10).fill(10));
  assert.deepEqual(splitJogDistance("Y", -25), [-10, -10, -5]);
});

test("splits large Z jogs into guarded 5 mm segments", () => {
  assert.deepEqual(splitJogDistance("Z", 100), Array(20).fill(5));
  assert.deepEqual(splitJogDistance("Z", -12.5), [-5, -5, -2.5]);
});

test("rejects invalid or over-100 mm jog requests", () => {
  assert.throws(() => splitJogDistance("A", 10), /axis/);
  assert.throws(() => splitJogDistance("X", 0), /non-zero/);
  assert.throws(() => splitJogDistance("Z", 100.1), /100 mm/);
});
