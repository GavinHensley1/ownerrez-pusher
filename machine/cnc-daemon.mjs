import http from "node:http";
import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { GrblTcpController, coordinates, parseStatus, parseWorkOffset, VirtualWorkspace } from "./cnc-controller.mjs";
import { measuredStockProtection, validateProgramEnvelope, validateProgramStockEnvelope } from "./cnc-program.mjs";
import { cameraBridgeFresh } from "./cnc-camera-diagnostics.mjs";
import { applyProbeLock, assertLockedProbeZJog, calibrationFromSetup, readProbeLock, removeProbeLock, writeProbeLock } from "./cnc-probe-state.mjs";
import { applyXyLock, readXyLock, removeXyLock, writeXyLock, xyLockFromSetup } from "./cnc-xy-state.mjs";

const HOST = process.env.CNC_HOST || "192.168.1.183";
const PORT = Number(process.env.CNC_PORT || 10086);
const CAMERA = process.env.CNC_CAMERA_BRIDGE || "http://127.0.0.1:47831";
const SOCKET_PATH = process.env.CNC_DAEMON_SOCKET || "/tmp/openclaw-cnc.sock";
const PROBE_STATE_PATH = process.env.CNC_PROBE_STATE || join(homedir(), ".openclaw", "state", "cnc-probe-calibration.json");
const XY_STATE_PATH = process.env.CNC_XY_STATE || join(homedir(), ".openclaw", "state", "cnc-xy-origin.json");
const CAMERA_MAX_AGE_MS = 3000;
const CAMERA_REQUIRED = /^(1|true|yes)$/i.test(process.env.CNC_CAMERA_REQUIRED || "1");
const MAX_BODY_BYTES = 900_000;
let controller, lastControllerStatus, incident, moving = false, keepaliveBusy = false;
let restartScheduled = false;
let reconnectPromise;
let nextReconnectAt = 0;
const RECONNECT_BACKOFF_MS = 10_000;
const workspace = new VirtualWorkspace();
const setup = { xyReady: false, xyLockStatus: "unlocked", xyLockedAt: null, bedProbeReady: false, stockProbeReady: false, probeReady: false, probeLocked: false, probeLockStatus: "unlocked", probeLockedAt: null, probeThickness: null, bedSurfaceMPos: null, stockSurfaceMPos: null, stockThicknessMm: null, safetyFloorMm: null, maxCutDepthMm: null, xyOriginMPos: null, zOriginMPos: null, updatedAt: null };
const job = { state: "idle", jobId: null, progress: 0, message: "", updatedAt: null };

const json = (res, status, value) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(value)); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const cameraStatus = async () => { const response = await fetch(`${CAMERA}/status`, { signal: AbortSignal.timeout(2000) }); if (!response.ok) throw new Error(`Camera status HTTP ${response.status}`); return response.json(); };
const ensureCameraMonitor = async () => {
  let status = await cameraStatus();
  if (status.state !== "ready") throw new Error(`Camera not ready: ${status.state}`);
  if (!status.monitoring) { const response = await fetch(`${CAMERA}/monitor/start`, { method: "POST", signal: AbortSignal.timeout(3000) }); if (!response.ok) throw new Error(`Camera monitor start HTTP ${response.status}`); }
  const deadline = Date.now() + 25_000;
  do {
    status = await cameraStatus();
    if (cameraBridgeFresh(status, Date.now(), CAMERA_MAX_AGE_MS)) return status;
    await sleep(250);
  } while (Date.now() < deadline);
  throw new Error("Camera monitor did not produce a fresh frame");
};
const assertCameraFresh = async () => {
  const status = await cameraStatus(), age = Date.now() - Number(status.lastFrameAt || 0);
  if (!cameraBridgeFresh(status, Date.now(), CAMERA_MAX_AGE_MS)) {
    throw new Error(`Camera interlock open: state=${status.state} fresh=${status.fresh} monitoring=${status.monitoring} ageMs=${age}`);
  }
  return status;
};
const motionGuard = async () => {
  if (CAMERA_REQUIRED) return assertCameraFresh();
  try { return await cameraStatus(); } catch { return { state: "unavailable", monitoring: false, optional: true }; }
};

