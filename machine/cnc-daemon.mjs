import http from "node:http";
import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { GrblTcpController, coordinates, parseStatus, parseWorkOffset, VirtualWorkspace } from "./cnc-controller.mjs";
import { limitVerticalPlungeFeed, validateProgramEnvelope, validateProgramStockEnvelope } from "./cnc-program.mjs";
import { applyProbeLock, assertLockedProbeZJog, calibrationFromSetup, readProbeLock, removeProbeLock, writeProbeLock } from "./cnc-probe-state.mjs";
import { applyMaterialProfile, materialProfileFromSetup, readMaterialProfile, removeMaterialProfile, writeMaterialProfile } from "./cnc-material-state.mjs";
import { applyXyLock, planXyPowerCycleRecovery, readXyLock, removeXyLock, writeXyLock, xyLockFromSetup } from "./cnc-xy-state.mjs";
import { readProgram, saveProgram } from "./cnc-program-state.mjs";
import { buildBufferedStopResume, buildResumeProgram, programPositionAtLine } from "./cnc-resume.mjs";
import { readRunCheckpoint, writeRunCheckpoint } from "./cnc-run-state.mjs";
import { completeStockProbe, completeToolTouch } from "./cnc-setup-flow.mjs";
import { appendCncEvent } from "./cnc-event-journal.mjs";

const HOST = process.env.CNC_HOST || "192.168.1.183";
const PORT = Number(process.env.CNC_PORT || 10086);
const SOCKET_PATH = process.env.CNC_DAEMON_SOCKET || "/tmp/openclaw-cnc.sock";
const LOCAL_UI_PORT = Number(process.env.CNC_LOCAL_UI_PORT || 47832);
const PROBE_STATE_PATH = process.env.CNC_PROBE_STATE || join(homedir(), ".openclaw", "state", "cnc-probe-calibration.json");
const MATERIAL_STATE_PATH = process.env.CNC_MATERIAL_STATE || join(homedir(), ".openclaw", "state", "cnc-material-profile.json");
const XY_STATE_PATH = process.env.CNC_XY_STATE || join(homedir(), ".openclaw", "state", "cnc-xy-origin.json");
const PROGRAM_STATE_PATH = process.env.CNC_PROGRAM_STATE || join(homedir(), ".openclaw", "state", "cnc-last-program.json");
const RUN_STATE_PATH = process.env.CNC_RUN_STATE || join(homedir(), ".openclaw", "state", "cnc-run-checkpoint.json");
const EVENT_JOURNAL_PATH = process.env.CNC_EVENT_JOURNAL || join(homedir(), ".openclaw", "state", "cnc-events.jsonl");
const STATUS_TIMEOUT_MS = Number(process.env.CNC_STATUS_TIMEOUT_MS || 1500);
const MAX_BODY_BYTES = 900_000;
// High-resolution Finish programs are transported as decoded G-code over the
// loopback-only Unix socket. Keep ordinary control requests tightly bounded,
// but allow machine-program endpoints to receive the generated payload.
const MAX_PROGRAM_BODY_BYTES = 10_000_000;
let controller, lastControllerStatus, lastWorkOffset, incident, moving = false, keepaliveBusy = false;
let reconnectPromise;
let nextReconnectAt = 0;
const RECONNECT_BACKOFF_MS = 10_000;
const workspace = new VirtualWorkspace();
const setup = { xyReady: false, xyLockStatus: "unlocked", xyLockedAt: null, bedProbeReady: false, stockProbeReady: false, probeReady: false, probeLocked: false, probeLockStatus: "unlocked", probeLockedAt: null, probeThickness: null, probePhase: "idle", probeTravelledMm: 0, probeSearchLimitMm: null, bedSurfaceMPos: null, stockSurfaceMPos: null, stockThicknessMm: null, safetyFloorMm: null, maxCutDepthMm: null, materialReady: false, savedStockThicknessMm: null, savedSafetyFloorMm: null, xyOriginMPos: null, zOriginMPos: null, updatedAt: null };
try { const material = readMaterialProfile(MATERIAL_STATE_PATH); if (material) applyMaterialProfile(setup, material); } catch (error) { process.stderr.write(`[cnc] ignored invalid material profile: ${error.message}\n`); }
const job = { state: "idle", jobId: null, progress: 0, message: "", updatedAt: null };
let activeRunCheckpoint;
try { activeRunCheckpoint = readRunCheckpoint(RUN_STATE_PATH); } catch { activeRunCheckpoint = undefined; }

const json = (res, status, value) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(value)); };
const recordEvent = (type, detail = {}) => { try { appendCncEvent(EVENT_JOURNAL_PATH, type, detail); } catch (error) { logConnectionEvent?.(`journal:${error.message}`, `[cnc] event journal: ${error.message}`); } };
const motionGuard = async () => ({ state: "controller_and_software_guards" });

