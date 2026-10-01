// $20, $130-$132 and $100-$102 were read from the controller but never validated.
// $100-$102 are the axis steps/mm: the conversion between the steps the controller
// commands and the distance the machine travels. A change there rescales every
// stored measurement at once -- probed surface, protected floor, maximum cut
// depth, clearance height -- while leaving them all consistent with each other.
// That is the same shape of failure as the wrong plate thickness: everything
// agrees, and everything is wrong.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  STEPS_PER_MM_MAX,
  parseGrblSettings,
  readSettingsBaseline,
  validateControllerSettings,
  validateSettingsRecord,
  writeSettingsBaseline,
} from "./cnc-controller-settings.mjs";

// A healthy 4040-PRO reply, matching the settings read live on 2026-09-19.
const HEALTHY = [
  "$3=4", "$5=1", "$20=0", "$21=1", "$22=0", "$23=3", "$24=100", "$25=500", "$26=250", "$27=3",
  "$100=800.000", "$101=800.000", "$102=800.000",
  "$130=400.000", "$131=400.000", "$132=80.000", "ok",
];
const scratch = () => mkdtempSync(join(tmpdir(), "cnc-settings-"));

test("parses a $$ reply and ignores the surrounding noise", () => {
  const settings = parseGrblSettings(HEALTHY);
  assert.equal(settings[20], 0);
  assert.equal(settings[102], 800);
  assert.equal(settings[132], 80);
  // "ok" and anything that is not a $n=value record contributes nothing.
  assert.equal(Object.keys(settings).length, 16);
  // Accepts a raw string as well as an array of lines.
  assert.deepEqual(parseGrblSettings("$20=0\n$100=800\nok"), { 20: 0, 100: 800 });
  assert.deepEqual(parseGrblSettings(undefined), {});
});

test("a healthy controller with no baseline passes and reports its steps/mm", () => {
  const verdict = validateControllerSettings(parseGrblSettings(HEALTHY));
  assert.equal(verdict.ok, true, verdict.problems.join("; "));
  assert.deepEqual(verdict.stepsPerMm, { X: 800, Y: 800, Z: 800 });
  assert.equal(verdict.softLimits, 0);
});

test("soft limits must be OFF, because this machine is never homed", () => {
  // Z homing has never worked (ALARM:9, 2026-09-19), so homing is disabled and
  // machine coordinates are never established. Soft limits would be judging moves
  // against a machine origin that does not exist.
  const verdict = validateControllerSettings(parseGrblSettings([...HEALTHY, "$20=1"]));
  assert.equal(verdict.ok, false);
  assert.match(verdict.problems.join(" "), /\$20 \(soft limits\) is 1 but must be 0/);
  assert.match(verdict.problems.join(" "), /never homed/);
});

test("THE DRIFT CHECK: a changed steps/mm is refused and the error factor is named", () => {
  const baseline = { stepsPerMm: { X: 800, Y: 800, Z: 800 } };
  // Z steps/mm halved: every Z measurement now means twice the physical distance.
  const drifted = parseGrblSettings(HEALTHY.map((line) => (line.startsWith("$102=") ? "$102=400.000" : line)));
  const verdict = validateControllerSettings(drifted, { baseline });
  assert.equal(verdict.ok, false);
  const text = verdict.problems.join(" ");
  assert.match(text, /\$102 \(Z steps\/mm\) changed from 800 to 400/);
  assert.match(text, /wrong by a factor of 0\.5000/);
  assert.match(text, /re-probe before cutting/i);
});

test("an unchanged controller still passes against its baseline", () => {
  const verdict = validateControllerSettings(parseGrblSettings(HEALTHY), { baseline: { stepsPerMm: { X: 800, Y: 800, Z: 800 } } });
  assert.equal(verdict.ok, true, verdict.problems.join("; "));
  // GRBL stores 3 decimals, so a change below that is the same setting.
  const rounding = parseGrblSettings(HEALTHY.map((line) => (line.startsWith("$102=") ? "$102=800.0001" : line)));
  assert.equal(validateControllerSettings(rounding, { baseline: { stepsPerMm: { X: 800, Y: 800, Z: 800 } } }).ok, true);
  // But a real 3-decimal edit is caught.
  const edited = parseGrblSettings(HEALTHY.map((line) => (line.startsWith("$102=") ? "$102=800.002" : line)));
  assert.equal(validateControllerSettings(edited, { baseline: { stepsPerMm: { X: 800, Y: 800, Z: 800 } } }).ok, false);
});

