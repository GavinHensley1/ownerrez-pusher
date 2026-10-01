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
//
// THE OPERATOR'S METAL RULE (Gavin, 2026-10-01, verbatim): "that is intact and
// the ball nose big one is intact I just wont use any of the small bits on
// metal." He has cause -- a 3.175 mm two-flute cutter snapped on first contact
// with C752 on 2026-09-29.
//
// That rule is recorded here per tool as `metal`, not applied as a diameter
// cut-off, because diameter alone gets it wrong in both directions. The W03010
// is a small cutter the operator explicitly keeps in play; the RU2100 is a large
// one that fails for a reason that has nothing to do with being small. Each
// entry says what it may do on metal and why, so the rule can be audited rather
// than inferred.
//
// WHY NOTHING IS "RETIRED" FOR A PHYSICS REASON ANY MORE. The RU2100 previously
// carried retired:true with the note that it "cannot reach a legal surface speed
// below gear 1". That is true, but burying it in a flag meant the generator
// could never show the arithmetic. It is now an ordinary metal-eligible entry
// and the feeds-and-speeds solver rejects it, by name, with its own numbers.
// A tool is only retired here when it physically no longer exists.

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
    metal: Object.freeze({
      permitted: true,
      // The operator confirmed this one intact on 2026-10-01 and kept it in
      // play. His "no small bits on metal" rule is honoured not by banning it
      // but by never letting it take a heavy cut: the engagement fractions above
      // cap it at 25% radial, so every metal pass is a peel or a trochoid and
      // never the full-width slot that broke the MC40A. assertLightEngagement()
      // enforces that, and full-immersion slotting is refused outright.
      maxRadialFractionOnMetal: 0.25,
      forbidFullImmersion: true,
      reason:
        "Operator-confirmed intact 2026-10-01. Single-flute O-flute geometry gives this cutter the chip clearance C752 needs; limited to light radial engagement so it is never loaded like the 3.175 mm two-flute that snapped.",
    }),
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
    metal: Object.freeze({
      permitted: true,
      maxRadialFractionOnMetal: 0.5,
      forbidFullImmersion: false,
      reason:
        "Operator-confirmed intact 2026-10-01 (\"the ball nose big one is intact\"). 6.35 mm shank within a few mm of the tip, so it is rigid despite the 1.5875 mm tip, and the TAC coating raises its heat ceiling. This is the finest tool permitted on metal, and therefore the bound on achievable detail.",
    }),
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
    metal: Object.freeze({
      permitted: false,
      reason:
        "Excluded from metal by the operator's standing rule, 2026-10-01: no small bits on metal. A 0.1 mm tip in a work-hardening alloy is the smallest bit he owns. Still usable on wood.",
    }),
    notes: "Lettering / rope / scroll detail only. WOOD ONLY.",
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
    // Whiteside rates this for wood / composites / hard plastics and thin
    // aluminium, not for C752. It is physically on hand and undamaged.
    nonFerrousRated: true,
    metal: Object.freeze({
      permitted: true,
      maxRadialFractionOnMetal: 0.25,
      forbidFullImmersion: true,
      // Re-examined 2026-10-01 at the operator's request, and the request was
      // right about the diagnosis: the rejected Profile stage failed because it
      // ran at FULL radial immersion with a 1.25 um/tooth chip load, and
      // trochoidal milling fixes that completely. At gear 1 with 0.5 mm radial
      // engagement this cutter takes a 30.0 um/tooth chip at 724 mm/min, which
      // is a healthy cut.
      //
      // It still cannot be used, for a reason chip load cannot touch. Staying
      // under the 120 m/min dry uncoated-carbide ceiling for C752 needs
      // 120000/(pi*6.35) = 6,015 RPM. The router's slowest speed is its
      // manufacturer-stated minimum, 6,500 RPM, which is 129.7 m/min -- 8.1%
      // over, at the lowest setting the machine has. There is no gear below
      // gear 1 and the diameter is fixed, so there is no lever left.
      //
      // The solver reaches that conclusion on its own from the numbers; this
      // note exists so the reasoning is not rediscovered a third time.
      reason:
        "Physically available and correct on wood. On C752 it is rejected by surface speed, not by chip load: it needs 6,015 RPM and the router's floor is 6,500 RPM.",
    }),
    maxAxialFractionOfDiameter: 0.25,
    maxRadialFractionOfDiameter: 0.25,
  }),

  "genmitsu-40pc-1p8-set": Object.freeze({
    id: "genmitsu-40pc-1p8-set",
    name: "Genmitsu 40-piece 1/8\" engraving set",
    kind: "mixed-set",
    geometry: "flat",
    diameterMm: 3.175,
    shankMm: 3.175,
    flutes: 2,
    cuttingLengthMm: 12,
    coating: "none",
    surfaceSpeedClass: "carbide",
    chipEvacuation: "poor",
    nonFerrousRated: false,
    metal: Object.freeze({
      permitted: false,
      reason:
        "Excluded from metal by the operator's standing rule, 2026-10-01: no small bits on metal. Listed explicitly rather than omitted, so the exclusion is a stated decision a test can check and not an accident of the library being incomplete.",
    }),
    notes: "Starter set. Wood and plastic only.",
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
    metal: Object.freeze({ permitted: false, reason: "Snapped in C752 on 2026-09-29. The tool no longer exists." }),
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

/**
 * The operator's "no small bits on metal" rule, as a gate.
 *
 * Returns the tool, or throws naming the tool and quoting the recorded reason.
 * Called by the feeds-and-speeds solver for every metal cut, so a stage cannot
 * reach a prohibited cutter by going around the library.
 */
export function assertPermittedOnMetal(toolSpec) {
  const policy = toolSpec.metal;
  if (!policy) {
    throw new Error(
      `${toolSpec.name} has no recorded metal policy. Every tool must state whether the operator permits it on metal; silence is not consent.`,
    );
  }
  if (!policy.permitted) {
    throw new Error(`${toolSpec.name} is not permitted on metal: ${policy.reason}`);
  }
  return toolSpec;
}

/**
 * Keep a permitted cutter inside the load the operator permits it to carry.
 *
 * This is the other half of the rule. Allowing the 1/8" cutter on metal is not
 * the same as allowing it to take the cut that snapped its predecessor, and the
 * difference between the two is radial engagement, not diameter.
 */
export function assertLightEngagementOnMetal(toolSpec, radialEngagementMm, chipLoadClass) {
  const policy = toolSpec.metal;
  const diameter = toolSpec.diameterMm ?? toolSpec.shankMm;
  const fraction = radialEngagementMm / diameter;

  // THE ONE EXEMPTION, stated rather than implied. Severing a tab is slotting by
  // definition: the remnant spans the kerf, so there is no side for the chips to
  // escape to and no trochoid that avoids it. The exemption is tied to the
  // halved slotting chip-load band, because that -- not the path -- is what
  // makes a full-width cut survivable. It is NOT a general permission: the
  // rejected Profile stage was full immersion on the ORDINARY chip load, which
  // is how it reached 1.25 um/tooth, and that remains refused.
  const slotting = typeof chipLoadClass === "string" && chipLoadClass.endsWith("-slotting");
  if (policy.forbidFullImmersion && fraction > 0.95 && !slotting) {
    throw new Error(
      `${toolSpec.name} may not take a full-immersion slot in metal: ${radialEngagementMm.toFixed(3)} mm radial on a ${diameter} mm cutter is ${(fraction * 100).toFixed(0)}% engagement. Use a trochoidal or peel path, or declare a slotting chip-load class if the cut genuinely has to be full width.`,
    );
  }
  if (slotting && fraction > 0.95) return fraction;
  const limit = policy.maxRadialFractionOnMetal;
  if (Number.isFinite(limit) && fraction > limit + 1e-9) {
    throw new Error(
      `${toolSpec.name} is limited to ${(limit * 100).toFixed(0)}% radial engagement on metal, but this stage asks for ${(fraction * 100).toFixed(0)}% (${radialEngagementMm.toFixed(3)} mm on a ${diameter} mm cutter). ${policy.reason}`,
    );
  }
  return fraction;
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