const programGuard = async ({ analysis, programContext }) => {
  const snap = workspace.snapshot();
  if (!snap.calibrated) throw new Error("Virtual boundaries are not calibrated");
  if (!setup.xyReady) throw new Error("Set X/Y zero before starting");
  if (!setup.bedProbeReady || !setup.stockProbeReady || !setup.probeReady) throw new Error("Probe the bed and stock before starting");
  if (!setup.probeLocked) throw new Error("Lock the probe calibration before starting");
  if (!Number.isFinite(setup.maxCutDepthMm) || setup.maxCutDepthMm <= 0) throw new Error("Measured stock depth is unavailable");
  validateProgramEnvelope(analysis, { widthMm: 360, heightMm: 360, maxDepthMm: setup.maxCutDepthMm, maxSafeZMm: 6 });
  validateProgramStockEnvelope(analysis, { widthMm: programContext?.stockWidthMm, heightMm: programContext?.stockHeightMm, reserveMm: programContext?.stockReserveMm });
  const origins = { X: setup.xyOriginMPos?.X, Y: setup.xyOriginMPos?.Y, Z: setup.zOriginMPos };
  for (const axis of ["X", "Y", "Z"]) {
    if (!Number.isFinite(origins[axis])) throw new Error(`${axis} work origin is unavailable`);
    const low = origins[axis] + analysis.bounds[axis].min, high = origins[axis] + analysis.bounds[axis].max, allowed = snap.bounds[axis];
    if (low < allowed.min - 0.001 || high > allowed.max + 0.001) throw new Error(`${axis} program envelope ${low.toFixed(3)}..${high.toFixed(3)} exceeds virtual boundary ${allowed.min.toFixed(3)}..${allowed.max.toFixed(3)}`);
  }
};

controller = new GrblTcpController({ host: HOST, port: PORT, statusTimeoutMs: 600, commandTimeoutMs: 15_000, motionGuard, workspaceGuard: (request) => workspace.assertJog(request), programGuard, maxJogMm: 25, maxJogFeed: 500, maxSessionTravelMm: 2000, maxSpindleTestRpm: 2000 });
controller.on("programProgress", (value) => Object.assign(job, { progress: value.progress, message: `Line ${value.line} of ${value.total}`, updatedAt: new Date().toISOString() }));
const clearSetup = () => Object.assign(setup, { xyReady: false, xyLockStatus: "unlocked", xyLockedAt: null, bedProbeReady: false, stockProbeReady: false, probeReady: false, probeLocked: false, probeLockStatus: "unlocked", probeLockedAt: null, probeThickness: null, bedSurfaceMPos: null, stockSurfaceMPos: null, stockThicknessMm: null, safetyFloorMm: null, maxCutDepthMm: null, xyOriginMPos: null, zOriginMPos: null, updatedAt: new Date().toISOString() });
const clearProbeSetup = (status = "unlocked_reprobe_required") => Object.assign(setup, { bedProbeReady: false, stockProbeReady: false, probeReady: false, probeLocked: false, probeLockStatus: status, probeLockedAt: null, probeThickness: null, bedSurfaceMPos: null, stockSurfaceMPos: null, stockThicknessMm: null, safetyFloorMm: null, maxCutDepthMm: null, zOriginMPos: null, updatedAt: new Date().toISOString() });
const rebuildWorkspaceFromSetup = () => {
  if (!setup.xyReady || !setup.probeReady || !Number.isFinite(setup.xyOriginMPos?.X) || !Number.isFinite(setup.xyOriginMPos?.Y) || !Number.isFinite(setup.zOriginMPos) || !Number.isFinite(setup.maxCutDepthMm)) { workspace.clear(); return null; }
  return workspace.setBounds({ X: { min: setup.xyOriginMPos.X, max: setup.xyOriginMPos.X + 360 }, Y: { min: setup.xyOriginMPos.Y, max: setup.xyOriginMPos.Y + 360 }, Z: { min: setup.zOriginMPos - setup.maxCutDepthMm, max: setup.zOriginMPos + 6 } });
};
const persistLockedXy = (status) => {
  if (!setup.xyReady) return null;
  const lock = xyLockFromSetup(setup, status);
  writeXyLock(XY_STATE_PATH, lock);
  setup.xyLockStatus = "locked";
  setup.xyLockedAt = lock.lockedAt;
  return lock;
};
const restoreLockedXy = (status, workOffset) => {
  const raw = readXyLock(XY_STATE_PATH);
  if (!raw) return null;
  try { return applyXyLock(setup, raw, status, 0.05, workOffset); }
  catch (error) {
    setup.xyReady = false;
    setup.xyLockStatus = `rejected: ${error.message}`;
    setup.updatedAt = new Date().toISOString();
    return null;
  }
};
const persistLockedProbe = (status) => {
  if (!setup.probeLocked) return null;
  const lock = calibrationFromSetup(setup, status);
  writeProbeLock(PROBE_STATE_PATH, lock);
  setup.probeLockStatus = "locked";
  setup.probeLockedAt = lock.lockedAt;
  return lock;
};
const restoreLockedProbe = (status, workOffset) => {
  const raw = readProbeLock(PROBE_STATE_PATH);
  if (!raw) return null;
  try { return applyProbeLock(setup, raw, status, 0.05, workOffset); }
  catch (error) {
    setup.probeLocked = false;
    setup.probeLockStatus = `rejected: ${error.message}`;
    setup.updatedAt = new Date().toISOString();
    return null;
  }
};
const hazardousOperationActive = () => moving || ["running", "paused"].includes(job.state);
const scheduleRestart = () => { if (restartScheduled) return; restartScheduled = true; setTimeout(() => process.exit(1), 750).unref(); };
controller.on("fault", (error) => {
  const hazardous = hazardousOperationActive();
  incident = error?.message || "CONTROLLER_FAULT";
  workspace.clear();
  clearSetup();
  if (hazardous) scheduleRestart();
});
controller.on("close", () => {
  const hazardous = hazardousOperationActive();
  if (hazardous) incident = "CONTROLLER_CONNECTION_LOST";
  workspace.clear();
  clearSetup();
  if (hazardous) scheduleRestart();
});

