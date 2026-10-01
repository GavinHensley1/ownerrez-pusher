// G-code emitter.
//
// Every motion in a generated program goes through this builder, which enforces
// the project's motion contract structurally rather than checking for it
// afterwards. The contract exists because of real damage:
//
//   - no rapid at or below Z0            (a rapid into metal is a gouge)
//   - XY travel only above the clearance plane
//   - no vertical plunge into metal; entries are lateral or helical ramps
//   - vertical retract before any exit travel
//   - final retract, then M30
//   - no G10/G28/G30/G53/G91/G92/M3/M4/M5/M6 (the router is manual AC, and an
//     offset command can silently redefine zero)
//
// Feeds are passed in from the solver. The builder refuses a cutting move with
// no feed, so a stage physically cannot emit an unfed cut.

import { MACHINE } from "./machine-library.mjs";

const FORBIDDEN = /\b(?:G10|G28|G30|G53|G91|G92|M0?3|M0?4|M0?5|M0?6)\b/i;

// SainSmart ships this Z-probe plate in documented thickness variants. A wrong
// value shifts absolute Z zero by exactly its error while bed-minus-stock
// thickness still looks correct, because the same error cancels in the
// subtraction. A 20 mm value against a ~14.19 mm plate cut about 6 mm too deep
// on 2026-09-30 and is the root cause of that incident.
export const KNOWN_PLATE_THICKNESSES_MM = Object.freeze([14.0, 14.19, 20.17]);
export const PLATE_FAMILY_TOLERANCE_MM = 0.25;

/**
 * Refuse to generate unless the clearance plane is provably above the stock.
 *
 * Clearance is expressed in WORK coordinates, where Z0 is wherever probing put
 * it. If the probe plate thickness is wrong, Z0 is wrong by that error and a
 * "clearance" of +4.99 mm can sit inside the material. A number greater than
 * zero therefore proves nothing on its own.
 */
export function assertClearanceAboveStock({ clearanceZMm, plateThicknessMm, plateConfirmed, stockThicknessMm }) {
  if (!(clearanceZMm > 0)) {
    throw new Error(`Clearance plane Z${clearanceZMm} is not above the stock surface`);
  }
  if (!Number.isFinite(plateThicknessMm)) {
    throw new Error(
      "Cannot certify clearance: no Z-probe plate thickness recorded. Z0 is defined by the plate, so its value is part of the program's safety case.",
    );
  }
  const nearest = KNOWN_PLATE_THICKNESSES_MM.reduce((best, value) =>
    Math.abs(value - plateThicknessMm) < Math.abs(best - plateThicknessMm) ? value : best,
  );
  const familyError = Math.abs(nearest - plateThicknessMm);
  if (familyError > PLATE_FAMILY_TOLERANCE_MM) {
    throw new Error(
      `Z-probe plate thickness ${plateThicknessMm} mm matches no documented SainSmart variant (${KNOWN_PLATE_THICKNESSES_MM.join(", ")} mm). An unrecognised plate value is exactly how Z0 was placed ~6 mm below the real surface on 2026-09-30.`,
    );
  }
  if (!plateConfirmed) {
    throw new Error(
      `Z-probe plate thickness ${plateThicknessMm} mm has not been confirmed by the operator. It must be a measured or deliberately chosen value, never a default carried forward.`,
    );
  }
  // Worst credible residual error is picking the wrong variant in the family.
  const spread = Math.max(...KNOWN_PLATE_THICKNESSES_MM) - Math.min(...KNOWN_PLATE_THICKNESSES_MM);
  const withinFamily = KNOWN_PLATE_THICKNESSES_MM.filter((v) => Math.abs(v - plateThicknessMm) <= 1);
  const residual = withinFamily.length > 1 ? Math.max(...withinFamily) - Math.min(...withinFamily) : 0;
  if (clearanceZMm <= residual) {
    throw new Error(
      `Clearance ${clearanceZMm} mm does not exceed the ${residual} mm residual uncertainty in the confirmed plate thickness`,
    );
  }
  if (Number.isFinite(stockThicknessMm) && clearanceZMm >= stockThicknessMm + spread + 50) {
    throw new Error(`Clearance ${clearanceZMm} mm is implausibly far above a ${stockThicknessMm} mm stock`);
  }

  // The documented plate variants differ by about 6 mm, which is more than the
  // clearance plane. So confirming a thickness is NOT by itself enough: if the
  // operator confirms the wrong family, the "clearance" sits inside the metal
  // and the first traverse gouges, which is what happened on 2026-09-30. CAM
  // cannot settle that from numbers; only touching the surface can. Say so.
  const physicalSurfaceProofRequired = clearanceZMm < spread;

  return { nearest, familyError, residual, spread, physicalSurfaceProofRequired };
}

