// Physical cutting tools on hand, with the geometry the CAM needs.
//
// Every entry here is a tool this project has recorded as physically present
// (memory/projects/cnc-carving.md lines 356, 597, 666, 689, 704). Nothing in
// this file may be invented: if a tool is not in the operator's hands it does
// not belong here, because the generator will happily produce a perfect program
// for a cutter that does not exist.
//
// NO FEED OR RPM APPEARS IN THIS FILE. Feeds and speeds are derived in
// feeds-speeds.mjs from this geometry plus the material limits. Hard-coding a
// feed is exactly how the rejected programs ended up at 45 mm/min.

export const TOOLS = Object.freeze({
  "spetool-w03010": Object.freeze({
    id: "spetool-w03010",
    name: "SpeTool W03010 · 1/8\" single-flute O-flute upcut",
    kind: "single-flute-oflute",
    geometry: "flat",
    diameterMm: 3.175,
    shankMm: 3.175,
    flutes: 1,
    // Common cutting length for this SpeTool 1/8" O-flute family. Only the
    // deepest generated stage matters here (through-profile, ~4.06 mm) and every
    // variant of this cutter clears that, so the exact value is not load-bearing.
    cuttingLengthMm: 12.7,
    coating: "none",
    surfaceSpeedClass: "carbide",
    // O-flute geometry: a single deep polished gullet. Designed for full-slot
    // work in non-ferrous metal because chips leave instead of recutting.
    chipEvacuation: "excellent",
    nonFerrousRated: true,
    // Side load limit expressed as a fraction of diameter, used to bound axial
    // depth in trochoidal/peel passes on a long-ish 3.175 mm carbide shank.
    maxAxialFractionOfDiameter: 0.5,
    maxRadialFractionOfDiameter: 0.25,
    notes: "Correct tool for clearing and for the through-profile. Fits the 1/8\" ER11 collet.",
  }),

  "spetool-w01015-spe-x": Object.freeze({
    id: "spetool-w01015-spe-x",
    name: "SpeTool W01015-SPE-X · TAC tapered ball nose · 1/32\" radius",
    kind: "tapered-ball-nose",
    geometry: "tapered-ball",
    tipRadiusMm: 0.79375,
    diameterMm: 1.5875,
    shankMm: 6.35,
    flutes: 2,
    cuttingLengthMm: 25.4,
    taperHalfAngleDeg: 5.38,
    coating: "TAC",
    surfaceSpeedClass: "coated-carbide",
    chipEvacuation: "good",
    nonFerrousRated: true,
    // Rigid: the taper means the shank is 6.35 mm within a few mm of the tip.
    maxAxialFractionOfDiameter: 0.25,
    maxRadialFractionOfDiameter: 0.5,
    notes: "The 3D finish tool. Resolves the artwork; the taper makes it stiff despite the 1.5875 mm tip.",
  }),

  "vbit-30deg-0p1mm": Object.freeze({
    id: "vbit-30deg-0p1mm",
    name: "30° V-bit · 0.1 mm tip · 1/8\" shank",
    kind: "v-bit",
    geometry: "v",
    tipDiameterMm: 0.1,
    includedAngleDeg: 30,
    shankMm: 3.175,
    flutes: 1,
    cuttingLengthMm: 10,
    coating: "none",
    surfaceSpeedClass: "carbide",
    chipEvacuation: "fair",
    nonFerrousRated: true,
    maxAxialFractionOfDiameter: 1,
    maxRadialFractionOfDiameter: 1,
    notes: "Lettering / rope / scroll detail only.",
  }),

  "whiteside-ru2100": Object.freeze({
    id: "whiteside-ru2100",
    name: "Whiteside RU2100 · 1/4\" two-flute upcut",
    kind: "flat-endmill",
    geometry: "flat",
    diameterMm: 6.35,
    shankMm: 6.35,
    flutes: 2,
    cuttingLengthMm: 25.4,
    coating: "none",
    surfaceSpeedClass: "carbide",
    chipEvacuation: "good",
    // Whiteside rates this for wood / composites / hard plastics / thin
    // aluminium. It is NOT rated for C752 and the operator rejected it on
    // 2026-09-30 after it gouged the blank.
    nonFerrousRated: false,
    retired: true,
    retiredReason:
      "Rejected by the operator 2026-09-30. Not rated for C752, and at 6.35 mm it cannot reach a legal surface speed below gear 1.",
    maxAxialFractionOfDiameter: 0.25,
    maxRadialFractionOfDiameter: 0.25,
  }),

  "genmitsu-mc40a-3p175": Object.freeze({
    id: "genmitsu-mc40a-3p175",
    name: "Genmitsu MC40A · 3.175 mm two-flute",
    kind: "flat-endmill",
    geometry: "flat",
    diameterMm: 3.175,
    shankMm: 3.175,
    flutes: 2,
    cuttingLengthMm: 17,
    coating: "none",
    surfaceSpeedClass: "carbide",
    chipEvacuation: "poor",
    nonFerrousRated: false,
    retired: true,
    retiredReason:
      "This is the cutter that snapped on first contact with C752 on 2026-09-29. Long 17 mm non-stub flute, general-purpose starter-set tool. Do not design around it.",
    maxAxialFractionOfDiameter: 0.1,
    maxRadialFractionOfDiameter: 0.1,
  }),
});

