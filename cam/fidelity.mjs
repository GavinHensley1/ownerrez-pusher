// Fidelity proof.
//
// A program that is fast, safe and machinable is still a failed deliverable if
// it does not cut the design. The project learned that on 2026-09-29, when a
// set of programs passed every motion check and then turned out to produce two
// isolated patches instead of a buckle.
//
// So: sweep the generated Finish program's own tool over a grid, and compare
// the surface it leaves against the relief model it was generated from. Any
// detail lost to stepover, linearisation tolerance or layering shows up here as
// a deviation, measured in micrometres.

import { sweepProgram, ReliefModel } from "./relief-model.mjs";

export function compareSurfaces(model, achieved, { insideMask } = {}) {
  let maxOverMm = 0; // cut deeper than the design
  let maxUnderMm = 0; // design not reached
  let sumAbs = 0;
  let count = 0;
  let over10um = 0;
  let over25um = 0;
  let worst = null;

  for (let r = 0; r < model.rows; r += 1) {
    for (let c = 0; c < model.cols; c += 1) {
      const index = r * model.cols + c;
      if (insideMask && !insideMask[index]) continue;
      const target = model.depthUm[index] / 1000;
      const cut = achieved.depthUm[index] / 1000;
      const delta = cut - target; // positive = too deep
      count += 1;
      sumAbs += Math.abs(delta);
      if (delta > maxOverMm) {
        maxOverMm = delta;
        worst = { x: model.xOf(c), y: model.yOf(r), target, cut };
      }
      if (-delta > maxUnderMm) maxUnderMm = -delta;
      if (Math.abs(delta) > 0.01) over10um += 1;
      if (Math.abs(delta) > 0.025) over25um += 1;
    }
  }

  return {
    cells: count,
    meanAbsDeviationUm: count ? (sumAbs / count) * 1000 : 0,
    maxTooDeepUm: maxOverMm * 1000,
    maxNotReachedUm: maxUnderMm * 1000,
    fractionOver10um: count ? over10um / count : 0,
    fractionOver25um: count ? over25um / count : 0,
    worstTooDeep: worst,
  };
}

export function sweepFinish(code, toolSpec, model) {
  return new ReliefModel(
    sweepProgram(code, toolSpec, model.bounds, { gridMm: model.gridMm, maxDepthMm: model.stats().maxDepthMm + 0.2 }),
  );
}
