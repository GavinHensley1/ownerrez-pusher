// The buckle's target geometry, as a height field plus a silhouette.
//
// WHERE IT COMES FROM. The artwork relief was modelled in Kiri:Moto from an STL
// this project no longer holds. What it does hold is the certified Finish
// program, which was visually verified in Project's own preview to reproduce the
// complete design: "The Rambo's" lettering, inner and outer rope, scrollwork,
// both corn stalks, the mountains, the radiating field and the two figures
// (memory 2026-09-30 ~10:46 and the five-file re-audit).
//
// Sweeping that program's tool over a grid therefore reconstructs exactly the
// surface the operator already accepted. This is stronger than re-deriving a
// relief from the source PNG: it cannot drift from the approved design, and it
// is automatically limited to what the W01015 can physically resolve, because
// it IS what that tool reaches. Regenerating from this model with the same tool
// reproduces the same part.
//
// The silhouette comes from the Profile program's first closed contour, which is
// the exact 63-point outline already certified for the through-cut.

import { profileOffsetMm, sweepRadiusMm } from "./tool-library.mjs";
import { parseMoves } from "./nc-parse.mjs";

export const GRID_MM = 0.1;

/**
 * Sweep a tool along an NC program and record the lowest surface it leaves.
 *
 * Heights are stored as depth below Z0 in micrometres in a Uint16Array, which
 * keeps a 1140x880 grid in 2 MB and resolves 1 um — far finer than anything the
 * machine can hold.
 */
export function sweepProgram(code, toolSpec, bounds, { gridMm = GRID_MM, maxDepthMm = 1.2 } = {}) {
  const cols = Math.round((bounds.maxX - bounds.minX) / gridMm) + 1;
  const rows = Math.round((bounds.maxY - bounds.minY) / gridMm) + 1;
  const depthUm = new Uint16Array(cols * rows); // 0 = untouched stock at Z0

  const stampRadius = Math.max(gridMm, sweepRadiusMm(toolSpec, maxDepthMm) + gridMm);
  const stampCells = Math.ceil(stampRadius / gridMm);

  // The offset is evaluated from the TRUE distance between the continuous tool
  // position and each cell centre, not from the integer cell displacement.
  // Rounding the tool to a cell first looks harmless, but on this tool's 5.38
  // degree taper flank the surface rises about 10.6 mm per mm of radius, so a
  // half-cell (0.05 mm) lateral error becomes half a millimetre of depth and
  // the reconstruction reports gouges that the toolpath does not contain.
  const stamp = (tipX, tipY, tipZ) => {
    if (tipZ >= 0) return; // above the stock, removes nothing
    const cx = Math.round((tipX - bounds.minX) / gridMm);
    const cy = Math.round((tipY - bounds.minY) / gridMm);
    for (let j = -stampCells; j <= stampCells; j += 1) {
      const gy = cy + j;
      if (gy < 0 || gy >= rows) continue;
      const rowBase = gy * cols;
      const dy = bounds.minY + gy * gridMm - tipY;
      for (let i = -stampCells; i <= stampCells; i += 1) {
        const gx = cx + i;
        if (gx < 0 || gx >= cols) continue;
        const dx = bounds.minX + gx * gridMm - tipX;
        const offset = profileOffsetMm(toolSpec, Math.sqrt(dx * dx + dy * dy));
        if (offset === null) continue;
        const surface = tipZ + offset;
        if (surface >= 0) continue;
        const um = Math.min(65535, Math.round(-surface * 1000));
        const index = rowBase + gx;
        if (um > depthUm[index]) depthUm[index] = um;
      }
    }
  };

  const sampleStep = gridMm / 2;
  for (const move of parseMoves(code)) {
    if (move.rapid) continue;
    const { from, to } = move;
    const length = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
    const steps = Math.max(1, Math.ceil(length / sampleStep));
    for (let s = 0; s <= steps; s += 1) {
      const t = s / steps;
      stamp(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, from.z + (to.z - from.z) * t);
    }
  }

  return { cols, rows, gridMm, bounds, depthUm };
}

export class ReliefModel {
  constructor({ cols, rows, gridMm, bounds, depthUm }) {
    this.cols = cols;
    this.rows = rows;
    this.gridMm = gridMm;
    this.bounds = bounds;
    this.depthUm = depthUm;
  }

  /** Depth below Z0 in mm at a grid cell. Always >= 0. */
  depthAt(col, row) {
    if (col < 0 || row < 0 || col >= this.cols || row >= this.rows) return 0;
    return this.depthUm[row * this.cols + col] / 1000;
  }

  colOf(xMm) {
    return Math.round((xMm - this.bounds.minX) / this.gridMm);
  }

  rowOf(yMm) {
    return Math.round((yMm - this.bounds.minY) / this.gridMm);
  }

  xOf(col) {
    return this.bounds.minX + col * this.gridMm;
  }

  yOf(row) {
    return this.bounds.minY + row * this.gridMm;
  }

  /** Bilinear depth in mm at an arbitrary point. */
  sample(xMm, yMm) {
    const fx = (xMm - this.bounds.minX) / this.gridMm;
    const fy = (yMm - this.bounds.minY) / this.gridMm;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    const d00 = this.depthAt(x0, y0);
    const d10 = this.depthAt(x0 + 1, y0);
    const d01 = this.depthAt(x0, y0 + 1);
    const d11 = this.depthAt(x0 + 1, y0 + 1);
    return d00 * (1 - tx) * (1 - ty) + d10 * tx * (1 - ty) + d01 * (1 - tx) * ty + d11 * tx * ty;
  }

