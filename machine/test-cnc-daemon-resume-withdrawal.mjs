// Live daemon tests for withdrawing a stale resume offer.
//
// THE INCIDENT THESE LOCK DOWN: after the 2026-09-30 stop, ~/.openclaw/state held
// an "interrupted" checkpoint for job cnc_mun692ol2mq at line 1676 of 173218. That
// checkpoint belongs to the certified metal rough stage, which ran against a 20 mm
// plate figure while the physical plate is ~14.19 mm, so every commanded depth was
// about 5.8 mm too deep. /health published the raw checkpoint, so the UI offered a
// resume. Resuming it would repeat the damage at the depth that caused it.
//
// These drive the real daemon against a simulated GRBL, so they prove the published
// verdict and the endpoint agree — not that a source string exists.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const PLATE_MM = 14.19;
// The real camSourceHash of the certified metal rough stage, which is in the
// api/cnc-program-holds.cjs audit set.
const HELD_ROUGH_HASH = "f8ec8a70558be73f2936b29ad153813b755e8e2ceafc899df181629432f68ac1";
const CAPTURED_AT = "2026-09-30T19:22:07.777Z";

const waitFor = async (predicate, timeoutMs = 8000) => {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { if (await predicate()) return; await new Promise((resolve) => setTimeout(resolve, 25)); }
  throw new Error("Timed out waiting for simulated CNC daemon");
};

const unixRequest = (socketPath, path, body) => new Promise((resolve, reject) => {
  const data = body === undefined ? "" : JSON.stringify(body);
  const req = http.request({ socketPath, path, method: body === undefined ? "GET" : "POST", headers: body === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(data) } }, (res) => {
    let text = ""; res.setEncoding("utf8"); res.on("data", (chunk) => { text += chunk; }); res.on("end", () => {
      let value; try { value = JSON.parse(text); } catch { return reject(new Error(text)); }
      resolve({ status: res.statusCode, value });
    });
  });
  req.on("error", reject); if (data) req.write(data); req.end();
});

// Idle-only GRBL stand-in. These tests never probe or move; they only need the
// daemon to connect and report a stable frame.
async function makeIdleGrbl() {
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      for (const byte of chunk) {
        const char = String.fromCharCode(byte);
        if (char === "?") { socket.write("<Idle|MPos:0.000,0.000,0.000|FS:0,0>\r\n"); continue; }
        if (byte === 0x85 || byte === 0x9e || byte === 0x18 || char === "!" || char === "~") continue;
        buffer += char;
        if (char !== "\r") continue;
        const command = buffer.trim(); buffer = "";
        if (command === "$$") socket.write("$13=0\r\n$21=1\r\nok\r\n");
        else if (command === "$#") socket.write("[G54:0.000,0.000,0.000,0.000]\r\n[G92:0,0,0]\r\n[TLO:0]\r\n[PRB:0.000,0.000,0.000:0]\r\nok\r\n");
        else if (command === "$G") socket.write("[GC:G0 G54 G17 G21 G90 G94 M5 M9 T0 F0 S0]\r\nok\r\n");
        else socket.write("ok\r\n");
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: server.address().port, close: () => new Promise((resolve) => server.close(resolve)) };
}

const startDaemon = (dir, grbl, socketPath) => spawn(process.execPath, [new URL("./cnc-daemon.mjs", import.meta.url).pathname], {
  cwd: new URL("../", import.meta.url).pathname,
  env: {
    ...process.env,
    CNC_HOST: "127.0.0.1", CNC_PORT: String(grbl.port), CNC_DAEMON_SOCKET: socketPath, CNC_LOCAL_UI_PORT: "0",
    CNC_PROBE_STATE: join(dir, "probe.json"), CNC_MATERIAL_STATE: join(dir, "material.json"), CNC_XY_STATE: join(dir, "xy.json"),
    CNC_PROGRAM_STATE: join(dir, "program.json"), CNC_RUN_STATE: join(dir, "run.json"), CNC_EVENT_JOURNAL: join(dir, "events.jsonl"),
    CNC_FRAME_INCIDENT: join(dir, "frame-incident.json"), CNC_PLATE_CONFIG: join(dir, "plate.json"),
  },
  stdio: ["ignore", "pipe", "pipe"],
});

