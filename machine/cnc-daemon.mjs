import http from "node:http";
import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { GrblTcpController, coordinates, parseStatus, VirtualWorkspace } from "./cnc-controller.mjs";
import { measuredStockProtection, validateProgramEnvelope } from "./cnc-program.mjs";
import { cameraBridgeFresh } from "./cnc-camera-diagnostics.mjs";

const HOST = process.env.CNC_HOST || "192.168.1.183";
const PORT = Number(process.env.CNC_PORT || 10086);
const CAMERA = process.env.CNC_CAMERA_BRIDGE || "http://127.0.0.1:47831";
const SOCKET_PATH = process.env.CNC_DAEMON_SOCKET || "/tmp/openclaw-cnc.sock";
const CAMERA_MAX_AGE_MS = 3000;
const CAMERA_REQUIRED = /^(1|true|yes)$/i.test(process.env.CNC_CAMERA_REQUIRED || "1");
const MAX_BODY_BYTES = 900_000;
let controller, lastControllerStatus, incident, moving = false, keepaliveBusy = false;
let restartScheduled = false;
const workspace = new VirtualWorkspace();
const setup = { xyReady: false, bedProbeReady: false, stockProbeReady: false, probeReady: false, probeThickness: null, bedSurfaceMPos: null, stockSurfaceMPos: null, stockThicknessMm: null, safetyFloorMm: null, maxCutDepthMm: null, xyOriginMPos: null, zOriginMPos: null, updatedAt: null };
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

const programGuard = async ({ analysis }) => {
  const snap = workspace.snapshot();
  if (!snap.calibrated) throw new Error("Virtual boundaries are not calibrated");
  if (!setup.xyReady) throw new Error("Set X/Y zero before starting");
  if (!setup.bedProbeReady || !setup.stockProbeReady || !setup.probeReady) throw new Error("Probe the bed and stock before starting");
  if (!Number.isFinite(setup.maxCutDepthMm) || setup.maxCutDepthMm <= 0) throw new Error("Measured stock depth is unavailable");
  validateProgramEnvelope(analysis, { widthMm: 360, heightMm: 360, maxDepthMm: setup.maxCutDepthMm, maxSafeZMm: 6 });
  const origins = { X: setup.xyOriginMPos?.X, Y: setup.xyOriginMPos?.Y, Z: setup.zOriginMPos };
  for (const axis of ["X", "Y", "Z"]) {
    if (!Number.isFinite(origins[axis])) throw new Error(`${axis} work origin is unavailable`);
    const low = origins[axis] + analysis.bounds[axis].min, high = origins[axis] + analysis.bounds[axis].max, allowed = snap.bounds[axis];
    if (low < allowed.min - 0.001 || high > allowed.max + 0.001) throw new Error(`${axis} program envelope ${low.toFixed(3)}..${high.toFixed(3)} exceeds virtual boundary ${allowed.min.toFixed(3)}..${allowed.max.toFixed(3)}`);
  }
};

controller = new GrblTcpController({ host: HOST, port: PORT, statusTimeoutMs: 600, commandTimeoutMs: 15_000, motionGuard, workspaceGuard: (request) => workspace.assertJog(request), programGuard, maxJogMm: 25, maxJogFeed: 500, maxSessionTravelMm: 2000, maxSpindleTestRpm: 2000 });
controller.on("programProgress", (value) => Object.assign(job, { progress: value.progress, message: `Line ${value.line} of ${value.total}`, updatedAt: new Date().toISOString() }));
const clearSetup = () => Object.assign(setup, { xyReady: false, bedProbeReady: false, stockProbeReady: false, probeReady: false, probeThickness: null, bedSurfaceMPos: null, stockSurfaceMPos: null, stockThicknessMm: null, safetyFloorMm: null, maxCutDepthMm: null, xyOriginMPos: null, zOriginMPos: null, updatedAt: new Date().toISOString() });
const scheduleRestart = () => { if (restartScheduled) return; restartScheduled = true; setTimeout(() => process.exit(1), 750).unref(); };
controller.on("fault", (error) => { incident = error?.message || "CONTROLLER_FAULT"; workspace.clear(); clearSetup(); scheduleRestart(); });
controller.on("close", () => { if (moving || ["running", "paused"].includes(job.state)) incident = "CONTROLLER_CONNECTION_LOST"; workspace.clear(); clearSetup(); if (incident) scheduleRestart(); });

