// Material cutting data.
//
// C752 is 65-18 nickel silver (Cu 65 / Ni 18 / Zn 17). Its machinability rating
// is about 20 where free-cutting brass is 100, and it WORK-HARDENS: a tool that
// rubs instead of cutting leaves behind a harder surface than it started with,
// which makes the next pass worse. That feedback loop, not the base hardness, is
// what turned the rejected Profile stage into a ten-hour program.
//
// The two numbers that matter are therefore both LOWER bounds as much as upper
// ones: surface speed must stay low enough that the edge survives without
// coolant, and chip load must stay HIGH enough that the edge actually shears
// metal instead of burnishing it.

// Below this chip load a carbide edge of ordinary hone radius (3-10 um) cannot
// form a chip at all; it rubs. Any stage computing a chip load under this value
// is a ploughing program and must fail generation rather than be emitted.
export const PLOUGHING_CHIP_LOAD_MM = 0.01;

export const MATERIALS = Object.freeze({
  "c752-nickel-silver": Object.freeze({
    id: "c752-nickel-silver",
    name: "C752 nickel silver",
    machinabilityRating: 20,
    workHardens: true,
    // Dry / air-blast only. This machine has no flood coolant, so the surface
    // speed ceiling is set by heat the tool must survive unaided, well under
    // published flood-cooled production figures.
    maxSurfaceSpeedMPerMin: Object.freeze({
      // Uncoated solid carbide.
      carbide: 120,
      // TAC/TiAlN-class coating tolerates more heat at the edge.
      "coated-carbide": 150,
    }),
    // Chip-load targets per tool class, mm per tooth. Taken as a fraction of
    // cutter diameter in the usual way, then clamped by the ploughing floor.
    chipLoad: Object.freeze({
      // Single-flute O-flute clearing / peeling at light radial engagement.
      "single-flute-oflute": Object.freeze({ min: 0.025, target: 0.04, max: 0.055 }),
      // Same tool taking a full-width slot: halve it, the edge is engaged twice
      // as long per revolution and chips have nowhere to go sideways.
      "single-flute-oflute-slotting": Object.freeze({ min: 0.015, target: 0.025, max: 0.035 }),
      // Small tapered ball nose doing 3D finishing.
      "tapered-ball-nose": Object.freeze({ min: 0.012, target: 0.015, max: 0.022 }),
      "v-bit": Object.freeze({ min: 0.01, target: 0.015, max: 0.025 }),
      "flat-endmill": Object.freeze({ min: 0.02, target: 0.03, max: 0.045 }),
    }),
  }),
});

export function material(id) {
  const found = MATERIALS[id];
  if (!found) throw new Error(`Unknown material ${id}`);
  return found;
}