// A short manual-router program with a safe retract, so a resume could in
// principle be built. Nothing here should ever make a refusal pass.
const WOOD_GCODE = ["G21", "G90", "G0 Z5", "G0 X10 Y10", "G1 Z-1 F100", "G1 X20 Y10", "G0 Z5", "G0 X30 Y10", "G1 Z-1 F100", "G1 X40 Y10", "G0 Z5"].join("\n");

const savedProgram = (overrides = {}) => ({
  version: 1, jobId: "cnc_mun692ol2mq", capturedAt: CAPTURED_AT, state: "accepted",
  gcode: WOOD_GCODE,
  ...overrides,
  context: {
    stockWidthMm: 260, stockHeightMm: 130, stockReserveMm: 5, manualRouter: true,
    operation: "rough", material: "Softwood / pine", camProvider: "", camCertification: "",
    camSourceHash: "", camAuditHash: "", camStage: "", camTool: "",
    allowSacrificialCutThrough: false, sacrificialBackingConfirmed: false, profileDepthMm: null,
    ...(overrides.context || {}),
  },
});

const interruptedCheckpoint = (overrides = {}) => ({
  version: 1, jobId: "cnc_mun692ol2mq", programCapturedAt: CAPTURED_AT, state: "interrupted",
  lastCompletedLine: 1676, totalLines: 173218, message: "Stopped by Project",
  updatedAt: "2026-09-30T19:24:15.112Z", ...overrides,
});

const validLock = () => ({
  version: 1, locked: true, probeThickness: PLATE_MM,
  bedSurfaceMPos: -3.855, stockSurfaceMPos: 0, stockThicknessMm: 3.855,
  safetyFloorMm: 0.8, maxCutDepthMm: 3.055, zOriginMPos: 0,
  lastKnownMPos: { X: 0, Y: 0, Z: 0 },
  capturedAt: CAPTURED_AT, lockedAt: CAPTURED_AT, source: "matching-plate calibration",
});

const validXy = () => ({
  version: 1, locked: true, xyOriginMPos: { X: 0, Y: 0 }, lastKnownMPos: { X: 0, Y: 0 },
  lockedAt: CAPTURED_AT, source: "Project guarded front-left X/Y origin",
});

// Boots a daemon over a seeded state directory and returns its /health resume block.
async function bootWithState(t, files) {
  const dir = mkdtempSync(join(tmpdir(), "cnc-resume-")), socketPath = join(dir, "cnc.sock"), grbl = await makeIdleGrbl();
  for (const [name, value] of Object.entries(files)) writeFileSync(join(dir, name), JSON.stringify(value));
  const child = startDaemon(dir, grbl, socketPath);
  let stderr = ""; child.stderr.on("data", (chunk) => { stderr += chunk; });
  t.after(async () => { child.kill("SIGTERM"); await new Promise((resolve) => child.once("exit", resolve)); await grbl.close(); });
  await waitFor(() => existsSync(socketPath));
  await waitFor(async () => (await unixRequest(socketPath, "/health")).value.connected === true);
  const health = (await unixRequest(socketPath, "/health")).value;
  return { dir, socketPath, health, stderr: () => stderr };
}

