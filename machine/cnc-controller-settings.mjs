// Validation of the GRBL settings that decide whether a commanded millimetre is
// a physical millimetre, and whether the controller's own travel limits agree
// with the envelope this software enforces.
//
// WHY THIS EXISTS: the project reads and writes $21 (hard limits) and $22/$20
// (homing/soft limits) but never validated $20, $130-$132 or $100-$102. Those
// last three are the axis steps/mm. They are the conversion between the step
// counts the controller commands and the distance the machine actually travels.
// If $102 changes, every Z number in the system -- the probed surface, the
// protected floor, the maximum cut depth, the clearance height -- silently means
// a different physical depth, with nothing anywhere to notice. That is the same
// failure mode as the wrong plate thickness: all the derived numbers stay
// consistent with each other while all of them are wrong.
//
// We cannot know the CORRECT steps/mm for this machine from software. What we
// can do is pin whatever was in force when the machine was calibrated and refuse
// to proceed when it changes. That turns an invisible, uniform depth error into
// an explicit refusal.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// Steps/mm outside this band is not a plausible GRBL configuration for this
// class of machine and is far more likely a corrupt read than a real setting.
export const STEPS_PER_MM_MIN = 1;
export const STEPS_PER_MM_MAX = 10_000;
// Steps/mm are stored to 3 decimals by GRBL. Anything above this is a real edit.
export const STEPS_PER_MM_TOLERANCE = 0.0005;

export const AXIS_STEP_SETTINGS = { X: 100, Y: 101, Z: 102 };
export const AXIS_TRAVEL_SETTINGS = { X: 130, Y: 131, Z: 132 };

// Parses the `$$` reply into a number map. Tolerates the surrounding ok/echo
// lines and ignores anything that is not a `$n=value` record.
export function parseGrblSettings(lines) {
  const settings = {};
  for (const raw of Array.isArray(lines) ? lines : String(lines || "").split(/\r?\n/)) {
    const match = String(raw || "").trim().match(/^\$(\d+)=(-?\d+(?:\.\d+)?)/);
    if (match) settings[Number(match[1])] = Number(match[2]);
  }
  return settings;
}

const near = (a, b, tolerance) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tolerance;

// `expectedEnvelope` is the travel this software intends to use, in mm.
// `baseline` is the previously recorded steps/mm, or null on first sight.
// SEVERITY MATTERS, and conflating these two would create a new dead end.
//
// "frame": a steps/mm value DRIFTED from the recorded baseline. The scale between
// commanded and physical distance changed, so every saved measurement now means a
// different physical position. The coordinate frame the calibration lives in is
// genuinely invalid and cutting must stop until it is re-established.
//
// "report": the settings could not be read, are implausible, soft limits are on,
// or the declared travel is smaller than intended. These are real and must be
// surfaced, but an unreadable `$$` is a communications problem, not proof that
// the machine moved. Latching a hard interlock on a dropped read would brick the
// setup the way the stuck motion flag and the display:none Lock button did, and
// Start already demands positive evidence (confirmed plate, locked calibration,
// surface-contact proof) by other means.
export const SETTINGS_SEVERITY_FRAME = "frame";
export const SETTINGS_SEVERITY_REPORT = "report";