const readStatus = async () => (lastControllerStatus = parseStatus(await controller.status({ attempts: 5 })));
const recoverIdleConnection = async () => {
  if (controller.connected || hazardousOperationActive()) return;
  if (reconnectPromise) return reconnectPromise;
  if (Date.now() < nextReconnectAt) return;
  nextReconnectAt = Date.now() + RECONNECT_BACKOFF_MS;
  reconnectPromise = (async () => {
    await controller.resetConnection();
    const startupStatus = await readStatus();
    await restoreHardLimitsOnStartup(startupStatus);
    if (!controller.connected) throw new Error("Controller disconnected during startup safety check");
    if (startupStatus.state !== "Idle") {
      setup.xyLockStatus = `rejected: controller startup state ${startupStatus.state} requires explicit recovery`;
      setup.probeLockStatus = `rejected: controller startup state ${startupStatus.state} requires explicit recovery`;
      workspace.clear();
      incident = undefined;
      return;
    }
    const workOffset = parseWorkOffset(await controller.query("$#"));
    restoreLockedXy(startupStatus, workOffset);
    restoreLockedProbe(startupStatus, workOffset);
    rebuildWorkspaceFromSetup();
    incident = undefined;
  })().catch((error) => {
    incident = `CONNECT_FAILED:${error?.message || "unknown"}`;
  }).finally(() => { reconnectPromise = undefined; });
  return reconnectPromise;
};
const health = async () => {
  if (!controller.connected && !hazardousOperationActive()) await recoverIdleConnection();
  let camera;
  try {
    const status = await cameraStatus();
    camera = {
      state: status.state,
      monitoring: Boolean(status.monitoring),
      lastFrameAt: status.lastFrameAt || null,
      fresh: cameraBridgeFresh(status, Date.now(), CAMERA_MAX_AGE_MS),
      diagnostics: status.diagnostics || null,
    };
  }
  catch (error) { camera = { state: "error", monitoring: false, fresh: false, error: error.message }; }
  camera.required = CAMERA_REQUIRED;
  return { ok: true, connected: controller.connected, moving, incident, lastControllerStatus, camera, workspace: workspace.snapshot(), setup: { ...setup }, job: { ...job } };
};
const observe = async () => { let camera; try { camera = await ensureCameraMonitor(); } catch (error) { if (CAMERA_REQUIRED) throw error; camera = { state: "unavailable", monitoring: false, optional: true, error: error.message }; } return { camera, cnc: await readStatus() }; };
const assertIdle = async () => { const status = await readStatus(); if (status.state !== "Idle") throw new Error(`Controller must be Idle, got ${status.state}`); const [feed, spindle] = String(status.FS || "0,0").split(",").map(Number); if (feed || spindle) throw new Error(`Feed/spindle must be zero, got ${status.FS}`); return status; };

