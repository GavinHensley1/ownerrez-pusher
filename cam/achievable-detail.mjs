// What detail survives when the W01015 tapered ball nose is the SMALLEST tool
// allowed to touch metal.
//
// WHY THIS EXISTS. The operator's standing constraint is "no small bits on
// metal": the 0.1 mm V-bit and the 1/8" Genmitsu set are excluded, so the finest
// geometry any metal stage can produce is bounded by the W01015's 1.5875 mm ball
// tip. The design is a wedding piece, and the project's binding rule is that the
// design we SEE must be the design that gets MADE. So the honest question is not
// "can we emit a safe program" -- it is "which parts of this artwork can that
// tool physically reach, and which are lost".
//
// The answer here is MEASURED, not asserted, and it is measured on the CERTIFIED
// SURFACE rather than on a design file.
//
// WHY NOT COMPARE AGAINST THE ARTWORK. There are two artwork PNGs on disk and
// neither can serve as a depth reference:
//   - assets/cnc/roper-farms-heightmap-v2.png IS a true flat-shaded heightmap,
//     but it is the SUPERSEDED wood-proof design ("ROPER FARMS"). Registering it
//     against the current relief reaches a correlation of only 0.36, because it
//     is a different buckle.
//   - assets/cnc/the-rambos-heightmap-2026-09-29.png is the CURRENT design that
//     Gavin emailed on 2026-09-29, but it is a photoreal product render with
//     specular highlights and a white background. Grey is not height in it.
// Inventing a height field from either one would put a fabricated reference at
// the centre of a wedding-piece decision. So the tool limit is measured
// geometrically instead, which needs no design file at all:
//
//   minGrooveWidthMm / maxDepthForGrooveWidthMm   closed-form tool geometry
//   bottomingSignature                            where the tool ran out of room
//
// The first pair is exact: a ball of radius r in a valley of width w can only
// reach a depth the chord allows, and no feed, stepover or raster density
// changes that. The second finds, on the finished surface itself, the places
// where that limit actually bit -- a floor that is an arc of the tool's own tip
// radius is a floor the TOOL chose, not one the artwork asked for. Both are
// facts about the tool and the part, independent of any rendering.
//
// achievableSurface() remains available for the case where a genuine height
// field does exist: it is the two-pass drop-cutter-then-sweep that produces the
// surface a given tool can actually leave behind.

import { engagedDiameterMm, profileOffsetMm, sweepRadiusMm } from "./tool-library.mjs";

/**
 * Narrowest groove this tool can cut at a given depth, in mm.
 *
 * A ball of radius r sunk to depth d leaves a groove exactly as wide as the
 * chord at that depth. This is a hard geometric floor: no feed, speed, stepover
 * or raster density changes it. Two raised features closer together than this
 * cannot be separated, because the tool cannot fit into the valley between them.
 */
export function minGrooveWidthMm(toolSpec, depthMm) {
  return engagedDiameterMm(toolSpec, depthMm);
}

/**
 * Deepest a groove of the given width can be cut with this tool, in mm.
 * The inverse of minGrooveWidthMm: for a valley narrower than the tool tip, the
 * tool bottoms out early and the valley stays proud of its intended floor.
 */
export function maxDepthForGrooveWidthMm(toolSpec, widthMm) {
  const half = widthMm / 2;
  const r = toolSpec.tipRadiusMm;
  if (!Number.isFinite(r)) throw new Error(`${toolSpec.id} has no ball tip to reason about`);
  if (half >= r) {
    // Past the ball's equator the taper flank sets the width.
    const taper = (toolSpec.taperHalfAngleDeg * Math.PI) / 180;
    return r + (half - r / Math.cos(taper)) / Math.tan(taper);
  }
  // Chord half-width h at depth d: h^2 = 2rd - d^2  =>  d = r - sqrt(r^2 - h^2)
  return r - Math.sqrt(Math.max(0, r * r - half * half));
}

/**
 * Surface this tool can actually produce over a design depth field.
 *
 * Returns { achievedDepth, tipZ } in mm, both Float32Array of cols*rows.
 * achievedDepth is always <= design depth: the tool under-cuts, never gouges.
 */