test("a latched frame incident withdraws the resume offer and demands a fresh setup", async (t) => {
  const { socketPath, health } = await bootWithState(t, {
    "program.json": savedProgram(),
    "run.json": interruptedCheckpoint(),
    "plate.json": { version: 1, plateThicknessMm: PLATE_MM, updatedAt: CAPTURED_AT, source: "operator measured", confirmedByOperator: true, measuredBy: "operator" },
    "probe.json": validLock(),
    // No xy.json on purpose. Clearing the cutting interlock requires verified X/Y
    // AND Z, so with X/Y unverified the latch stays up — which is the state this
    // test is about. (With both locks continuous the daemon legitimately verifies
    // the frame and clears the latch by itself; that path is covered by the metal
    // test below, which blocks without relying on a latch at all.)
    "frame-incident.json": { version: 1, latched: true, frameValid: false, reason: "PROGRAM_STOP_REQUESTED", occurredAt: "2026-09-30T19:24:15.083Z", duringMotion: true, jobId: "cnc_mun692ol2mq" },
  });
  assert.equal(health.frameValid, false);
  assert.equal(health.resume.resumable, false, "a latched incident must never advertise a resume");
  assert.equal(health.resume.requiresFreshSetup, true);
  assert.match(health.resume.blockedReason, /PROGRAM_STOP_REQUESTED/);
  assert.match(health.resume.blockedReason, /restart the stage from line 1/i);
  // The checkpoint facts stay visible; only the OFFER is withdrawn.
  assert.equal(health.resume.lastCompletedLine, 1676);
  assert.equal(health.resume.totalLines, 173218);

  const attempt = await unixRequest(socketPath, "/job/resume-saved", { confirm: true, allowReposition: true });
  assert.equal(attempt.status, 500);
  assert.match(attempt.value.error, /Cutting is blocked after PROGRAM_STOP_REQUESTED/);
});

test("the metal checkpoint from the incident is refused on its own, without relying on the latch", async (t) => {
  const { socketPath, health } = await bootWithState(t, {
    // Exactly the stored program from the incident: certified metal rough.
    "program.json": savedProgram({ context: { material: "C752 nickel silver", camProvider: "kiri-moto", camCertification: "verified", camSourceHash: HELD_ROUGH_HASH, camStage: "rough", camTool: "Whiteside RU2100 · 1/4″ two-flute upcut" } }),
    "run.json": interruptedCheckpoint(),
    "plate.json": { version: 1, plateThicknessMm: PLATE_MM, updatedAt: CAPTURED_AT, source: "operator measured", confirmedByOperator: true, measuredBy: "operator" },
    "probe.json": validLock(),
    "xy.json": validXy(),
  });
  assert.equal(health.frameValid, true, "this case must stand on its own merits, not on a latched frame");
  assert.equal(health.resume.resumable, false);
  assert.equal(health.resume.requiresFreshSetup, true);
  assert.match(health.resume.blockedReason, /metal|audit/i);

  const attempt = await unixRequest(socketPath, "/job/resume-saved", { confirm: true, allowReposition: true });
  assert.equal(attempt.status, 500);
  assert.match(attempt.value.error, /metal|audit/i);
});

test("an unproven surface contact cannot be resumed even when it is not metal", async (t) => {
  // This test used to assert that one of the five certified Rambo-buckle hashes
  // sat on an unconditional blocklist. That premise is retired: all 834,070
  // lines were independently audited and the programs were never the fault, so
  // being on a hash list is no longer a reason to hold. What IS still a reason is
  // an unproven Z reference. The surface-contact proof is deliberately in-memory,
  // so a daemon restart clears it, and a freshly booted daemon must not offer a
  // resume even for a non-metal checkpoint whose plate and calibration agree.
  const { socketPath, health } = await bootWithState(t, {
    "program.json": savedProgram({ context: { camSourceHash: HELD_ROUGH_HASH } }),
    "run.json": interruptedCheckpoint(),
    "plate.json": { version: 1, plateThicknessMm: PLATE_MM, updatedAt: CAPTURED_AT, source: "operator measured", confirmedByOperator: true, measuredBy: "operator" },
    "probe.json": validLock(),
    "xy.json": validXy(),
  });
  assert.equal(health.resume.resumable, false);
  assert.match(health.resume.blockedReason, /surface contact is proven independently of the plate/i);
  // Clearable by one operator action, so it must NOT demand a fresh setup. That
  // distinction is what keeps a safe gate from becoming a dead end.
  assert.equal(health.resume.requiresFreshSetup, false);
  assert.equal((await unixRequest(socketPath, "/job/resume-saved", { confirm: true })).status, 500);
});