export class ProgramBuilder {
  /**
   * @param {object} options
   * @param {string} options.stage
   * @param {number} [options.clearanceZMm]
   * @param {number} options.plateThicknessMm
   * @param {boolean} options.plateConfirmed
   * @param {number} options.stockThicknessMm
   * @param {number} options.maxDepthMm  deepest Z this stage is allowed to reach
   */
  constructor(options) {
    const clearanceZMm = options.clearanceZMm ?? MACHINE.clearanceZMm;
    assertClearanceAboveStock({
      clearanceZMm,
      plateThicknessMm: options.plateThicknessMm,
      plateConfirmed: options.plateConfirmed,
      stockThicknessMm: options.stockThicknessMm,
    });

    this.stage = options.stage;
    this.clearanceZMm = clearanceZMm;
    this.maxDepthMm = options.maxDepthMm;
    this.lines = ["G21", "G90"];
    this.x = 0;
    this.y = 0;
    this.z = clearanceZMm;
    this.feed = null;
    this.motion = null;
    this.cutDistanceMm = 0;
    this.cutTimeMin = 0;
    this.rapidDistanceMm = 0;
    this.started = false;
    this.lines.push(`G0 Z${fmt(clearanceZMm)} F${MACHINE.rapidFeedMmPerMin}`);
    this.motion = 0;
  }

  /** Rapid in XY. Only legal above the clearance plane. */
  travelTo(x, y) {
    if (this.z < this.clearanceZMm - 1e-9) {
      throw new Error(`${this.stage}: XY travel requested at Z${fmt(this.z)}, below the clearance plane`);
    }
    const words = [];
    if (!near(x, this.x)) words.push(`X${fmt(x)}`);
    if (!near(y, this.y)) words.push(`Y${fmt(y)}`);
    if (!words.length) return this;
    this.rapidDistanceMm += Math.hypot(x - this.x, y - this.y);
    this.x = x;
    this.y = y;
    this.emit(`G0 ${words.join(" ")}`, 0);
    return this;
  }

  /** Vertical retract to the clearance plane. */
  retract() {
    if (near(this.z, this.clearanceZMm)) return this;
    this.z = this.clearanceZMm;
    this.emit(`G0 Z${fmt(this.clearanceZMm)}`, 0);
    return this;
  }

  /**
   * Rapid descent toward the work. Permitted only while strictly above Z0, so
   * the tool never approaches material at rapid.
   */
  approach(z) {
    if (z <= 0) throw new Error(`${this.stage}: rapid approach to Z${fmt(z)} would reach the stock surface`);
    if (z > this.z) throw new Error(`${this.stage}: approach must descend`);
    this.z = z;
    this.emit(`G0 Z${fmt(z)}`, 0);
    return this;
  }

