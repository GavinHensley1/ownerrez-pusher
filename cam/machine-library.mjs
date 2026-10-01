// Machine definition for the Genmitsu 4040-PRO with the manual AC router.
//
// The router is a Genmitsu GM7100E 710 W / 65 mm compact router. It is a MANUAL
// AC tool: the controller cannot set or read its speed, so RPM is whatever gear
// the operator physically selects. Generated programs therefore emit no M3/M4/M5
// and instead record the required gear as a human instruction.
//
// WHY THIS FILE EXISTS: every bad feed in the rejected Kiri:Moto programs traces
// back to one assumption — that 18,000 RPM (gear 4) was the only speed available.
// With a 6.35 mm cutter that is 359 m/min in C752 nickel silver, roughly ten
// times the sane surface speed. The CAM compensated by collapsing feed and axial
// depth until the chip load fell to 1.25 um/tooth, below the carbide edge radius,
// so the tool ploughed instead of cutting. Gear 1 exists and is 6,500 RPM.

// PROVENANCE OF THE GEAR TABLE
// ----------------------------
// Manufacturer data (SainSmart product page, SKU 101-63-GM7100E-AJ, read
// 2026-10-01): "710W CNC Spindle Motor Trimmer Router, 65mm Diameter, 6 Variable
// Speeds 6500-30000RPM". The 6,500 minimum and 30,000 maximum and the six-detent
// dial are manufacturer-stated. SainSmart does not publish a per-detent RPM table
// on any page reachable from here, so the intermediate detents are MODELLED, not
// measured, from two independent models:
//
//   A. Even interpolation across the six detents of the stated 6,500-30,000 range.
//   B. The two values this project has recorded in use: gear 2 = 10,000 RPM and
//      gear 4 = 18,000 RPM (memory/projects/cnc-carving.md, 2026-09-26/09-29).
//
// The models disagree by up to 2,600 RPM, so each gear carries a RANGE rather
// than a number, and every safety check uses the worst-case end of that range:
//   - surface-speed ceiling  -> checked at rpmMax (hottest case)
//   - chip-load floor        -> checked at rpmMax (thinnest chip case)
//   - chip-load ceiling      -> checked at rpmMin (thickest chip case)
// Feed itself is computed at rpmNominal. This is fail-safe under the full spread,
// so a physical dial reading would tighten the numbers but cannot invalidate them.
//
// PHYSICAL FACT STILL WANTED: the printed per-detent RPM table on the router body
// or in its paper manual. It would replace the modelled range with exact values.
const STATED_RPM_MIN = 6500;
const STATED_RPM_MAX = 30000;
const GEAR_MODEL_A = [6500, 11200, 15900, 20600, 25300, 30000];
const GEAR_MODEL_B = [6000, 10000, 14000, 18000, 22000, 26000];

// THE ENDPOINTS ARE NOT MODELLED. On a six-detent dial whose range the
// manufacturer states as 6,500-30,000 RPM, detent 1 IS 6,500 and detent 6 IS
// 30,000. Model B reaches those endpoints by extrapolating backwards from two
// mid-range values recorded in use, and it lands at 6,000 and 26,000 -- 6,000 is
// below the speed the manufacturer says this router can produce, so it is an
// artefact of the extrapolation, not a speed the machine has. Carrying it
// forward would hand a cutter 500 RPM of headroom that does not exist, which on
// the largest cutter is the difference between legal and illegal. Only the four
// interior detents are genuinely uncertain.
const GEARS = GEAR_MODEL_A.map((a, index) => {
  const interior = index > 0 && index < GEAR_MODEL_A.length - 1;
  if (!interior) {
    const stated = index === 0 ? STATED_RPM_MIN : STATED_RPM_MAX;
    return Object.freeze({ gear: index + 1, rpmMin: stated, rpmMax: stated, rpmNominal: stated, modelled: false });
  }
  const b = GEAR_MODEL_B[index];
  return Object.freeze({
    gear: index + 1,
    rpmMin: Math.min(a, b),
    rpmMax: Math.max(a, b),
    rpmNominal: Math.round((a + b) / 2),
    modelled: a !== b,
  });
});

export const ROUTER = Object.freeze({
  id: "genmitsu-gm7100e-710w",
  name: "Genmitsu GM7100E · 710 W · 65 mm manual AC router",
  manualSpeedControl: true,
  statedRpmMin: STATED_RPM_MIN,
  statedRpmMax: STATED_RPM_MAX,
  gears: Object.freeze(GEARS),
});

export const MACHINE = Object.freeze({
  id: "genmitsu-4040-pro",
  name: "Genmitsu 4040-PRO",
  router: ROUTER,
  // ER11 collets physically on hand. Both shank sizes are usable.
  collets: Object.freeze(["1/8\" (3.175 mm)", "1/4\" (6.35 mm)"]),
  // Clearance plane used by every certified program in this project. Kept as a
  // machine constant so the generator and the validator cannot disagree.
  clearanceZMm: 4.99,
  rapidFeedMmPerMin: 300,
  // MEASURED controller line rate. G-code reaches this machine one line at a
  // time over the GGW-UART Wi-Fi bridge, so on a path of very short segments the
  // line rate, not the feed word, decides how fast the machine actually moves.
  //
  // Provenance: the 2026-09-28 Finish run streamed to executable line 205,977
  // between 19:51:45Z and 21:51:59Z, i.e. 205,977 lines in 7,214 s = 28.6
  // lines/s sustained while cutting. Derated to 25 for planning headroom.
  // That run's 0.12 mm segments at 240 mm/min needed 33 lines/s, which is why it
  // ran at roughly 87% of its programmed feed.
  programLinesPerSecond: 25,
});

export function gear(number) {
  const found = ROUTER.gears.find((entry) => entry.gear === number);
  if (!found) throw new Error(`Router has no gear ${number}`);
  return found;
}

// Lowest gear whose WORST-CASE rpm keeps the tool under its surface-speed limit
// at the given engaged diameter. Returns null when even gear 1 is too fast, which
// is a real answer: it means the tool is the wrong size for this material on this
// router, not that the feed should be reduced to compensate.
export function slowestGearWithin(maxSurfaceSpeedMPerMin, engagedDiameterMm) {
  for (const entry of ROUTER.gears) {
    const surfaceSpeed = (Math.PI * engagedDiameterMm * entry.rpmMax) / 1000;
    if (surfaceSpeed <= maxSurfaceSpeedMPerMin) return entry;
  }
  return null;
}

export function surfaceSpeedMPerMin(diameterMm, rpm) {
  return (Math.PI * diameterMm * rpm) / 1000;
}