const programGuard = async ({ before, analysis, programContext }) => {
  const snap = workspace.snapshot();
  if (!snap.calibrated) throw new Error("Virtual boundaries are not calibrated");
  if (!setup.xyReady) throw new Error("Set X/Y zero before starting");
  if (!setup.bedProbeReady || !setup.stockProbeReady || !setup.probeReady) throw new Error("Probe the bed and stock before starting");
  if (!setup.probeLocked) throw new Error("Lock the probe calibration before starting");
  if (!Number.isFinite(setup.maxCutDepthMm) || setup.maxCutDepthMm <= 0) throw new Error("Measured stock depth is unavailable");
  validateProgramEnvelope(analysis, { widthMm: 360, heightMm: 360, maxDepthMm: setup.maxCutDepthMm, maxSafeZMm: 6 });
  validateProgramStockEnvelope(analysis, { widthMm: programContext?.stockWidthMm, heightMm: programContext?.stockHeightMm, reserveMm: programContext?.stockReserveMm });
  const current = coordinates(before);
  for (const axis of ["X", "Y", "Z"]) {
    const allowed = snap.bounds[axis];
    const aboveFiniteMaximum = axis !== "Z" && Number.isFinite(allowed.max) && current[axis] > allowed.max + 0.001;
    if (current[axis] < allowed.min - 0.001 || aboveFiniteMaximum) {
      const allowedText = axis === "Z" ? `${allowed.min.toFixed(3)} or higher` : `${allowed.min.toFixed(3)}..${allowed.max.toFixed(3)}`;
      throw new Error(`Current ${axis} position ${current[axis].toFixed(3)} is outside the calibrated controller frame ${allowedText}; reset coordinates before starting`);
    }
  }
  const origins = { X: setup.xyOriginMPos?.X, Y: setup.xyOriginMPos?.Y, Z: setup.zOriginMPos };
  for (const axis of ["X", "Y", "Z"]) {
    if (!Number.isFinite(origins[axis])) throw new Error(`${axis} work origin is unavailable`);
    const low = origins[axis] + analysis.bounds[axis].min, high = origins[axis] + analysis.bounds[axis].max, allowed = snap.bounds[axis];
    const aboveFiniteMaximum = axis !== "Z" && Number.isFinite(allowed.max) && high > allowed.max + 0.001;
    if (low < allowed.min - 0.001 || aboveFiniteMaximum) {
      const allowedText = axis === "Z" ? `${allowed.min.toFixed(3)} or higher` : `${allowed.min.toFixed(3)}..${allowed.max.toFixed(3)}`;
      throw new Error(`${axis} program envelope ${low.toFixed(3)}..${high.toFixed(3)} exceeds virtual boundary ${allowedText}`);
    }
  }
};