const readStatus = async () => (lastControllerStatus = parseStatus(await controller.status({ attempts: 5 })));
const health = async () => {
  if (!controller.connected && !moving && !incident) { try { await readStatus(); } catch (error) { incident = `CONNECT_FAILED:${error.message}`; } }
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
    const manualPositioning = Boolean(payload.manualPositioning);
    const calibration = manualPositioning && !workspace.snapshot().calibrated;
    const result = await controller.jog(axis, payload.distanceMm, payload.feedMmPerMin, { calibration });
    lastControllerStatus = result.after;
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
  const p=setup.xyOriginMPos, prior=workspace.snapshot().bounds;
  const zBounds=setup.probeReady&&Number.isFinite(setup.zOriginMPos)&&Number.isFinite(setup.maxCutDepthMm)
    ?{min:setup.zOriginMPos-setup.maxCutDepthMm,max:setup.zOriginMPos+6}
    :(prior?.Z||{min:p.Z-68,max:p.Z+6});
  workspace.setBounds({ X:{min:p.X,max:p.X+360}, Y:{min:p.Y,max:p.Y+360}, Z:zBounds });
  return { setup: { ...setup }, status: before };
};
const probeSurface = async (kind, payload) => {
  if (moving || ["running", "paused"].includes(job.state)) throw new Error("A CNC operation is already active");
  if (!new Set(["bed", "stock"]).has(kind)) throw new Error("Unknown probe surface");
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
    }
    setup.updatedAt = new Date().toISOString(); lastControllerStatus = result.after;
    if (setup.xyReady) {
      const p=setup.xyOriginMPos||coordinates(result.after), prior=workspace.snapshot().bounds;
      const zOrigin = Number.isFinite(setup.zOriginMPos) ? setup.zOriginMPos : surfaceZ;
      const zDepth = Number.isFinite(setup.maxCutDepthMm) ? setup.maxCutDepthMm : 5;
      workspace.setBounds({ X:prior?.X||{min:p.X,max:p.X+360}, Y:prior?.Y||{min:p.Y,max:p.Y+360}, Z:{min:zOrigin-zDepth,max:zOrigin+6} });
    }
    return { ...result, setup: { ...setup } };
  } catch (error) { incident = error?.message || "PROBE_FAILED"; throw error; } finally { moving = false; }
};
const startProgram = async ({ jobId, gcode }) => {
  if (moving || ["running", "paused"].includes(job.state)) throw new Error("A CNC operation is already active");
  moving = true; incident = undefined; Object.assign(job, { state: "running", jobId: String(jobId || ""), progress: 0, message: "Preflight checks", updatedAt: new Date().toISOString() });
  try { const result = await controller.runProgram(gcode, { onProgress: async (p) => Object.assign(job, { progress: p.progress, message: `Line ${p.line} of ${p.total}`, updatedAt: new Date().toISOString() }) }); lastControllerStatus = result.after; Object.assign(job, { state: "done", progress: 100, message: "Carve complete", updatedAt: new Date().toISOString() }); return result; }
  catch (error) { incident = error?.message || "PROGRAM_FAILED"; Object.assign(job, { state: "error", message: incident, updatedAt: new Date().toISOString() }); throw error; } finally { moving = false; }
};
const bodyJson = async (req) => { let body = "", size = 0; for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY_BYTES) throw new Error("Request too large"); body += chunk; } return body ? JSON.parse(body) : {}; };

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") return json(res, 200, await health());
    if (req.method === "POST" && req.url === "/observe") return json(res, 200, await observe());
    if (req.method === "POST" && req.url === "/query") { const { command } = await bodyJson(req); return json(res, 200, { command, lines: await controller.query(command) }); }
    if (req.method === "POST" && /^\/jog\/[xyz]$/.test(req.url)) return json(res, 200, await jog(req.url.at(-1).toUpperCase(), await bodyJson(req)));
    if (req.method === "POST" && req.url === "/workspace/set") { clearSetup(); return json(res, 200, workspace.setBounds(await bodyJson(req))); }
    if (req.method === "POST" && req.url === "/zero/xy") return json(res, 200, await setXyZero());
    if (req.method === "POST" && req.url === "/probe/bed") return json(res, 200, await probeSurface("bed", await bodyJson(req)));
    if (req.method === "POST" && req.url === "/probe/stock") return json(res, 200, await probeSurface("stock", await bodyJson(req)));
    if (req.method === "POST" && req.url === "/probe/recover") return json(res, 200, await controller.recoverProbeContact(await bodyJson(req)));
    if (req.method === "POST" && req.url === "/job/start") return json(res, 200, await startProgram(await bodyJson(req)));
    if (req.method === "POST" && req.url === "/job/pause") { controller.pauseProgramNow(); Object.assign(job, { state: "paused", message: "Paused", updatedAt: new Date().toISOString() }); return json(res, 200, { ok: true, job: { ...job } }); }
    if (req.method === "POST" && req.url === "/job/resume") { controller.resumeProgramNow(); Object.assign(job, { state: "running", message: "Running", updatedAt: new Date().toISOString() }); return json(res, 200, { ok: true, job: { ...job } }); }
    if (req.method === "POST" && req.url === "/job/stop") { await controller.stopProgramNow(); Object.assign(job, { state: "stopped", message: "Stopped", updatedAt: new Date().toISOString() }); return json(res, 200, { ok: true, job: { ...job } }); }
    if (req.method === "POST" && req.url === "/spindle/test") return json(res, 200, await spindleTest());
    if (req.method === "POST" && req.url === "/spindle/stop") { const lines = await controller.spindleOff(); lastControllerStatus = await readStatus(); return json(res, 200, { lines, status: lastControllerStatus }); }
    return json(res, 404, { ok: false, error: "Not found" });
  } catch (error) { return json(res, 500, { ok: false, error: error?.message || "Error" }); }
});