const jog = async (axis, payload) => {
  if (moving || ["running", "paused"].includes(job.state)) throw new Error("A CNC operation is already active");
  moving = true; incident = undefined;
  try {
    await motionGuard();
    const distance = Number(payload.distanceMm);
    if (axis === "Z" && (!Number.isFinite(distance) || Math.abs(distance) > 5)) throw new Error("Z jogs are limited to 5 mm per Project command");
    if (axis === "Z" && setup.probeLocked) assertLockedProbeZJog(setup, await assertIdle(), distance);
    const manualPositioning = Boolean(payload.manualPositioning);
    const calibration = manualPositioning && !workspace.snapshot().calibrated;
    const result = await controller.jog(axis, payload.distanceMm, payload.feedMmPerMin, { calibration });
    lastControllerStatus = result.after;
    persistLockedXy(result.after);
    persistLockedProbe(result.after);
    return result;
  }
  catch (error) { incident = error?.message || "JOG_FAILED"; throw error; } finally { moving = false; }
};
const spindleTest = async () => {
  if (moving || ["running", "paused"].includes(job.state)) throw new Error("A CNC operation is already active");
  moving = true; incident = undefined;
  try { await motionGuard(); const result = await controller.spindleTest(1000, 2000); lastControllerStatus = result.after; return result; }
  catch (error) { incident = error?.message || "SPINDLE_TEST_FAILED"; throw error; } finally { moving = false; }
};
const setXyZero = async () => {
  if (moving || ["running", "paused"].includes(job.state)) throw new Error("A CNC operation is already active");
  await motionGuard(); const before = await assertIdle(); await controller.setWorkOffset({ x: 0, y: 0 });
  setup.xyOriginMPos = coordinates(before); setup.xyReady = true; setup.updatedAt = new Date().toISOString();
  setup.xyLockStatus = "locked";
  persistLockedXy(before);
  rebuildWorkspaceFromSetup();
  persistLockedProbe(before);
  return { setup: { ...setup }, status: before };
};
const probeSurface = async (kind, payload) => {
  if (moving || ["running", "paused"].includes(job.state)) throw new Error("A CNC operation is already active");
  if (!new Set(["bed", "stock"]).has(kind)) throw new Error("Unknown probe surface");
  if (setup.probeLocked) throw new Error("Probe calibration is locked; unlock it before re-probing");
  if (kind === "stock" && !setup.bedProbeReady) throw new Error("Probe the exposed bed before probing the stock");
  moving = true; incident = undefined;
  try {
    await motionGuard(); const result = await controller.probeZ({ thicknessMm: payload.thicknessMm }); const thickness = Number(result.thicknessMm);
    const contactZ = coordinates(result.finalContact).Z;
    const surfaceZ = contactZ - thickness;
    setup.probeThickness = thickness;
    if (kind === "bed") {
      workspace.clear();
      setup.bedSurfaceMPos = surfaceZ;
      setup.bedProbeReady = true;
      setup.stockProbeReady = false;
      setup.probeReady = false;
      setup.probeLockStatus = "unlocked";
      setup.stockSurfaceMPos = null;
      setup.stockThicknessMm = null;
      setup.safetyFloorMm = null;
      setup.maxCutDepthMm = null;
      setup.zOriginMPos = null;
    } else {
      const protection = measuredStockProtection(setup.bedSurfaceMPos, surfaceZ);
      setup.stockSurfaceMPos = surfaceZ;
      setup.stockThicknessMm = protection.stockThicknessMm;
      setup.safetyFloorMm = protection.safetyFloorMm;
      setup.maxCutDepthMm = protection.maxCutDepthMm;
      setup.zOriginMPos = surfaceZ;
      setup.stockProbeReady = true;
      setup.probeReady = true;
      setup.probeLockStatus = "ready_to_lock";
    }
    setup.updatedAt = new Date().toISOString(); lastControllerStatus = result.after;
    rebuildWorkspaceFromSetup();
    persistLockedXy(result.after);
    return { ...result, setup: { ...setup } };
  } catch (error) { incident = error?.message || "PROBE_FAILED"; throw error; } finally { moving = false; }
};
const lockProbeCalibration = async () => {
  if (moving || ["running", "paused"].includes(job.state)) throw new Error("A CNC operation is already active");
  if (!setup.bedProbeReady || !setup.stockProbeReady || !setup.probeReady) throw new Error("Probe both the bed and stock before locking calibration");
  await motionGuard();
  const status = await assertIdle();
  setup.probeLocked = true;
  setup.probeLockStatus = "locked";
  setup.probeLockedAt = new Date().toISOString();
  setup.updatedAt = setup.probeLockedAt;
  const lock = persistLockedProbe(status);
  return { ok: true, setup: { ...setup }, lock: { lockedAt: lock.lockedAt, lastKnownMPos: lock.lastKnownMPos } };
};
const unlockProbeCalibration = async (payload) => {
  if (payload.confirm !== true) throw new Error("Explicit unlock confirmation is required");
  if (moving || ["running", "paused"].includes(job.state)) throw new Error("A CNC operation is already active");
  await assertIdle();
  removeProbeLock(PROBE_STATE_PATH);
  clearProbeSetup();
  workspace.clear();
  return { ok: true, setup: { ...setup } };
};
const startProgram = async ({ jobId, gcode, stockWidthMm, stockHeightMm, stockReserveMm }) => {
  if (moving || ["running", "paused"].includes(job.state)) throw new Error("A CNC operation is already active");
  moving = true; incident = undefined; Object.assign(job, { state: "running", jobId: String(jobId || ""), progress: 0, message: "Preflight checks", updatedAt: new Date().toISOString() });
  try { const result = await controller.runProgram(gcode, { programContext: { stockWidthMm, stockHeightMm, stockReserveMm }, onProgress: async (p) => Object.assign(job, { progress: p.progress, message: `Line ${p.line} of ${p.total}`, updatedAt: new Date().toISOString() }) }); lastControllerStatus = result.after; persistLockedXy(result.after); persistLockedProbe(result.after); Object.assign(job, { state: "done", progress: 100, message: "Carve complete", updatedAt: new Date().toISOString() }); return result; }
  catch (error) { incident = error?.message || "PROGRAM_FAILED"; Object.assign(job, { state: "error", message: incident, updatedAt: new Date().toISOString() }); throw error; } finally { moving = false; }
};
const bodyJson = async (req) => { let body = "", size = 0; for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY_BYTES) throw new Error("Request too large"); body += chunk; } return body ? JSON.parse(body) : {}; };

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") return json(res, 200, await health());
    if (req.method === "POST" && req.url === "/observe") return json(res, 200, await observe());
    if (req.method === "POST" && req.url === "/query") { const { command } = await bodyJson(req); return json(res, 200, { command, lines: await controller.query(command) }); }
    if (req.method === "POST" && /^\/jog\/[xyz]$/.test(req.url)) return json(res, 200, await jog(req.url.at(-1).toUpperCase(), await bodyJson(req)));
    if (req.method === "POST" && req.url === "/workspace/set") { removeXyLock(XY_STATE_PATH); setup.xyReady = false; setup.xyLockStatus = "unlocked"; setup.xyLockedAt = null; setup.xyOriginMPos = null; setup.updatedAt = new Date().toISOString(); return json(res, 200, workspace.setBounds(await bodyJson(req))); }
    if (req.method === "POST" && req.url === "/zero/xy") return json(res, 200, await setXyZero());
    if (req.method === "POST" && req.url === "/probe/bed") return json(res, 200, await probeSurface("bed", await bodyJson(req)));
    if (req.method === "POST" && req.url === "/probe/stock") return json(res, 200, await probeSurface("stock", await bodyJson(req)));
    if (req.method === "POST" && req.url === "/probe/lock") return json(res, 200, await lockProbeCalibration());
    if (req.method === "POST" && req.url === "/probe/unlock") return json(res, 200, await unlockProbeCalibration(await bodyJson(req)));
    if (req.method === "POST" && req.url === "/probe/recover") return json(res, 200, await controller.recoverProbeContact(await bodyJson(req)));
    if (req.method === "POST" && req.url === "/job/start") return json(res, 200, await startProgram(await bodyJson(req)));
    if (req.method === "POST" && req.url === "/job/pause") { controller.pauseProgramNow(); Object.assign(job, { state: "paused", message: "Paused", updatedAt: new Date().toISOString() }); return json(res, 200, { ok: true, job: { ...job } }); }
    if (req.method === "POST" && req.url === "/job/resume") { controller.resumeProgramNow(); Object.assign(job, { state: "running", message: "Running", updatedAt: new Date().toISOString() }); return json(res, 200, { ok: true, job: { ...job } }); }
    if (req.method === "POST" && req.url === "/job/stop") { await controller.stopProgramNow(); Object.assign(job, { state: "stopped", message: "Stopped", updatedAt: new Date().toISOString() }); return json(res, 200, { ok: true, job: { ...job } }); }
    if (req.method === "POST" && req.url === "/spindle/test") return json(res, 200, await spindleTest());
    if (req.method === "POST" && req.url === "/spindle/stop") { const lines = await controller.spindleOff(); lastControllerStatus = await readStatus(); return json(res, 200, { lines, status: lastControllerStatus }); }
    if (req.method === "POST" && req.url === "/controller/acknowledge-power-on") {
      const payload = await bodyJson(req);
      if (payload.powerCycleConfirmed !== true) throw new Error("Power-cycle confirmation is required");
      if (hazardousOperationActive()) throw new Error("A CNC operation is already active");
      const result = await controller.acknowledgePowerOnDoor();
      lastControllerStatus = result.after;
      await restoreHardLimitsOnStartup(result.after);
      incident = undefined;
      return json(res, 200, result);
    }
    return json(res, 404, { ok: false, error: "Not found" });
  } catch (error) { return json(res, 500, { ok: false, error: error?.message || "Error" }); }
});