test("an unconfirmed plate withdraws the offer, because the depth error was a plate error", async (t) => {
  const { socketPath, health } = await bootWithState(t, {
    "program.json": savedProgram(),
    "run.json": interruptedCheckpoint(),
    "probe.json": validLock(),
    "xy.json": validXy(),
    // No plate.json: the daemon falls back to the UNCONFIRMED default.
  });
  assert.equal(health.plate.confirmed, false);
  assert.equal(health.resume.resumable, false);
  assert.match(health.resume.blockedReason, /never been confirmed/i);
  // An unknown Z reference is not clearable by a single action; it demands a
  // re-probe, so this one DOES require a fresh setup.
  assert.equal(health.resume.requiresFreshSetup, true);
  assert.equal((await unixRequest(socketPath, "/job/resume-saved", { confirm: true })).status, 500);
});

test("a checkpoint from a different program than the stored one is refused", async (t) => {
  const { health } = await bootWithState(t, {
    "program.json": savedProgram({ capturedAt: "2026-10-01T10:00:00.000Z" }),
    "run.json": interruptedCheckpoint(),
    "plate.json": { version: 1, plateThicknessMm: PLATE_MM, updatedAt: CAPTURED_AT, source: "operator measured", confirmedByOperator: true, measuredBy: "operator" },
    "probe.json": validLock(),
    "xy.json": validXy(),
  });
  assert.equal(health.resume.resumable, false);
  assert.match(health.resume.blockedReason, /different program/i);
  assert.equal(health.resume.requiresFreshSetup, true);
});

test("a calibration made with a different plate withdraws the offer", async (t) => {
  const { health } = await bootWithState(t, {
    "program.json": savedProgram(),
    "run.json": interruptedCheckpoint(),
    "plate.json": { version: 1, plateThicknessMm: PLATE_MM, updatedAt: CAPTURED_AT, source: "operator measured", confirmedByOperator: true, measuredBy: "operator" },
    // The stale 20 mm lock from the incident. It is continuous with the controller,
    // so only the plate mismatch can reject it.
    "probe.json": { ...validLock(), probeThickness: 20, source: "stale 20 mm plate calibration" },
    "xy.json": validXy(),
  });
  assert.equal(health.setup.probeLocked, false);
  assert.equal(health.resume.resumable, false);
  assert.match(health.resume.blockedReason, /locked Z calibration|plate/i);
});

test("the gate is not permanently closed: a clean non-metal checkpoint stays resumable", async (t) => {
  // Without this, every test above would pass even if resumeSnapshot always
  // refused, which would hide a broken recovery path rather than a withdrawn one.
  const { socketPath, health } = await bootWithState(t, {
    "program.json": savedProgram(),
    "run.json": interruptedCheckpoint(),
    "plate.json": { version: 1, plateThicknessMm: PLATE_MM, updatedAt: CAPTURED_AT, source: "operator measured", confirmedByOperator: true, measuredBy: "operator" },
    "probe.json": validLock(),
    "xy.json": validXy(),
  });
  assert.equal(health.plate.confirmed, true);
  assert.equal(health.setup.probeLocked, true, "the matching-plate calibration must restore");

  // On a cold boot the only outstanding condition is the surface-contact proof,
  // which is in-memory and therefore absent. Clear it the way the operator does.
  // Wood accepts an attestation, which needs no machine motion.
  const proof = await unixRequest(socketPath, "/probe/verify-surface", { method: "operator-attested-feeler", confirm: true });
  assert.equal(proof.status, 200, `attested surface proof should be accepted, got: ${JSON.stringify(proof.value)}`);

  const after = (await unixRequest(socketPath, "/health")).value;
  assert.equal(after.surfaceProof.ready, true);
  assert.equal(after.resume.resumable, true, `resume should be available here, got: ${after.resume.blockedReason}`);
  assert.equal(after.resume.blockedReason, "");
});

test("a running or completed checkpoint is not a resume offer", async (t) => {
  for (const state of ["running", "done"]) {
    const { health } = await bootWithState(t, {
      "program.json": savedProgram(),
      "run.json": interruptedCheckpoint({ state }),
      "plate.json": { version: 1, plateThicknessMm: PLATE_MM, updatedAt: CAPTURED_AT, source: "operator measured", confirmedByOperator: true, measuredBy: "operator" },
      "probe.json": validLock(),
      "xy.json": validXy(),
    });
    assert.equal(health.resume.resumable, false, `${state} must not be resumable`);
    assert.match(health.resume.blockedReason, /No interrupted checkpoint/i);
  }
});