export function tool(id) {
  const found = TOOLS[id];
  if (!found) throw new Error(`Unknown tool ${id}`);
  if (found.retired) throw new Error(`Tool ${id} is retired: ${found.retiredReason}`);
  return found;
}

// Diameter actually in contact with the work. A flat cutter engages its full
// diameter; a ball or tapered ball engages only the width of the arc that is
// below the surface, which is what sets its real surface speed.
export function engagedDiameterMm(toolSpec, axialDepthMm) {
  const depth = Math.max(0, axialDepthMm);
  if (toolSpec.geometry === "flat") return toolSpec.diameterMm;
  if (toolSpec.geometry === "v") {
    const half = (toolSpec.includedAngleDeg * Math.PI) / 360;
    return Math.min(toolSpec.shankMm, toolSpec.tipDiameterMm + 2 * depth * Math.tan(half));
  }
  if (toolSpec.geometry === "tapered-ball") {
    const r = toolSpec.tipRadiusMm;
    // Within the spherical tip the contact width is the chord at that depth.
    if (depth <= r) return 2 * Math.sqrt(Math.max(0, 2 * r * depth - depth * depth));
    // Above the tangent point the taper takes over.
    const taper = (toolSpec.taperHalfAngleDeg * Math.PI) / 180;
    return Math.min(toolSpec.shankMm, 2 * (r / Math.cos(taper) + (depth - r) * Math.tan(taper)));
  }
  throw new Error(`Tool ${toolSpec.id} has no engagement model for geometry ${toolSpec.geometry}`);
}

// Vertical offset from the tool tip to the tool surface at horizontal distance
// d from the tool axis. Used to sweep the tool over a height field.
// Returns null when d is beyond the modelled profile.
export function profileOffsetMm(toolSpec, d) {
  if (toolSpec.geometry === "flat") return d <= toolSpec.diameterMm / 2 ? 0 : null;
  if (toolSpec.geometry === "tapered-ball") {
    const r = toolSpec.tipRadiusMm;
    const taper = (toolSpec.taperHalfAngleDeg * Math.PI) / 180;
    // Ball and cone meet where the cone is tangent to the sphere, just below the
    // sphere's equator, at horizontal distance r*cos(taper).
    const tangentRadius = r * Math.cos(taper);
    if (d <= tangentRadius) return r - Math.sqrt(Math.max(0, r * r - d * d));
    const coneZ = (d - r / Math.cos(taper)) / Math.tan(taper);
    return r + coneZ;
  }
  if (toolSpec.geometry === "v") {
    const half = (toolSpec.includedAngleDeg * Math.PI) / 360;
    const maxRadius = toolSpec.shankMm / 2;
    if (d > maxRadius) return null;
    return Math.max(0, (d - toolSpec.tipDiameterMm / 2) / Math.tan(half));
  }
  throw new Error(`Tool ${toolSpec.id} has no sweep profile`);
}

// Largest horizontal distance at which the tool can still be below the surface
// for a cut no deeper than maxDepthMm. Bounds the stamp footprint in sweeps.
export function sweepRadiusMm(toolSpec, maxDepthMm) {
  if (toolSpec.geometry === "flat") return toolSpec.diameterMm / 2;
  return engagedDiameterMm(toolSpec, maxDepthMm) / 2;
}