export function achievableSurface(design, cols, rows, gridMm, toolSpec, maxDepthMm) {
  const radiusMm = sweepRadiusMm(toolSpec, maxDepthMm);
  const cells = Math.ceil(radiusMm / gridMm);

  // Offset lookup table over the square footprint: the tool is rotationally
  // symmetric, so this is computed once and reused for every cell.
  const span = 2 * cells + 1;
  const offsets = new Float32Array(span * span);
  for (let j = -cells; j <= cells; j += 1) {
    for (let i = -cells; i <= cells; i += 1) {
      const d = Math.hypot(i, j) * gridMm;
      const offset = profileOffsetMm(toolSpec, d);
      offsets[(j + cells) * span + (i + cells)] = offset === null ? Number.POSITIVE_INFINITY : offset;
    }
  }

  // Pass 1 -- drop cutter. tipZ(p) = max over the footprint of (-depth - offset).
  const tipZ = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      let tip = Number.NEGATIVE_INFINITY;
      for (let j = -cells; j <= cells; j += 1) {
        const rr = r + j;
        if (rr < 0 || rr >= rows) continue;
        const rowBase = rr * cols;
        const offBase = (j + cells) * span + cells;
        for (let i = -cells; i <= cells; i += 1) {
          const cc = c + i;
          if (cc < 0 || cc >= cols) continue;
          const offset = offsets[offBase + i];
          if (!Number.isFinite(offset)) continue;
          const constraint = -design[rowBase + cc] - offset;
          if (constraint > tip) tip = constraint;
        }
      }
      tipZ[r * cols + c] = tip === Number.NEGATIVE_INFINITY ? 0 : Math.min(0, tip);
    }
  }

  // Pass 2 -- sweep. The surface left behind is the lowest point any tool
  // position puts over this cell.
  const achievedDepth = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      let surface = 0;
      for (let j = -cells; j <= cells; j += 1) {
        const rr = r + j;
        if (rr < 0 || rr >= rows) continue;
        const rowBase = rr * cols;
        const offBase = (j + cells) * span + cells;
        for (let i = -cells; i <= cells; i += 1) {
          const cc = c + i;
          if (cc < 0 || cc >= cols) continue;
          const offset = offsets[offBase + i];
          if (!Number.isFinite(offset)) continue;
          const here = tipZ[rowBase + cc] + offset;
          if (here < surface) surface = here;
        }
      }
      achievedDepth[r * cols + c] = -surface;
    }
  }

  return { achievedDepth, tipZ, footprintRadiusMm: radiusMm, footprintCells: cells };
}

/** Volume and depth comparison of two surfaces over a masked region. */
export function summariseRegion(design, achieved, mask, gridMm) {
  const cell = gridMm * gridMm;
  let cells = 0;
  let designVolume = 0;
  let achievedVolume = 0;
  let maxLoss = 0;
  let deepEnough = 0;
  let designDeep = 0;
  for (let i = 0; i < design.length; i += 1) {
    if (!mask[i]) continue;
    cells += 1;
    designVolume += design[i] * cell;
    achievedVolume += achieved[i] * cell;
    const loss = design[i] - achieved[i];
    if (loss > maxLoss) maxLoss = loss;
    // A cell counts as reproduced when the tool gets within 50 um of intent.
    if (design[i] > 0.05) {
      designDeep += 1;
      if (loss <= 0.05) deepEnough += 1;
    }
  }
  return {
    cells,
    areaMm2: cells * cell,
    designVolumeMm3: designVolume,
    achievedVolumeMm3: achievedVolume,
    volumeLostFraction: designVolume === 0 ? 0 : 1 - achievedVolume / designVolume,
    maxLossMm: maxLoss,
    reproducedFraction: designDeep === 0 ? 1 : deepEnough / designDeep,
  };
}

/**
 * Local relief scale at every cell: the width of the valley the artwork asks for
 * there, measured AT THAT CELL'S OWN DEPTH.
 *
 * A single global threshold is useless on this relief -- almost everything is
 * recessed relative to the raised artwork, so one threshold reports the whole
 * background field as one enormous valley and the rope grooves disappear into
 * it. Instead the depth range is stratified into bands and each cell is measured
 * against the set of cells at least as deep as itself: "how wide is the region
 * around me that is at least as deep as I am". That is the quantity the tool
 * actually has to fit into.
 *
 * This is what turns "the tool is 1.5875 mm" into a per-feature verdict without
 * anyone hand-labelling the artwork.
 */
export function valleyWidthStratified(depth, cols, rows, gridMm, maxDepthMm, bandMm = 0.1, maxWidthMm = 8) {
  const bands = Math.max(1, Math.ceil(maxDepthMm / bandMm));
  const width = new Float32Array(cols * rows).fill(maxWidthMm);
  for (let band = 0; band < bands; band += 1) {
    const level = band * bandMm;
    const member = new Uint8Array(cols * rows);
    for (let i = 0; i < depth.length; i += 1) member[i] = depth[i] >= level ? 1 : 0;
    const distance = distanceInsideSet(member, cols, rows);
    for (let i = 0; i < depth.length; i += 1) {
      // Each cell is scored by the band its own depth falls in.
      if (depth[i] >= level && depth[i] < level + bandMm) {
        width[i] = Math.min(maxWidthMm, 2 * Math.sqrt(distance[i]) * gridMm);
      }
    }
  }
  return width;
}