const restoreHardLimitsOnStartup = async (knownStatus) => {
  try {
    const state = knownStatus?.state || (await readStatus()).state;
    if (new Set(["Door", "Hold"]).has(String(state).split(":")[0])) return { skipped: true, state };
    const lines = await controller.query("$$");
    if (lines.some((line) => /^\$21=0(?:\s|$)/.test(line))) await controller.setBooleanSetting(21, true);
    return { skipped: false, state };
  } catch (error) {
    incident = `STARTUP_SAFETY_CHECK_FAILED:${error?.message || "unknown"}`;
  }
};

const keepalive = setInterval(async () => { if (moving || keepaliveBusy || !controller.connected) return; keepaliveBusy = true; try { await readStatus(); } catch (error) { incident = `KEEPALIVE_FAILED:${error?.message || "unknown"}`; workspace.clear(); clearSetup(); } finally { keepaliveBusy = false; } }, 1500);
keepalive.unref();
if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH);
server.listen(SOCKET_PATH, () => { chmodSync(SOCKET_PATH, 0o600); process.stdout.write(JSON.stringify({ event: "CNC_DAEMON_READY", socket: SOCKET_PATH, host: HOST, port: PORT }) + "\n"); });
void recoverIdleConnection();
const shutdown = async () => { clearInterval(keepalive); workspace.clear(); clearSetup(); if (moving) await controller.emergencyStop("DAEMON_SHUTDOWN_DURING_MOTION").catch(() => {}); await controller.close(); server.close(() => { try { if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH); } catch {} process.exit(0); }); };
process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);
