import http from "node:http";
import { execFileSync } from "node:child_process";
import { splitJogDistance } from "./cnc-jog.mjs";

const PROJECT_URL = String(process.env.PROJECT_URL || "https://project-jvyw3.vercel.app").replace(/\/$/, "");
const SOCKET_PATH = process.env.CNC_DAEMON_SOCKET || "/tmp/openclaw-cnc.sock";
const ACTIVE_POLL_MS = Number(process.env.CNC_AGENT_ACTIVE_POLL_MS || 1500);
const IDLE_POLL_MS = Number(process.env.CNC_AGENT_IDLE_POLL_MS || 30000);
const ACTIVE_HEARTBEAT_MS = Number(process.env.CNC_AGENT_ACTIVE_HEARTBEAT_MS || 5000);
const IDLE_HEARTBEAT_MS = Number(process.env.CNC_AGENT_IDLE_HEARTBEAT_MS || 300000);
const KEYCHAIN_SERVICE = process.env.CNC_AGENT_KEYCHAIN_SERVICE || "openclaw-cnc-agent";
const token = process.env.CNC_AGENT_TOKEN || execFileSync("/usr/bin/security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
if (!token) throw new Error("CNC agent token is unavailable");

let stopped = false;
let activeStart;
const handled = new Set();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function localRequest(path, body = {}) {
  return new Promise((resolve, reject) => {
    const isHealth = path === "/health";
    const data = JSON.stringify(body);
    const req = http.request({
      socketPath: SOCKET_PATH,
      path,
      method: isHealth ? "GET" : "POST",
      headers: isHealth ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(data) },
    }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => {
        let parsed; try { parsed = text ? JSON.parse(text) : {}; } catch { return reject(new Error(`Local CNC returned invalid JSON (${res.statusCode})`)); }
        if ((res.statusCode || 500) >= 400 || parsed.ok === false) return reject(new Error(parsed.error || `Local CNC HTTP ${res.statusCode}: ${text.slice(0, 160)}`));
        resolve(parsed);
      });
    });
    req.setTimeout(path === "/job/start" ? 12 * 60 * 60 * 1000 : 30_000, () => req.destroy(new Error("Local CNC request timeout")));
    req.on("error", reject);
    if (!isHealth) req.write(data);
    req.end();
  });
}

async function cloud(method, payload) {
  const response = await fetch(`${PROJECT_URL}/api/app?action=cnc_agent`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "cache-control": "no-store" },
    body: method === "POST" ? JSON.stringify(payload || {}) : undefined,
    signal: AbortSignal.timeout(12_000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Cloud CNC HTTP ${response.status}`);
  return data;
}

async function heartbeat() {
  let health;
  try { health = await localRequest("/health"); }
  catch (error) { health = { ok: false, connected: false, error: error.message }; }
  // Project receives a strict machine-state allowlist. External supervision data
  // must never be persisted, polled, or used as a Project control interlock.
  const projectHealth = {
    ok: health?.ok === true,
    connected: health?.connected === true,
    moving: health?.moving === true,
    error: health?.error ? String(health.error).slice(0, 300) : "",
    incident: health?.incident ? String(health.incident).slice(0, 300) : "",
    lastControllerStatus: health?.lastControllerStatus || null,
    workspace: health?.workspace || null,
    setup: health?.setup || null,
    job: health?.job || null,
  };
  await cloud("POST", { type: "heartbeat", at: new Date().toISOString(), health: projectHealth });
  return health;
}

async function report(command, state, message, extra = {}) {
  await cloud("POST", { type: "command", commandId: command.id, action: command.action, jobId: command.jobId || "", state, message: String(message || "").slice(0, 500), ...extra });
}

async function execute(command) {
  const routes = { probe_bed: "/probe/bed", probe_stock: "/probe/stock", lock_probe: "/probe/lock", unlock_probe: "/probe/unlock", recover_probe: "/probe/recover", recover_controller: "/controller/recover-stopped", zero_xy: "/zero/xy", zero_z: "/zero/z", start: "/job/start", pause: "/job/pause", resume: "/job/resume", stop: "/job/stop" };
  const axis = String(command.axis || "").toUpperCase();
  const path = command.action === "jog" && new Set(["X", "Y", "Z"]).has(axis) ? `/jog/${axis.toLowerCase()}` : routes[command.action];
  if (!path) return report(command, "error", `Unsupported command: ${command.action}`);
  if (command.action === "start" && activeStart) return report(command, "error", "A carve is already running");
  await report(command, command.action === "start" ? "running" : "accepted", `${command.action} accepted`);
  const task = (async () => {
    try {
      let result;
      if (command.action === "jog") {
        const segments = splitJogDistance(axis, command.distanceMm);
        for (let index = 0; index < segments.length; index += 1) {
          await report(command, "accepted", `Moving ${axis} segment ${index + 1} of ${segments.length}`);
          result = await localRequest(path, { distanceMm: segments[index], feedMmPerMin: command.feedMmPerMin, manualPositioning: true });
        }
        result = { ...result, requestedDistanceMm: Number(command.distanceMm), completedSegments: segments.length };
      } else {
        const payload = (command.action === "probe_bed" || command.action === "probe_stock") ? { thicknessMm: command.probeThickness, confirmReprobe: command.confirmReprobe === true }
          : (command.action === "unlock_probe" || command.action === "zero_z" || command.action === "recover_controller") ? { confirm: command.confirm === true }
          : command.action === "start" ? { jobId: command.jobId, gcode: command.gcode, stockWidthMm: command.stockWidthMm, stockHeightMm: command.stockHeightMm, stockReserveMm: command.stockReserveMm } : {};
        result = await localRequest(path, payload);
      }
      const finalState = command.action === "start" ? "done" : command.action === "pause" ? "paused" : command.action === "resume" ? "running" : command.action === "stop" ? "stopped" : "ready";
      await report(command, finalState, command.action === "start" ? "Carve complete" : `${command.action} complete`, { result: { setup: result.setup, job: result.job } });
    } catch (error) {
      process.stderr.write(`command ${command.action} ${command.axis || ""} ${command.distanceMm ?? ""}: ${error.message}\n`);
      await report(command, "error", error.message);
    }
  })();
  if (command.action === "start") { activeStart = task; task.finally(() => { activeStart = undefined; }); }
  else await task;
}

async function loop() {
  let nextHeartbeat = 0;
  while (!stopped) {
    try {
      const active = Boolean(activeStart);
      if (Date.now() >= nextHeartbeat) {
        const health = await heartbeat();
        const running = active || ["running", "paused"].includes(String(health?.job?.state || ""));
        nextHeartbeat = Date.now() + (running ? ACTIVE_HEARTBEAT_MS : IDLE_HEARTBEAT_MS);
      }
      const data = await cloud("GET");
      const command = data.command;
      if (command?.id && !handled.has(command.id)) {
        handled.add(command.id);
        if (handled.size > 200) handled.delete(handled.values().next().value);
        execute(command).catch((error) => process.stderr.write(`command ${command.id}: ${error.message}\n`));
      }
    } catch (error) { process.stderr.write(`CNC agent: ${error.message}\n`); }
    await sleep(activeStart ? ACTIVE_POLL_MS : IDLE_POLL_MS);
  }
}

process.on("SIGINT", () => { stopped = true; });
process.on("SIGTERM", () => { stopped = true; });
process.stdout.write(JSON.stringify({ event: "CNC_CLOUD_AGENT_READY", project: PROJECT_URL, socket: SOCKET_PATH }) + "\n");
await loop();
