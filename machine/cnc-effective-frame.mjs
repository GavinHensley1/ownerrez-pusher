// Read-only, cut-only coordinate verification. Never changes modal state or zeros.
// GRBL reports the active WCS in $G and G54/G92/TLO parameters in $#.
// See https://github.com/gnea/grbl/wiki/Grbl-v1.1-Commands
const AXES = ["X", "Y", "Z"];
const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

function record(lines, label) {
  if (!Array.isArray(lines)) throw new Error(`Effective frame ${label} response is missing`);
  const matching = lines.map(String).filter(line => line.startsWith(`[${label}:`));
  if (matching.length !== 1 || !matching[0].endsWith("]")) throw new Error(`Effective frame ${label} response is missing or ambiguous`);
  return matching[0].slice(label.length + 2, -1);
}

function scalar(raw, label) {
  if (typeof raw !== "string" || !NUMBER.test(raw) || !Number.isFinite(Number(raw))) throw new Error(`Effective frame ${label} value is invalid`);
  return Number(raw);
}

function vector(raw, label) {
  const words = String(raw).split(",");
  if (words.length < 3 || words.length > 4) throw new Error(`Effective frame ${label} requires XYZ`);
  const values = words.map((word, i) => scalar(word, `${label} ${AXES[i] || "A"}`));
  return Object.fromEntries(AXES.map((axis, i) => [axis, values[i]]));
}

export function inspectEffectiveCutFrame({ modalLines, parameterLines, status, expectedOrigin, toleranceMm = 0.02 }) {
  if (!Number.isFinite(toleranceMm) || toleranceMm < 0 || toleranceMm > 0.05) throw new Error("Effective frame tolerance must be 0-0.05 mm");
  const modes = record(modalLines, "GC").trim().split(/\s+/);
  const wcs = modes.filter(mode => /^G5[4-9]$/.test(mode));
  if (wcs.length !== 1 || wcs[0] !== "G54") throw new Error(`Cut requires active G54; controller reports ${wcs.join(" ") || "unknown WCS"}`);
  // G-code files normalize units and distance mode, but do not normalize feed mode.
  if (modes.filter(mode => /^G9[34]$/.test(mode)).join(" ") !== "G94") throw new Error("Cut requires G94 feed-per-minute mode");
  if (modes.includes("G43.1")) throw new Error("Cut requires inactive tool-length compensation");
  const g54 = vector(record(parameterLines, "G54"), "G54");
  const g92 = vector(record(parameterLines, "G92"), "G92");
  const toolLengthOffset = scalar(record(parameterLines, "TLO"), "TLO");
  // Zero means zero to the resolution of the controller's report; don't silently
  // accept a hidden offset merely because it is below the origin tolerance.
  for (const axis of AXES) if (g92[axis] !== 0) throw new Error(`Cut requires zero G92 ${axis}; found ${g92[axis]}`);
  if (toolLengthOffset !== 0) throw new Error(`Cut requires zero tool-length offset; found ${toolLengthOffset}`);
  if (!status || status.state !== "Idle") throw new Error("Effective cut frame requires Idle controller telemetry");
  const machinePosition = vector(status.MPos, "MPos");
  const origin = {};
  for (const axis of AXES) {
    const value = expectedOrigin?.[axis];
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Expected ${axis} origin is unavailable`);
    origin[axis] = value;
    if (Math.abs(g54[axis] - value) > toleranceMm + 1e-9) throw new Error(`Controller G54 ${axis} differs from calibrated origin: ${g54[axis]} versus ${value}`);
  }
  // WCO appears intermittently in GRBL reports. If supplied, it is independent
  // evidence of the effective active transform and must agree with the parameters.
  const reportedWco = status.WCO === undefined ? null : vector(status.WCO, "WCO");
  if (reportedWco) for (const axis of AXES) if (Math.abs(reportedWco[axis] - g54[axis]) > toleranceMm + 1e-9) throw new Error(`Effective WCO ${axis} differs from verified G54`);
  return { verified: true, activeWcs: "G54", g54, g92, toolLengthOffset, machinePosition, reportedWco,
    workPosition: Object.fromEntries(AXES.map(axis => [axis, machinePosition[axis] - g54[axis]])) };
}