controller = new GrblTcpController({ host: HOST, port: PORT, statusTimeoutMs: STATUS_TIMEOUT_MS, commandTimeoutMs: 20_000, motionGuard, workspaceGuard: (request) => workspace.assertJog(request), programGuard, maxJogMm: 25, maxJogFeed: 500, maxSessionTravelMm: 2000, maxSpindleTestRpm: 2000 });
const persistRunProgress = (patch) => {
  if (!activeRunCheckpoint) return null;
  activeRunCheckpoint = writeRunCheckpoint(RUN_STATE_PATH, { ...activeRunCheckpoint, ...patch, updatedAt: new Date().toISOString() });
  return activeRunCheckpoint;
};
controller.on("programProgress", (value) => {
  Object.assign(job, { progress: value.progress, message: `Line ${value.line} of ${value.total}`, updatedAt: new Date().toISOString() });
  persistRunProgress({ state: "running", lastCompletedLine: value.line, totalLines: value.total, message: job.message });
});
controller.on("probeProgress", (value) => {
  Object.assign(setup, {
    probePhase: String(value?.phase || "idle"),
    probeTravelledMm: Number(value?.travelledMm) || 0,
    probeSearchLimitMm: Number.isFinite(Number(value?.limitMm)) ? Number(value.limitMm) : null,
    updatedAt: new Date().toISOString(),
  });
});
const clearSetup = () => Object.assign(setup, { xyReady: false, xyLockStatus: "unlocked", xyLockedAt: null, bedProbeReady: false, stockProbeReady: false, probeReady: false, probeLocked: false, probeLockStatus: "unlocked", probeLockedAt: null, probeThickness: null, probePhase: "idle", probeTravelledMm: 0, probeSearchLimitMm: null, bedSurfaceMPos: null, stockSurfaceMPos: null, stockThicknessMm: null, safetyFloorMm: null, maxCutDepthMm: null, materialReady: false, savedStockThicknessMm: null, savedSafetyFloorMm: null, xyOriginMPos: null, zOriginMPos: null, updatedAt: new Date().toISOString() });
const clearProbeSetup = (status = "unlocked_reprobe_required") => Object.assign(setup, { bedProbeReady: false, stockProbeReady: false, probeReady: false, probeLocked: false, probeLockStatus: status, probeLockedAt: null, probeThickness: null, probePhase: "idle", probeTravelledMm: 0, probeSearchLimitMm: null, bedSurfaceMPos: null, stockSurfaceMPos: null, stockThicknessMm: null, safetyFloorMm: null, maxCutDepthMm: null, zOriginMPos: null, updatedAt: new Date().toISOString() });
const rebuildWorkspaceFromSetup = () => {
  if (!setup.xyReady || !setup.probeReady || !Number.isFinite(setup.xyOriginMPos?.X) || !Number.isFinite(setup.xyOriginMPos?.Y) || !Number.isFinite(setup.zOriginMPos) || !Number.isFinite(setup.maxCutDepthMm)) { workspace.clear(); return null; }
  return workspace.setBounds({ X: { min: setup.xyOriginMPos.X, max: setup.xyOriginMPos.X + 360 }, Y: { min: setup.xyOriginMPos.Y, max: setup.xyOriginMPos.Y + 360 }, Z: { min: setup.zOriginMPos - setup.maxCutDepthMm, max: null } });
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
const restoreOrRebaseLockedXy = async (status, workOffset) => {
  const continuous = restoreLockedXy(status, workOffset);
  if (continuous) return { mode: "continuous", lock: continuous };
  const raw = readXyLock(XY_STATE_PATH);
  if (!raw || status?.state !== "Idle") return null;
  try {
    const plan = planXyPowerCycleRecovery(raw, status, workOffset);
    await controller.setWorkOffset({ x: plan.savedWorkPosition.X, y: plan.savedWorkPosition.Y });
    const verifiedOffset = parseWorkOffset(await controller.query("$#"));
    lastWorkOffset = verifiedOffset;
    for (const axis of ["X", "Y"]) {
      if (Math.abs(verifiedOffset[axis] - plan.rebasedOriginMPos[axis]) > 0.05) throw new Error(`Automatic ${axis} origin verification failed: expected ${plan.rebasedOriginMPos[axis]}, got ${verifiedOffset[axis]}`);
    }
    Object.assign(setup, {
      xyReady: true,
      xyLockStatus: "auto_restored_after_power_cycle",
      xyLockedAt: raw.lockedAt,
      xyOriginMPos: { X: verifiedOffset.X, Y: verifiedOffset.Y, Z: coordinates(status).Z },
      updatedAt: new Date().toISOString(),
    });
    removeProbeLock(PROBE_STATE_PATH);
    clearProbeSetup("power_cycle_reprobe_required");
    const lock = persistLockedXy(status);
    setup.xyLockStatus = "auto_restored_after_power_cycle";
    return { mode: "rebased_after_power_cycle", plan, lock, workOffset: verifiedOffset };
  } catch (error) {
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
  if (!String(setup.probeLockStatus || "").startsWith("locked_after_")) setup.probeLockStatus = "locked";
  setup.probeLockedAt = lock.lockedAt;
  return lock;
};
const persistMaterialProfile = () => {
  const profile = materialProfileFromSetup(setup);
  writeMaterialProfile(MATERIAL_STATE_PATH, profile);
  applyMaterialProfile(setup, profile);
  return profile;
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
let lastConnectionLog = { key: "", at: 0 };
const logConnectionEvent = (key, message) => {
  const now = Date.now();
  if (lastConnectionLog.key !== key || now - lastConnectionLog.at >= 60_000) {
    process.stderr.write(`${message}\n`);
    lastConnectionLog = { key, at: now };
  }
};
controller.on("fault", (error) => {
  const hazardous = hazardousOperationActive();
  incident = error?.message || "CONTROLLER_FAULT";
  logConnectionEvent(`fault:${incident}`, `[cnc] controller fault hazardous=${hazardous}: ${incident}`);
  recordEvent("controller.fault", { hazardous, incident, jobId: job.jobId, jobState: job.state });
  if (["running", "paused"].includes(job.state)) {
    Object.assign(job, { state: "interrupted", message: incident, updatedAt: new Date().toISOString() });
    persistRunProgress({ state: "interrupted", message: incident });
  }
});
controller.on("close", () => {
  const hazardous = hazardousOperationActive();
  if (hazardous) incident = "CONTROLLER_CONNECTION_LOST";
  logConnectionEvent(`close:${hazardous}`, `[cnc] controller close hazardous=${hazardous}`);
  recordEvent("controller.close", { hazardous, incident, jobId: job.jobId, jobState: job.state });
  if (["running", "paused"].includes(job.state)) {
    Object.assign(job, { state: "interrupted", message: incident || "Controller connection lost", updatedAt: new Date().toISOString() });
    persistRunProgress({ state: "interrupted", message: job.message });
  }
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
    lastWorkOffset = workOffset;
    await restoreOrRebaseLockedXy(startupStatus, workOffset);
    restoreLockedProbe(startupStatus, workOffset);
    rebuildWorkspaceFromSetup();
    incident = undefined;
  })().catch((error) => {
    incident = `CONNECT_FAILED:${error?.message || "unknown"}`;
  }).finally(() => { reconnectPromise = undefined; });
  return reconnectPromise;
};
const xyRecoverySnapshot = () => {
  try {
    const lock = readXyLock(XY_STATE_PATH);
    if (!lock || setup.xyReady || lastControllerStatus?.state !== "Idle" || !lastWorkOffset) return { available: false };
    const plan = planXyPowerCycleRecovery(lock, lastControllerStatus, lastWorkOffset);
    return { available: true, savedWorkPosition: plan.savedWorkPosition, rebasedOriginMPos: plan.rebasedOriginMPos, lockedAt: plan.lock.lockedAt };
  } catch (error) { return { available: false, reason: error?.message || "X/Y recovery unavailable" }; }
};
const health = () => {
  if (!controller.connected && !hazardousOperationActive()) void recoverIdleConnection();
  return { ok: true, connected: controller.connected, reconnecting: Boolean(reconnectPromise), moving, incident, lastControllerStatus, workspace: workspace.snapshot(), setup: { ...setup }, xyRecovery: controller.connected ? xyRecoverySnapshot() : { available: false }, job: { ...job }, resume: activeRunCheckpoint ? { ...activeRunCheckpoint } : null };
};
const observe = async () => ({ cnc: await readStatus() });
const assertIdle = async () => { const status = await readStatus(); if (new Set(["Door:0", "Hold:0"]).has(status.state)) throw new Error(`Controller positioning is paused in ${status.state}. The external router may be removed; use Enable positioning first.`); if (status.state !== "Idle") throw new Error(`Controller must report Idle before positioning, got ${status.state}`); const [feed, spindle] = String(status.FS || "0,0").split(",").map(Number); if (feed || spindle) throw new Error(`Commanded feed/spindle must be zero, got ${status.FS}`); return status; };

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
    const safeRetract = manualPositioning && axis === "Z" && distance > 0;
    const negativeWorkspaceMarginMm = manualPositioning && new Set(["X", "Y"]).has(axis) ? 60 : 0;
    const result = await controller.jog(axis, payload.distanceMm, payload.feedMmPerMin, { calibration, safeRetract, negativeWorkspaceMarginMm });
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
const setXyZero = async (payload) => {
  if (payload.confirmNewProject !== true) throw new Error("Explicit new-project X/Y reset confirmation is required");
  if (moving || ["running", "paused"].includes(job.state)) throw new Error("A CNC operation is already active");
  await motionGuard(); const before = await assertIdle(); await controller.setWorkOffset({ x: 0, y: 0 });
  removeProbeLock(PROBE_STATE_PATH);
  removeMaterialProfile(MATERIAL_STATE_PATH);
  clearProbeSetup("new_project_reprobe_required");
  Object.assign(setup, { materialReady: false, savedStockThicknessMm: null, savedSafetyFloorMm: null });
  setup.xyOriginMPos = coordinates(before); setup.xyReady = true; setup.updatedAt = new Date().toISOString();
  setup.xyLockStatus = "locked";
  persistLockedXy(before);
  rebuildWorkspaceFromSetup();
  return { setup: { ...setup }, status: before };
};
const restoreXyAfterPowerCycle = async (payload) => {
  if (payload.confirmGantryUnmoved !== true) throw new Error("Confirm the gantry was not moved while controller power was off");
  if (moving || ["running", "paused"].includes(job.state)) throw new Error("A CNC operation is already active");
  await motionGuard();
  const before = await assertIdle(), workOffsetBefore = parseWorkOffset(await controller.query("$#")), raw = readXyLock(XY_STATE_PATH);
  lastWorkOffset = workOffsetBefore;
  if (!raw) throw new Error("No saved X/Y stock origin is available");
  const plan = planXyPowerCycleRecovery(raw, before, workOffsetBefore);
  await controller.setWorkOffset({ x: plan.savedWorkPosition.X, y: plan.savedWorkPosition.Y });
  const workOffset = parseWorkOffset(await controller.query("$#"));
  lastWorkOffset = workOffset;
  for (const axis of ["X", "Y"]) {
    if (Math.abs(workOffset[axis] - plan.rebasedOriginMPos[axis]) > 0.05) throw new Error(`Restored ${axis} origin verification failed: expected ${plan.rebasedOriginMPos[axis]}, got ${workOffset[axis]}`);
  }
  removeProbeLock(PROBE_STATE_PATH);
  clearProbeSetup("power_cycle_reprobe_required");
  setup.xyReady = true;
  setup.xyLockStatus = "restored_after_power_cycle";
  setup.xyLockedAt = raw.lockedAt;
  setup.xyOriginMPos = { X: workOffset.X, Y: workOffset.Y, Z: coordinates(before).Z };
  setup.updatedAt = new Date().toISOString();
  const lock = persistLockedXy(before);
  rebuildWorkspaceFromSetup();
  lastControllerStatus = await readStatus();
  return { ok: true, status: lastControllerStatus, setup: { ...setup }, restoredWorkPosition: plan.savedWorkPosition, lock: { lockedAt: lock.lockedAt, lastKnownMPos: lock.lastKnownMPos } };
};
const setStockZZero = async (payload) => {
  if (payload.confirm !== true) throw new Error("Explicit stock Z-zero confirmation is required");
  if (moving || ["running", "paused"].includes(job.state)) throw new Error("A CNC operation is already active");
  if (!setup.probeLocked || !setup.stockProbeReady || !Number.isFinite(setup.stockThicknessMm)) throw new Error("Lock a measured stock calibration before setting physical stock Z zero");
  await motionGuard();
  const before = await assertIdle(), position = coordinates(before), stockThicknessMm = Number(setup.stockThicknessMm);
  await controller.setWorkOffset({ z: 0 });
  const workOffset = parseWorkOffset(await controller.query("$#"));
  lastWorkOffset = workOffset;
  if (Math.abs(workOffset.Z - position.Z) > 0.05) throw new Error(`Stock Z-zero verification failed: expected ${position.Z}, got ${workOffset.Z}`);
  setup.stockSurfaceMPos = position.Z;
  setup.bedSurfaceMPos = position.Z - stockThicknessMm;
  setup.zOriginMPos = position.Z;
  setup.probeLockStatus = "locked_touch_off";
  setup.probeLockedAt = new Date().toISOString();
  setup.updatedAt = setup.probeLockedAt;
  persistLockedProbe(before);
  persistLockedXy(before);
  rebuildWorkspaceFromSetup();
  lastControllerStatus = await readStatus();
  return { ok: true, setup: { ...setup }, status: lastControllerStatus, workOffset };
};
const probeSurface = async (kind, payload) => {
  if (moving || ["running", "paused"].includes(job.state)) throw new Error("A CNC operation is already active");
  if (!new Set(["bed", "stock", "tool"]).has(kind)) throw new Error("Unknown probe surface");
  let materialProfile;
  if (kind === "bed") {
    if (setup.probeLocked && payload.confirmReprobe !== true) throw new Error("Probe calibration is locked; confirm a bed re-probe to replace it");
    removeProbeLock(PROBE_STATE_PATH);
    removeMaterialProfile(MATERIAL_STATE_PATH);
    clearProbeSetup("reprobe_in_progress");
    Object.assign(setup, { materialReady: false, savedStockThicknessMm: null, savedSafetyFloorMm: null });
    workspace.clear();
  }
  if (kind === "stock" && !setup.bedProbeReady) throw new Error("Probe the exposed bed before probing the stock");
  if (kind === "tool") {
    materialProfile = readMaterialProfile(MATERIAL_STATE_PATH);
    if (!materialProfile) throw new Error("Complete one bed + stock setup before touching off a changed bit");
    removeProbeLock(PROBE_STATE_PATH);
    clearProbeSetup("tool_touch_in_progress");
    applyMaterialProfile(setup, materialProfile);
    workspace.clear();
  }
  moving = true; incident = undefined;
  recordEvent("probe.started", { kind, maxSearchMm: payload.maxSearchMm, materialReady: setup.materialReady });
  try {
    await motionGuard();
    const result = await controller.probeZ({
      thicknessMm: payload.thicknessMm,
      maxSearchMm: payload.maxSearchMm,
    });
    const thickness = Number(result.thicknessMm);
    const contactZ = coordinates(result.finalContact).Z;
    const surfaceZ = contactZ - thickness;
    lastWorkOffset = { ...(lastWorkOffset || {}), Z: surfaceZ };
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
    } else if (kind === "stock") {
      completeStockProbe(setup, surfaceZ);
    } else {
      completeToolTouch(setup, surfaceZ, materialProfile);
    }
    setup.updatedAt = new Date().toISOString(); lastControllerStatus = result.after;
    if (kind === "stock") persistMaterialProfile();
    if (kind !== "bed") persistLockedProbe(result.after);
    rebuildWorkspaceFromSetup();
    persistLockedXy(result.after);
    recordEvent("probe.completed", { kind, searchedMm: result.searchedMm, stockThicknessMm: setup.stockThicknessMm, maxCutDepthMm: setup.maxCutDepthMm, lockStatus: setup.probeLockStatus });
    return { ...result, setup: { ...setup } };
  } catch (error) { incident = error?.message || "PROBE_FAILED"; setup.probePhase = error?.code === "PROBE_SEARCH_EXHAUSTED" ? "returned_no_contact" : "error"; setup.updatedAt = new Date().toISOString(); recordEvent("probe.failed", { kind, code: error?.code, message: incident, travelledMm: setup.probeTravelledMm, limitMm: setup.probeSearchLimitMm }); throw error; } finally { moving = false; }
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
  persistMaterialProfile();
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
const startProgram = async ({ jobId, gcode, stockWidthMm, stockHeightMm, stockReserveMm, manualRouter = false }) => {
  if (moving || ["running", "paused"].includes(job.state)) throw new Error("A CNC operation is already active");
  const savedProgram = saveProgram(PROGRAM_STATE_PATH, { version: 1, jobId, gcode, capturedAt: new Date().toISOString(), state: "accepted", context: { stockWidthMm, stockHeightMm, stockReserveMm, manualRouter: manualRouter === true } });
  activeRunCheckpoint = writeRunCheckpoint(RUN_STATE_PATH, { version: 1, jobId: savedProgram.jobId, programCapturedAt: savedProgram.capturedAt, state: "running", lastCompletedLine: 0, totalLines: savedProgram.analysis.executableLines, message: "Preflight checks", updatedAt: new Date().toISOString() });
  moving = true; incident = undefined; Object.assign(job, { state: "running", jobId: String(jobId || ""), progress: 0, message: "Preflight checks", updatedAt: new Date().toISOString() });
  recordEvent("program.started", { jobId, executableLines: savedProgram.analysis.executableLines, manualRouter: manualRouter === true });
  try { const conditionedGcode = limitVerticalPlungeFeed(savedProgram.gcode, 60); const result = await controller.runProgram(conditionedGcode, { programContext: savedProgram.context, onProgress: async (p) => Object.assign(job, { progress: p.progress, message: `Line ${p.line} of ${p.total}`, updatedAt: new Date().toISOString() }) }); lastControllerStatus = result.after; persistLockedXy(result.after); persistLockedProbe(result.after); Object.assign(job, { state: "done", progress: 100, message: "Carve complete", updatedAt: new Date().toISOString() }); persistRunProgress({ state: "done", lastCompletedLine: activeRunCheckpoint.totalLines, message: "Carve complete" }); recordEvent("program.completed", { jobId, totalLines: activeRunCheckpoint.totalLines }); return result; }
  catch (error) { incident = error?.message || "PROGRAM_FAILED"; Object.assign(job, { state: "error", message: incident, updatedAt: new Date().toISOString() }); persistRunProgress({ state: "interrupted", message: incident }); recordEvent("program.interrupted", { jobId, message: incident, lastCompletedLine: activeRunCheckpoint?.lastCompletedLine }); throw error; } finally { moving = false; }
};
const resumeSavedProgram = async (payload) => {
  if (payload.confirm !== true) throw new Error("Explicit resume confirmation is required");
  if (moving || ["running", "paused"].includes(job.state)) throw new Error("A CNC operation is already active");
  const saved = readProgram(PROGRAM_STATE_PATH);
  if (!saved) throw new Error("No locally saved carve is available");
  if (!saved.context.manualRouter) throw new Error("Automatic resume is currently limited to manual-router stages");
  const completedLine = Number(payload.completedLine ?? (activeRunCheckpoint?.programCapturedAt === saved.capturedAt ? activeRunCheckpoint.lastCompletedLine : NaN));
  const traced = programPositionAtLine(saved.gcode, completedLine, { spindleMode: "manual" });
  const status = await assertIdle(), machine = coordinates(status);
  const work = { X: machine.X - Number(setup.xyOriginMPos?.X), Y: machine.Y - Number(setup.xyOriginMPos?.Y), Z: machine.Z - Number(setup.zOriginMPos) };
  const exactPosition = ["X", "Y", "Z"].every((axis) => Number.isFinite(work[axis]) && Math.abs(work[axis] - traced.position[axis]) <= 0.05);
  if (!exactPosition && activeRunCheckpoint?.state !== "interrupted") {
    const axis = ["X", "Y", "Z"].find((name) => !Number.isFinite(work[name]) || Math.abs(work[name] - traced.position[name]) > 0.05);
    throw new Error(`Resume position mismatch on ${axis}: controller ${work[axis]?.toFixed?.(3)}, program ${traced.position[axis].toFixed(3)}`);
  }
  const resumed = exactPosition
    ? buildResumeProgram(saved.gcode, completedLine, { spindleMode: "manual" })
    : buildBufferedStopResume(saved.gcode, completedLine, work, { spindleMode: "manual" });
  if (payload.dryRun === true) return { ok: true, dryRun: true, controller: status, workPosition: work, expectedPosition: traced.position, resume: { ...resumed, gcode: undefined } };
  const result = await startProgram({ jobId: `${saved.jobId}-resume-${completedLine}`, gcode: resumed.gcode, ...saved.context });
  return { ...result, resume: resumed };
};
const recoverStoppedController = async (payload) => {
  if (payload.confirm !== true) throw new Error("Explicit stopped-controller recovery confirmation is required");
  if (hazardousOperationActive()) throw new Error("A CNC operation is already active");
  await controller.resetConnection();
  const result = await controller.recoverStoppedController();
  lastControllerStatus = result.after;
  await restoreHardLimitsOnStartup(result.after);
  const workOffset = parseWorkOffset(await controller.query("$#"));
  lastWorkOffset = workOffset;
  await restoreOrRebaseLockedXy(result.after, workOffset);
  restoreLockedProbe(result.after, workOffset);
  rebuildWorkspaceFromSetup();
  incident = undefined;
  return { ok: true, result, workOffset, setup: { ...setup }, workspace: workspace.snapshot() };
};
const bodyJson = async (req, maxBytes = MAX_BODY_BYTES) => { let body = "", size = 0; for await (const chunk of req) { size += chunk.length; if (size > maxBytes) throw new Error("Request too large"); body += chunk; } return body ? JSON.parse(body) : {}; };

const localUi = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Project CNC · Local</title><style>body{font:16px system-ui;background:#111827;color:#eef2ff;max-width:820px;margin:30px auto;padding:16px}button{font:inherit;padding:12px 16px;margin:5px;border-radius:8px;border:1px solid #64748b;background:#1e293b;color:white}button.danger{background:#991b1b}pre{white-space:pre-wrap;background:#0b1220;padding:14px;border-radius:8px}</style><h1>Project CNC · Local recovery</h1><p>This console uses Project's local daemon and safety guards without the cloud queue.</p><div><button onclick="recover()">Enable positioning</button><button onclick="start()">Start saved carve</button><button onclick="cmd('/job/pause')">Pause</button><button onclick="cmd('/job/resume')">Resume</button><button class="danger" onclick="cmd('/job/stop')">Stop</button><button onclick="refresh()">Refresh</button></div><pre id="s">Loading…</pre><script>async function req(path,body){let r=await fetch(path,{method:body?'POST':'GET',headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined}),j=await r.json();if(!r.ok)throw Error(j.error||r.status);return j}async function refresh(){try{let h=await req('/health'),p=await req('/job/last');s.textContent=JSON.stringify({controller:h.lastControllerStatus,connected:h.connected,moving:h.moving,incident:h.incident,workspace:h.workspace,setup:h.setup,job:h.job,savedProgram:p.program},null,2)}catch(e){s.textContent='ERROR: '+e.message}}async function cmd(p,b={}){try{await req(p,b);await refresh()}catch(e){alert(e.message);await refresh()}}async function recover(){if(confirm('Enable positioning from a safe Hold:0/Door:0 state? The external router need not be installed and no axis moves during this step.'))await cmd('/controller/recover-stopped',{confirm:true})}async function start(){if(confirm('Start the locally saved carve from line 1 through Project guards?'))await cmd('/job/start-saved',{})}refresh();setInterval(refresh,2000)</script>`;
const requestHandler = async (req, res) => {
  try {
    if (req.method === "GET" && (req.url === "/" || req.url === "/ui")) { res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); return res.end(localUi); }
    if (req.method === "OPTIONS" && req.url === "/job/import") { const origin=String(req.headers.origin||""); if(origin!=="https://project-jvyw3.vercel.app") return json(res,403,{ok:false,error:"Origin denied"}); res.writeHead(204,{"access-control-allow-origin":origin,"access-control-allow-methods":"POST,OPTIONS","access-control-allow-headers":"content-type","access-control-allow-private-network":"true"}); return res.end(); }
    if (req.method === "POST" && req.url === "/job/import") { const origin=String(req.headers.origin||""); if(origin!=="https://project-jvyw3.vercel.app") return json(res,403,{ok:false,error:"Origin denied"}); const saved=saveProgram(PROGRAM_STATE_PATH,{version:1,...await bodyJson(req, MAX_PROGRAM_BODY_BYTES),capturedAt:new Date().toISOString(),state:"imported"}); res.writeHead(200,{"content-type":"application/json","cache-control":"no-store","access-control-allow-origin":origin}); return res.end(JSON.stringify({ok:true,program:{...saved,gcode:undefined}})); }
    if (req.method === "GET" && req.url === "/health") return json(res, 200, await health());
    if (req.method === "GET" && req.url === "/job/last") { const saved = readProgram(PROGRAM_STATE_PATH); return json(res, 200, { ok: true, program: saved ? { ...saved, gcode: undefined } : null }); }
    if (req.method === "POST" && req.url === "/job/start-saved") { const saved=readProgram(PROGRAM_STATE_PATH); if(!saved) throw new Error("No locally saved carve is available"); return json(res,200,await startProgram({jobId:saved.jobId,gcode:saved.gcode,...saved.context})); }
    if (req.method === "POST" && req.url === "/job/resume-saved") return json(res, 200, await resumeSavedProgram(await bodyJson(req)));
    if (req.method === "POST" && req.url === "/observe") return json(res, 200, await observe());
    if (req.method === "POST" && req.url === "/query") { const { command } = await bodyJson(req); return json(res, 200, { command, lines: await controller.query(command) }); }
    if (req.method === "POST" && /^\/jog\/[xyz]$/.test(req.url)) return json(res, 200, await jog(req.url.at(-1).toUpperCase(), await bodyJson(req)));
    if (req.method === "POST" && req.url === "/workspace/set") { removeXyLock(XY_STATE_PATH); setup.xyReady = false; setup.xyLockStatus = "unlocked"; setup.xyLockedAt = null; setup.xyOriginMPos = null; setup.updatedAt = new Date().toISOString(); return json(res, 200, workspace.setBounds(await bodyJson(req))); }
    if (req.method === "POST" && req.url === "/zero/xy") return json(res, 200, await setXyZero(await bodyJson(req)));
    if (req.method === "POST" && req.url === "/zero/xy/restore-after-power-cycle") return json(res, 200, await restoreXyAfterPowerCycle(await bodyJson(req)));
    if (req.method === "POST" && req.url === "/zero/z") return json(res, 200, await setStockZZero(await bodyJson(req)));
    if (req.method === "POST" && req.url === "/probe/bed") return json(res, 200, await probeSurface("bed", await bodyJson(req)));
    if (req.method === "POST" && req.url === "/probe/stock") return json(res, 200, await probeSurface("stock", await bodyJson(req)));
    if (req.method === "POST" && req.url === "/probe/tool") return json(res, 200, await probeSurface("tool", await bodyJson(req)));
    if (req.method === "POST" && req.url === "/probe/lock") return json(res, 200, await lockProbeCalibration());
    if (req.method === "POST" && req.url === "/probe/unlock") return json(res, 200, await unlockProbeCalibration(await bodyJson(req)));
    if (req.method === "POST" && req.url === "/probe/recover") return json(res, 200, await controller.recoverProbeContact(await bodyJson(req)));
    if (req.method === "POST" && req.url === "/job/start") return json(res, 200, await startProgram(await bodyJson(req, MAX_PROGRAM_BODY_BYTES)));
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
    if (req.method === "POST" && req.url === "/controller/recover-stopped") return json(res,200,await recoverStoppedController(await bodyJson(req)));
    return json(res, 404, { ok: false, error: "Not found" });
  } catch (error) { return json(res, 500, { ok: false, error: error?.message || "Error" }); }
};
const server = http.createServer(requestHandler);
const uiServer = http.createServer(requestHandler);

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

const keepalive = setInterval(async () => { if (moving || keepaliveBusy || !controller.connected) return; keepaliveBusy = true; try { await readStatus(); } catch (error) { incident = `KEEPALIVE_FAILED:${error?.message || "unknown"}`; logConnectionEvent(incident, `[cnc] ${incident}`); } finally { keepaliveBusy = false; } }, 1500);
keepalive.unref();
if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH);
server.listen(SOCKET_PATH, () => { chmodSync(SOCKET_PATH, 0o600); process.stdout.write(JSON.stringify({ event: "CNC_DAEMON_READY", socket: SOCKET_PATH, host: HOST, port: PORT }) + "\n"); });
uiServer.listen(LOCAL_UI_PORT, "127.0.0.1");
void recoverIdleConnection();
const shutdown = async () => { clearInterval(keepalive); workspace.clear(); clearSetup(); if (moving) await controller.emergencyStop("DAEMON_SHUTDOWN_DURING_MOTION").catch(() => {}); await controller.close(); uiServer.close(); server.close(() => { try { if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH); } catch {} process.exit(0); }); };
process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);