  /**
   * Lowest tip Z at which the tool touches this surface without gouging it,
   * with the tip at (x, y). The standard 3D-finishing drop-cutter query.
   *
   * At horizontal distance d the tool's own surface sits at tipZ + offset(d),
   * and it must stay at or above the material there, which is at -depth:
   *
   *     tipZ + offset(d) >= -depth(d)   =>   tipZ >= -depth(d) - offset(d)
   *
   * so the tip stops at the LARGEST of those constraints over the footprint.
   * Taking the smallest instead drives the tool straight through the part.
   */
  dropCutterZ(toolSpec, xMm, yMm, maxDepthMm) {
    const radius = sweepRadiusMm(toolSpec, maxDepthMm);
    const cells = Math.ceil(radius / this.gridMm);
    const c0 = this.colOf(xMm);
    const r0 = this.rowOf(yMm);
    let tip = Number.NEGATIVE_INFINITY;
    for (let j = -cells; j <= cells; j += 1) {
      const row = r0 + j;
      if (row < 0 || row >= this.rows) continue;
      for (let i = -cells; i <= cells; i += 1) {
        const col = c0 + i;
        if (col < 0 || col >= this.cols) continue;
        const d = Math.hypot(this.xOf(col) - xMm, this.yOf(row) - yMm);
        const offset = profileOffsetMm(toolSpec, d);
        if (offset === null) continue;
        const constraint = -this.depthAt(col, row) - offset;
        if (constraint > tip) tip = constraint;
      }
    }
    return tip === Number.NEGATIVE_INFINITY ? 0 : Math.min(0, tip);
  }

  stats() {
    let maxUm = 0;
    let touched = 0;
    let volumeMm3 = 0;
    const cell = this.gridMm * this.gridMm;
    for (let i = 0; i < this.depthUm.length; i += 1) {
      const um = this.depthUm[i];
      if (um > 0) touched += 1;
      if (um > maxUm) maxUm = um;
      volumeMm3 += (um / 1000) * cell;
    }
    return {
      cols: this.cols,
      rows: this.rows,
      gridMm: this.gridMm,
      maxDepthMm: maxUm / 1000,
      touchedCells: touched,
      touchedAreaMm2: touched * cell,
      volumeMm3,
    };
  }

  static decode(buffer) {
    const headerLength = buffer.readUInt32LE(0);
    const header = JSON.parse(buffer.subarray(4, 4 + headerLength).toString("utf8"));
    const body = buffer.subarray(4 + headerLength);
    const depthUm = new Uint16Array(header.cols * header.rows);
    for (let i = 0; i < depthUm.length; i += 1) depthUm[i] = body.readUInt16LE(i * 2);
    return new ReliefModel({ ...header, depthUm });
  }

  encode(meta = {}) {
    const header = Buffer.from(
      JSON.stringify({ cols: this.cols, rows: this.rows, gridMm: this.gridMm, bounds: this.bounds, ...meta }),
      "utf8",
    );
    const body = Buffer.alloc(this.depthUm.length * 2);
    for (let i = 0; i < this.depthUm.length; i += 1) body.writeUInt16LE(this.depthUm[i], i * 2);
    const length = Buffer.alloc(4);
    length.writeUInt32LE(header.length, 0);
    return Buffer.concat([length, header, body]);
  }
}

/**
 * Pull the first closed cutting contour out of a profile/release program. The
 * certified Profile traces the silhouette once per Z level, so the first lap is
 * the outline, in cutter-CENTRE coordinates.
 */
export function extractSilhouette(code) {
  const points = [];
  let started = false;
  for (const move of parseMoves(code)) {
    if (move.rapid) {
      if (started) break;
      continue;
    }
    if (!started) {
      started = true;
      points.push({ x: move.from.x, y: move.from.y });
    }
    const last = points[points.length - 1];
    if (Math.hypot(move.to.x - last.x, move.to.y - last.y) < 1e-9) continue;
    // The lap closes when it returns to the start.
    if (points.length > 8 && Math.hypot(move.to.x - points[0].x, move.to.y - points[0].y) < 0.5) {
      break;
    }
    points.push({ x: move.to.x, y: move.to.y });
  }
  return points;
}

export function polygonPerimeterMm(points) {
  let total = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    total += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return total;
}

export function polygonAreaMm2(points) {
  let twice = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    twice += a.x * b.y - b.x * a.y;
  }
  return Math.abs(twice) / 2;
}

export function pointInPolygon(points, x, y) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const a = points[i];
    const b = points[j];
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Signed area sign, used to normalise winding before offsetting. */
export function isCounterClockwise(points) {
  let twice = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    twice += a.x * b.y - b.x * a.y;
  }
  return twice > 0;
}

/**
 * Offset a simple closed polygon outwards (positive) or inwards (negative).
 * Vertex-normal offsetting is adequate here: the silhouette is a smooth convex-ish
 * outline with no reflex spikes, and every offset used is under 1 mm.
 */
export function offsetPolygon(points, distanceMm) {
  const ccw = isCounterClockwise(points);
  const sign = ccw ? 1 : -1;
  const out = [];
  for (let i = 0; i < points.length; i += 1) {
    const prev = points[(i - 1 + points.length) % points.length];
    const current = points[i];
    const next = points[(i + 1) % points.length];
    const n1 = edgeNormal(prev, current, sign);
    const n2 = edgeNormal(current, next, sign);
    let nx = n1.x + n2.x;
    let ny = n1.y + n2.y;
    const len = Math.hypot(nx, ny);
    if (len < 1e-9) continue;
    nx /= len;
    ny /= len;
    // Miter correction so corners keep the requested clearance.
    const cos = Math.max(0.2, nx * n1.x + ny * n1.y);
    out.push({ x: current.x + (nx * distanceMm) / cos, y: current.y + (ny * distanceMm) / cos });
  }
  return out;
}

function edgeNormal(a, b, sign) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: (sign * dy) / len, y: (-sign * dx) / len };
}