/**
 * Find where this ball tool BOTTOMED OUT, from the surface it left behind.
 *
 * This is the one measurement that needs no design file. A ball of radius r
 * wedged in a groove narrower than itself cannot reach the groove's apex; it
 * stops touching both walls and leaves a floor that is an arc of radius exactly
 * r. So wherever the finished surface is concave with a principal radius of
 * curvature equal to the tool's tip radius, the tool is the thing that set that
 * floor -- the artwork wanted to go deeper or sharper and could not.
 *
 * Conversely a floor flatter than the tool (large radius) is a floor the tool
 * reached on purpose, and a convex ridge is raised artwork the tool went around.
 *
 * Curvature is taken at a smoothing radius of one tool radius, because that is
 * the scale the tool integrates over; finer differencing just measures grid
 * noise. Returns { radiusMm, bottomed } where radiusMm is the concave principal
 * radius (Infinity where the surface is flat or convex).
 */
export function bottomingSignature(depth, cols, rows, gridMm, tipRadiusMm, toleranceFraction = 0.25) {
  // Differencing baseline. It has to be small enough to fit INSIDE the floor
  // arc of the narrowest groove of interest -- at 3/4 of the tip radius the
  // stencil reached out of a 0.6 mm groove into the flat field either side and
  // measured the groove instead of its floor, reporting no bottoming at all.
  // At ~1/3 of the tip radius the second difference over the arc recovers a
  // radius within a few percent of the true 0.794 mm, which the tolerance band
  // comfortably covers.
  const step = Math.max(2, Math.round((tipRadiusMm * 0.35) / gridMm));
  const h = (c, r) => -depth[Math.min(rows - 1, Math.max(0, r)) * cols + Math.min(cols - 1, Math.max(0, c))];
  const radiusMm = new Float32Array(cols * rows).fill(Infinity);
  const bottomed = new Uint8Array(cols * rows);
  const span = step * gridMm;
  const lo = tipRadiusMm * (1 - toleranceFraction);
  const hi = tipRadiusMm * (1 + toleranceFraction);

  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      // Second differences along both axes and both diagonals: the largest
      // upward (concave) curvature over four directions approximates the
      // maximum principal curvature closely enough to identify an arc floor.
      const centre = 2 * h(c, r);
      const dxx = (h(c - step, r) + h(c + step, r) - centre) / (span * span);
      const dyy = (h(c, r - step) + h(c, r + step) - centre) / (span * span);
      const dab = (h(c - step, r - step) + h(c + step, r + step) - centre) / (2 * span * span);
      const dba = (h(c - step, r + step) + h(c + step, r - step) - centre) / (2 * span * span);
      // Concave (valley) curvature of the height field is positive here.
      const kappa = Math.max(dxx, dyy, dab, dba);
      if (kappa <= 0) continue;
      const radius = 1 / kappa;
      radiusMm[r * cols + c] = radius;
      if (radius >= lo && radius <= hi) bottomed[r * cols + c] = 1;
    }
  }
  return { radiusMm, bottomed, stepCells: step };
}

/** Squared Euclidean distance, in cells, from each member cell to the nearest non-member. */
export function distanceInsideSet(member, cols, rows) {
  const INF = 1e12;
  const f = new Float64Array(Math.max(cols, rows));
  const d = new Float64Array(Math.max(cols, rows));
  const v = new Int32Array(Math.max(cols, rows));
  const z = new Float64Array(Math.max(cols, rows) + 1);
  const squared = new Float64Array(cols * rows);

  const transform1d = (length) => {
    let k = 0;
    v[0] = 0;
    z[0] = -INF;
    z[1] = INF;
    for (let q = 1; q < length; q += 1) {
      let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) {
        k -= 1;
        s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      }
      k += 1;
      v[k] = q;
      z[k] = s;
      z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < length; q += 1) {
      while (z[k + 1] < q) k += 1;
      d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
    }
  };

  for (let c = 0; c < cols; c += 1) {
    for (let r = 0; r < rows; r += 1) f[r] = member[r * cols + c] ? INF : 0;
    transform1d(rows);
    for (let r = 0; r < rows; r += 1) squared[r * cols + c] = d[r];
  }
  for (let r = 0; r < rows; r += 1) {
    const base = r * cols;
    for (let c = 0; c < cols; c += 1) f[c] = squared[base + c];
    transform1d(cols);
    for (let c = 0; c < cols; c += 1) squared[base + c] = d[c];
  }
  return squared;
}