test("an unreadable or implausible steps/mm is refused, not defaulted", () => {
  const missing = parseGrblSettings(HEALTHY.filter((line) => !line.startsWith("$102=")));
  assert.match(validateControllerSettings(missing).problems.join(" "), /\$102 \(Z steps\/mm\) could not be read/);
  const absurd = parseGrblSettings(HEALTHY.map((line) => (line.startsWith("$102=") ? `$102=${STEPS_PER_MM_MAX + 1}` : line)));
  assert.match(validateControllerSettings(absurd).problems.join(" "), /outside the plausible/);
});

test("controller travel must cover the envelope this software intends to command", () => {
  const settings = parseGrblSettings(HEALTHY);
  // Within the declared 400 mm travel: fine.
  assert.equal(validateControllerSettings(settings, { expectedEnvelope: { X: 280, Y: 150 } }).ok, true);
  // Beyond it: the software envelope would be the larger of the two, so the
  // machine reaches a hard stop inside what this code considers legal.
  const verdict = validateControllerSettings(settings, { expectedEnvelope: { X: 450 } });
  assert.equal(verdict.ok, false);
  assert.match(verdict.problems.join(" "), /\$130 \(X max travel\) is 400 mm but this software intends to use 450 mm/);
});

test("an axis the caller does not know about is skipped, not guessed", () => {
  // Inventing an envelope would produce a false alarm or a false reassurance.
  assert.equal(validateControllerSettings(parseGrblSettings(HEALTHY), { expectedEnvelope: {} }).ok, true);
});

test("an unreadable max travel is refused", () => {
  const missing = parseGrblSettings(HEALTHY.filter((line) => !line.startsWith("$132=")));
  assert.match(validateControllerSettings(missing).problems.join(" "), /\$132 \(Z max travel\) could not be read/);
});

test("the baseline round-trips, is stored private, and rejects a corrupt record", () => {
  const dir = scratch(), path = join(dir, "settings.json");
  try {
    const written = writeSettingsBaseline(path, { stepsPerMm: { X: 800, Y: 800, Z: 800 }, source: "unit test" });
    assert.deepEqual(written.stepsPerMm, { X: 800, Y: 800, Z: 800 });
    assert.deepEqual(readSettingsBaseline(path).stepsPerMm, { X: 800, Y: 800, Z: 800 });
    assert.throws(() => validateSettingsRecord({ version: 2, stepsPerMm: { X: 800, Y: 800, Z: 800 } }), /not supported/);
    assert.throws(() => writeSettingsBaseline(path, { stepsPerMm: { X: 800, Y: 800 } }), /Z steps\/mm is not usable/);
    // A corrupt file reads as "no baseline" rather than throwing, so a damaged
    // record cannot stop the daemon from reaching a usable setup state.
    writeFileSync(path, "{not json");
    assert.equal(readSettingsBaseline(path), null);
    assert.equal(readSettingsBaseline(join(dir, "absent.json")), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the daemon treats rejected settings as a frame incident, not a warning", async () => {
  const { readFileSync } = await import("node:fs");
  const daemon = readFileSync(new URL("./cnc-daemon.mjs", import.meta.url), "utf8");
  const body = daemon.slice(daemon.indexOf("const verifyControllerSettings"), daemon.indexOf("const keepalive"));
  // A wrong scale invalidates the coordinate frame the saved calibration lives
  // in, so it must latch rather than print and continue.
  assert.match(body, /latchFrameIncident\(`CONTROLLER_SETTINGS_REJECTED:/);
  assert.match(body, /recordEvent\("controller\.settings_rejected"/);
  // And the first clean sight becomes the baseline for every later start.
  assert.match(body, /if \(!baseline\)/);
  assert.match(body, /writeSettingsBaseline\(CONTROLLER_SETTINGS_PATH/);
  // The startup safety check must actually call it.
  assert.match(daemon, /verifyControllerSettings\(parseGrblSettings\(lines\)\)/);
});