  /**
   * A fed cutting move. This is the ONLY way material is removed, and it
   * refuses a vertical descent into metal: entries must ramp.
   */
  cutTo(x, y, z, feed) {
    if (!(feed > 0)) throw new Error(`${this.stage}: cutting move with no feed`);
    if (z < -this.maxDepthMm - 1e-6) {
      throw new Error(`${this.stage}: move to Z${fmt(z)} exceeds this stage's ${this.maxDepthMm} mm depth limit`);
    }
    const dx = x - this.x;
    const dy = y - this.y;
    const dz = z - this.z;
    const lateral = Math.hypot(dx, dy);
    if (dz < -1e-9 && lateral < 1e-9 && z < 0) {
      throw new Error(
        `${this.stage}: vertical plunge from Z${fmt(this.z)} to Z${fmt(z)} enters the stock. Use rampTo() so the entry is lateral or helical.`,
      );
    }
    const words = [];
    if (!near(x, this.x)) words.push(`X${fmt(x)}`);
    if (!near(y, this.y)) words.push(`Y${fmt(y)}`);
    if (!near(z, this.z)) words.push(`Z${fmt(z)}`);
    if (!words.length) return this;
    const distance = Math.hypot(dx, dy, dz);
    this.cutDistanceMm += distance;
    this.cutTimeMin += distance / feed;
    this.x = x;
    this.y = y;
    this.z = z;
    const feedWord = this.feed === feed ? "" : ` F${fmt(feed)}`;
    this.feed = feed;
    this.emit(`G1 ${words.join(" ")}${feedWord}`, 1);
    return this;
  }

  /**
   * Ramped entry. Descends to targetZ while travelling along the supplied
   * polyline, so the cutter engages at a shallow angle instead of plunging.
   * The ramp is traversed as many times as needed to keep the entry angle under
   * `maxAngleDeg`.
   */
  rampTo(points, targetZ, feed, { maxAngleDeg = 15, maxDropPerPassMm = Infinity } = {}) {
    if (points.length < 2) throw new Error(`${this.stage}: ramp needs at least two points`);
    const head = points[0];
    const tail = points[points.length - 1];
    const atHead = near(this.x, head.x) && near(this.y, head.y);
    const atTail = near(this.x, tail.x) && near(this.y, tail.y);

    if (!atHead && !atTail) {
      // Repositioning is only safe above the stock. Below it, the caller must
      // already have the tool at one end of the ramp route.
      if (this.z < 0) throw new Error(`${this.stage}: ramp cannot reposition to its start while below the surface`);
      this.retract().travelTo(head.x, head.y);
    }
    if (this.z > 0.2) this.approach(0.2);

    const startZ = this.z;
    const drop = startZ - targetZ;
    let runLength = 0;
    for (let i = 1; i < points.length; i += 1) {
      runLength += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    }
    if (runLength < 1e-9) throw new Error(`${this.stage}: ramp route has no length`);
    if (drop <= 1e-9) {
      const destination = atTail ? head : tail;
      return this.cutTo(destination.x, destination.y, targetZ, feed);
    }

    const byAngle = Math.ceil(drop / Math.max(1e-9, runLength * Math.tan((maxAngleDeg * Math.PI) / 180)));
    const byDepth = Math.ceil(drop / Math.max(1e-9, maxDropPerPassMm));
    const passes = Math.max(1, byAngle, byDepth);

    // Start from whichever end the tool is already at, then alternate.
    let reversed = atTail && !atHead;
    for (let pass = 0; pass < passes; pass += 1) {
      const from = startZ - (drop * pass) / passes;
      const to = startZ - (drop * (pass + 1)) / passes;
      const route = reversed ? [...points].reverse() : points;
      let travelled = 0;
      for (let i = 1; i < route.length; i += 1) {
        travelled += Math.hypot(route[i].x - route[i - 1].x, route[i].y - route[i - 1].y);
        this.cutTo(route[i].x, route[i].y, from + (to - from) * (travelled / runLength), feed);
      }
      reversed = !reversed;
    }
    return this;
  }