const restoreHardLimitsOnStartup = async () => {
  try {
    const lines = await controller.query("$$");
    if (lines.some((line) => /^\$21=0(?:\s|$)/.test(line))) await controller.setBooleanSetting(21, true);
  } catch (error) {
    incident = `STARTUP_SAFETY_CHECK_FAILED:${error?.message || "unknown"}`;
  }
};

const keepalive = setInterval(async () => { if (moving || keepaliveBusy || !controller.connected) return; keepaliveBusy = true; try { await readStatus(); } catch (error) { incident = `KEEPALIVE_FAILED:${error?.message || "unknown"}`; workspace.clear(); clearSetup(); } finally { keepaliveBusy = false; } }, 1500);
keepalive.unref();
await restoreHardLimitsOnStartup();
if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH);
server.listen(SOCKET_PATH, () => { chmodSync(SOCKET_PATH, 0o600); process.stdout.write(JSON.stringify({ event: "CNC_DAEMON_READY", socket: SOCKET_PATH, host: HOST, port: PORT }) + "\n"); });
const shutdown = async () => { clearInterval(keepalive); workspace.clear(); clearSetup(); if (moving) await controller.emergencyStop("DAEMON_SHUTDOWN_DURING_MOTION").catch(() => {}); await controller.close(); server.close(() => { try { if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH); } catch {} process.exit(0); }); };
process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);
