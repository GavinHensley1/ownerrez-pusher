import test from "node:test";
import assert from "node:assert/strict";
import { assertWorkJogWithinStock, positioningBoundsFromStock } from "./cnc-positioning-envelope.mjs";

test("stock positioning bounds stop before the rear hard limit", () => {
  const bounds = positioningBoundsFromStock({ X: -126.219, Y: -22.91 }, { stockWidthMm: 241.3, stockHeightMm: 139.7 });
  assert.equal(bounds.X.min, -126.219);
  assert.equal(bounds.X.max.toFixed(3), "135.081");
  assert.equal(bounds.Y.min, -22.91);
  assert.equal(bounds.Y.max.toFixed(3), "136.790");
});

test("stock positioning rejects farther motion and permits return toward safety", () => {
  assert.throws(() => assertWorkJogWithinStock({ workPosition: { X: 0, Y: 165 }, axis: "Y", distanceMm: 10, stockWidthMm: 241.3, stockHeightMm: 139.7 }), /outside the safe positioning envelope/);
  const recovery = assertWorkJogWithinStock({ workPosition: { X: 0, Y: 174.46 }, axis: "Y", distanceMm: -5, stockWidthMm: 241.3, stockHeightMm: 139.7 });
  assert.equal(recovery.returningToEnvelope, true);
  assert.equal(recovery.target, 169.46);
  assert.throws(() => assertWorkJogWithinStock({ workPosition: { X: 0, Y: 150 }, axis: "Y", distanceMm: 10, stockWidthMm: 241.3, stockHeightMm: 139.7 }), /Project allows/);
});
