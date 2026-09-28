import assert from "node:assert/strict";
import test from "node:test";
import { completeStockProbe, completeToolTouch } from "./cnc-setup-flow.mjs";

test("second new-board touch automatically locks measured stock", () => {
  const setup = { bedSurfaceMPos: -28.088 };
  completeStockProbe(setup, -14.721, "2026-09-27T12:00:00.000Z");
  assert.equal(setup.stockThicknessMm, 13.367);
  assert.equal(setup.safetyFloorMm, 0.8);
  assert.equal(setup.maxCutDepthMm, 12.567);
  assert.equal(setup.probeLocked, true);
  assert.equal(setup.probeLockStatus, "locked_after_stock_probe");
});

test("changed-bit stock touch preserves physical thickness and recalculates both machine surfaces", () => {
  const setup = { xyReady: true, xyOriginMPos: { X: -243.4, Y: -5.029 } };
  completeToolTouch(setup, -10, { version: 1, stockThicknessMm: 13.367, safetyFloorMm: 0.8, maxCutDepthMm: 12.567 });
  assert.equal(setup.stockSurfaceMPos, -10);
  assert.equal(setup.bedSurfaceMPos, -23.367);
  assert.equal(setup.stockThicknessMm, 13.367);
  assert.equal(setup.probeLocked, true);
  assert.equal(setup.xyOriginMPos.X, -243.4);
  assert.equal(setup.xyOriginMPos.Y, -5.029);
});