  /**
   * Ramp into a 3D path without gouging it.
   *
   * A straight lead-in ramp between two points of a raster run is only safe if
   * the surface between them is no higher than its endpoints. On a relief it
   * usually is higher somewhere, and the ramp cuts straight through it. So the
   * descent is clamped at every sample to the depth the path itself allows
   * there: the tool follows whichever is shallower, the ramp or the surface.
   *
   * Zig-zags an even number of passes so the tool finishes back at points[0],
   * ready to cut the full run.
   */
  rampEntryAlong(points, feed, { maxAngleDeg = 20 } = {}) {
    if (points.length < 2) return this;
    let runLength = 0;
    const cumulative = [0];
    for (let i = 1; i < points.length; i += 1) {
      runLength += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
      cumulative.push(runLength);
    }
    if (runLength < 1e-9) return this;

    const deepest = Math.min(...points.map((p) => p.z));
    const startZ = Math.min(this.z, 0.2);
    const drop = startZ - deepest;
    if (drop <= 1e-9) return this;

    const perPass = runLength * Math.tan((maxAngleDeg * Math.PI) / 180);
    let passes = Math.max(1, Math.ceil(drop / Math.max(1e-9, perPass)));
    if (passes % 2 === 1) passes += 1; // finish back at points[0]

    for (let pass = 0; pass < passes; pass += 1) {
      const from = startZ - (drop * pass) / passes;
      const to = startZ - (drop * (pass + 1)) / passes;
      const forward = pass % 2 === 0;
      for (let k = 1; k < points.length; k += 1) {
        const i = forward ? k : points.length - 1 - k;
        const travelled = forward ? cumulative[i] : runLength - cumulative[i];
        const rampZ = from + (to - from) * (travelled / runLength);
        // Never descend below what the surface allows at this point.
        this.cutTo(points[i].x, points[i].y, Math.max(points[i].z, rampZ), feed);
      }
    }
    return this;
  }

  emit(line, motion) {
    if (FORBIDDEN.test(line)) throw new Error(`${this.stage}: emitted a forbidden command: ${line}`);
    this.lines.push(line);
    this.motion = motion;
    this.started = true;
    return this;
  }

  comment(text) {
    this.lines.push(`(${String(text).replace(/[()]/g, "")})`);
    return this;
  }

  /** Final vertical retract then M30. */
  finish() {
    this.retract();
    // The contract requires the last motion to be exactly the certified retract.
    if (!/^G0 Z/.test(this.lines[this.lines.length - 1])) {
      this.lines.push(`G0 Z${fmt(this.clearanceZMm)}`);
    }
    this.lines.push("M30");
    return `${this.lines.join("\n")}\n`;
  }

  metrics() {
    return {
      lines: this.lines.length,
      cutDistanceMm: this.cutDistanceMm,
      rapidDistanceMm: this.rapidDistanceMm,
      cutTimeMin: this.cutTimeMin,
    };
  }
}

export function fmt(value) {
  const rounded = Math.round(value * 10000) / 10000;
  if (Object.is(rounded, -0)) return "0";
  return String(rounded);
}

function near(a, b) {
  return Math.abs(a - b) < 1e-5;
}

/**
 * Collapse a dense polyline into the fewest moves that stay within `toleranceMm`
 * of the original, in 3D.
 *
 * This is not cosmetic. The controller is fed one line at a time over Wi-Fi at
 * about 25 lines per second, so a path made of 0.12 mm segments physically
 * cannot run faster than ~180 mm/min no matter what feed is programmed. Emitting
 * a point every 0.12 mm across a flat field is what made the previous Finish
 * stage transport-bound as well as feed-bound.
 */
export function linearize(points, toleranceMm) {
  if (points.length <= 2) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [start, end] = stack.pop();
    if (end <= start + 1) continue;
    let worst = -1;
    let worstIndex = -1;
    for (let i = start + 1; i < end; i += 1) {
      const d = pointLineDistance(points[i], points[start], points[end]);
      if (d > worst) {
        worst = d;
        worstIndex = i;
      }
    }
    if (worst > toleranceMm) {
      keep[worstIndex] = 1;
      stack.push([start, worstIndex], [worstIndex, end]);
    }
  }
  const out = [];
  for (let i = 0; i < points.length; i += 1) if (keep[i]) out.push(points[i]);
  return out;
}

function pointLineDistance(p, a, b) {
  const ax = b.x - a.x;
  const ay = b.y - a.y;
  const az = b.z - a.z;
  const lengthSquared = ax * ax + ay * ay + az * az;
  if (lengthSquared < 1e-18) return Math.hypot(p.x - a.x, p.y - a.y, p.z - a.z);
  let t = ((p.x - a.x) * ax + (p.y - a.y) * ay + (p.z - a.z) * az) / lengthSquared;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + ax * t), p.y - (a.y + ay * t), p.z - (a.z + az * t));
}