export function validateControllerSettings(settings, { expectedEnvelope = {}, baseline = null } = {}) {
  const found = [];
  const problems = [];
  const push = (severity, message) => { found.push({ severity, message }); problems.push(message); };
  const stepsPerMm = {};

  // SOFT LIMITS MUST BE OFF. This machine's Z homing has never worked (ALARM:9,
  // Sept 19) so homing is disabled and machine coordinates are never established.
  // Soft limits judge moves against a machine origin that does not exist here, so
  // leaving them on produces alarms unrelated to the real envelope and teaches the
  // operator to ignore limit alarms. The real envelope is enforced in software.
  if (settings[20] !== 0) {
    push(SETTINGS_SEVERITY_REPORT, `$20 (soft limits) is ${settings[20]} but must be 0: this machine is never homed, so there is no machine origin for soft limits to judge against.`);
  }

  for (const [axis, setting] of Object.entries(AXIS_STEP_SETTINGS)) {
    const value = settings[setting];
    stepsPerMm[axis] = Number.isFinite(value) ? value : null;
    if (!Number.isFinite(value)) {
      push(SETTINGS_SEVERITY_REPORT, `$${setting} (${axis} steps/mm) could not be read; a commanded millimetre cannot be shown to be a physical millimetre.`);
      continue;
    }
    if (value < STEPS_PER_MM_MIN || value > STEPS_PER_MM_MAX) {
      push(SETTINGS_SEVERITY_REPORT, `$${setting} (${axis} steps/mm) is ${value}, outside the plausible ${STEPS_PER_MM_MIN}-${STEPS_PER_MM_MAX} range.`);
      continue;
    }
    // THE DRIFT CHECK. A changed steps/mm rescales every stored measurement.
    const previous = baseline?.stepsPerMm?.[axis];
    if (Number.isFinite(previous) && !near(value, previous, STEPS_PER_MM_TOLERANCE)) {
      const scale = value / previous;
      push(SETTINGS_SEVERITY_FRAME, `$${setting} (${axis} steps/mm) changed from ${previous} to ${value}. Every saved ${axis} measurement is now wrong by a factor of ${scale.toFixed(4)}; re-probe before cutting.`);
    }
  }

  for (const [axis, setting] of Object.entries(AXIS_TRAVEL_SETTINGS)) {
    const value = settings[setting];
    if (!Number.isFinite(value) || value <= 0) {
      push(SETTINGS_SEVERITY_REPORT, `$${setting} (${axis} max travel) could not be read.`);
      continue;
    }
    // The controller's declared travel has to cover the envelope this software
    // will command, or the software envelope is the larger of the two and the
    // machine reaches a hard stop inside what we consider legal.
    const expected = Number(expectedEnvelope[axis]);
    if (Number.isFinite(expected) && expected > value + 0.001) {
      push(SETTINGS_SEVERITY_REPORT, `$${setting} (${axis} max travel) is ${value} mm but this software intends to use ${expected} mm.`);
    }
  }

  const frameProblems = found.filter((item) => item.severity === SETTINGS_SEVERITY_FRAME).map((item) => item.message);
  return {
    ok: problems.length === 0,
    // Only a drifted scale invalidates the coordinate frame.
    frameInvalid: frameProblems.length > 0,
    frameProblems,
    problems,
    found,
    stepsPerMm,
    softLimits: settings[20],
    validatedAt: new Date().toISOString(),
  };
}

export function validateSettingsRecord(raw) {
  if (!raw || typeof raw !== "object" || raw.version !== 1) throw new Error("Controller settings record is not supported");
  const stepsPerMm = {};
  for (const axis of Object.keys(AXIS_STEP_SETTINGS)) {
    const value = Number(raw.stepsPerMm?.[axis]);
    if (!Number.isFinite(value) || value < STEPS_PER_MM_MIN || value > STEPS_PER_MM_MAX) throw new Error(`Recorded ${axis} steps/mm is not usable`);
    stepsPerMm[axis] = value;
  }
  return { version: 1, stepsPerMm, capturedAt: String(raw.capturedAt || new Date().toISOString()), source: String(raw.source || "Captured from the live controller").slice(0, 160) };
}

export function readSettingsBaseline(path) {
  if (!path || !existsSync(path)) return null;
  try { return validateSettingsRecord(JSON.parse(readFileSync(path, "utf8"))); } catch { return null; }
}

export function writeSettingsBaseline(path, raw) {
  const record = validateSettingsRecord({ ...raw, version: 1 });
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
  chmodSync(path, 0o600);
  return record;
}
