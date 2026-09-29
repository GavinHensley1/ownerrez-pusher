import http from "node:http";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { claimCommand, completeCommand } from "./cnc-command-ledger.mjs";
import { commandRejectionReason } from "./cnc-command-policy.mjs";
import { splitJogDistance } from "./cnc-jog.mjs";
import { decodeProgram } from "./cnc-program-codec.mjs";

const PROJECT_URL = String(process.env.PROJECT_URL || "https://project-jvyw3.vercel.app").replace(/\/$/, "");
const SOCKET_PATH = process.env.CNC_DAEMON_SOCKET || "/tmp/openclaw-cnc.sock";
const ACTIVE_POLL_MS = Number(process.env.CNC_AGENT_ACTIVE_POLL_MS || 1000);
const IDLE_POLL_MS = Number(process.env.CNC_AGENT_IDLE_POLL_MS || 1500);
const ACTIVE_HEARTBEAT_MS = Number(process.env.CNC_AGENT_ACTIVE_HEARTBEAT_MS || 5000);
const IDLE_HEARTBEAT_MS = Number(process.env.CNC_AGENT_IDLE_HEARTBEAT_MS || 60000);
const PROBE_LOCAL_TIMEOUT_MS = Number(process.env.CNC_AGENT_PROBE_TIMEOUT_MS || 180_000);
const KEYCHAIN_SERVICE = process.env.CNC_AGENT_KEYCHAIN_SERVICE || "openclaw-cnc-agent";
const COMMAND_LEDGER_PATH = process.env.CNC_COMMAND_LEDGER || join(homedir(), ".openclaw", "state", "cnc-command-ledger.json");
const token = process.env.CNC_AGENT_TOKEN || execFileSync("/usr/bin/security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
if (!token) throw new Error("CNC agent token is unavailable");

let stopped = false;
let activeStart;
const agentStartedAtMs = Date.now();
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
    const timeoutMs = new Set(["/job/start", "/job/resume-saved"]).has(path)
      ? 12 * 60 * 60 * 1000
      : new Set(["/probe/bed", "/probe/stock", "/probe/tool", "/probe/recover"]).has(path)
        ? PROBE_LOCAL_TIMEOUT_MS
        : 30_000;
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Local CNC request timeout after ${timeoutMs} ms`)));
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
  const localJob = health?.job && typeof health.job === "object" ? health.job : null;
  const projectJob = localJob ? {
    state: String(localJob.state || "").slice(0, 24),
    jobId: String(localJob.jobId || ""),
    progress: Math.max(0, Math.min(100, Number(localJob.progress) || 0)),
    message: String(localJob.message || "").slice(0, 300),
    updatedAt: String(localJob.updatedAt || ""),
  } : null;
  if (projectJob?.jobId) projectJob.jobId = String(projectJob.jobId).replace(/-resume-\d+$/, "");
  const projectHealth = {
    ok: health?.ok === true,
    connected: health?.connected === true,
    moving: health?.moving === true,
    error: health?.error ? String(health.error).slice(0, 300) : "",
    incident: health?.incident ? String(health.incident).slice(0, 300) : "",
    lastControllerStatus: health?.lastControllerStatus || null,
    workspace: health?.workspace || null,
    setup: health?.setup || null,
    xyRecovery: health?.xyRecovery || null,
    job: projectJob,
    resume: health?.resume || null,
  };
  await cloud("POST", { type: "heartbeat", at: new Date().toISOString(), health: projectHealth });
  return health;
}

async function report(command, state, message, extra = {}) {
  await cloud("POST", { type: "command", commandId: command.id, action: command.action, jobId: command.jobId || "", state, message: String(message || "").slice(0, 500), ...extra });
}

async function execute(command) {
  const routes = { probe_bed: "/probe/bed", probe_stock: "/probe/stock", probe_tool: "/probe/tool", lock_probe: "/probe/lock", unlock_probe: "/probe/unlock", recover_probe: "/probe/recover", recover_controller: "/controller/recover-stopped", restore_xy: "/zero/xy/restore-after-power-cycle", zero_xy: "/zero/xy", zero_z: "/zero/z", start: "/job/start", resume_saved: "/job/resume-saved", pause: "/job/pause", resume: "/job/resume", stop: "/job/stop" };
  const axis = String(command.axis || "").toUpperCase();
  const path = command.action === "jog" && new Set(["X", "Y", "Z"]).has(axis) ? `/jog/${axis.toLowerCase()}` : routes[command.action];
  if (!path) return report(command, "error", `Unsupported command: ${command.action}`);
  const programAction = new Set(["start", "resume_saved"]).has(command.action);
  const claim = claimCommand(COMMAND_LEDGER_PATH, command);
  if (!claim.claimed) {
    if (claim.terminal) return report(command, claim.entry.status, claim.entry.message || `${command.action} already completed`, { terminal: true });
    const message = "Bridge restarted while this command outcome was unknown. It was not repeated. Reconcile the controller state before issuing another command.";
    const uncertain = completeCommand(COMMAND_LEDGER_PATH, command.id, "uncertain", message);
    return report(command, uncertain.status, uncertain.message, { terminal: true });
  }
  const rejection = commandRejectionReason(command, {
    agentStartedAtMs,
    activeProgram: Boolean(activeStart),
  });
  if (rejection) {
    const rejected = completeCommand(COMMAND_LEDGER_PATH, command.id, "error", rejection);
    return report(command, rejected.status, rejected.message, { terminal: true });
  }
  await report(command, programAction ? "running" : "accepted", `${command.action} accepted`);
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
        const payload = new Set(["probe_bed", "probe_stock", "probe_tool"]).has(command.action) ? { thicknessMm: command.probeThickness, maxSearchMm: command.maxSearchMm, confirmReprobe: command.confirmReprobe === true }
          : command.action === "restore_xy" ? { confirmGantryUnmoved: command.confirmGantryUnmoved === true }
          : command.action === "zero_xy" ? { confirmNewProject: command.confirmNewProject === true }
          : (command.action === "unlock_probe" || command.action === "zero_z" || command.action === "recover_controller") ? { confirm: command.confirm === true }
          : command.action === "resume_saved" ? { confirm: command.confirm === true, allowReposition: command.allowReposition === true }
          : command.action === "start" ? { jobId: command.jobId, gcode: decodeProgram(command), stockWidthMm: command.stockWidthMm, stockHeightMm: command.stockHeightMm, stockReserveMm: command.stockReserveMm, manualRouter: command.manualRouter === true } : {};
        result = await localRequest(path, payload);
      }
      const finalState = programAction ? "done" : command.action === "pause" ? "paused" : command.action === "resume" ? "running" : command.action === "stop" ? "stopped" : "ready";
      const ledgerState = new Set(["done", "stopped", "ready"]).has(finalState) ? finalState : "ready";
      const message = programAction ? "Carve complete" : `${command.action} complete`;
      completeCommand(COMMAND_LEDGER_PATH, command.id, ledgerState, message);
      await report(command, finalState, message, { terminal: true, result: { setup: result.setup, job: result.job } });
      try { await heartbeat(); }
      catch (heartbeatError) { process.stderr.write(`post-command heartbeat: ${heartbeatError.message}\n`); }
    } catch (error) {
      process.stderr.write(`command ${command.action} ${command.axis || ""} ${command.distanceMm ?? ""}: ${error.message}\n`);
      completeCommand(COMMAND_LEDGER_PATH, command.id, "error", error.message);
      await report(command, "error", error.message, { terminal: true });
    }
  })();
  if (programAction) { activeStart = task; task.finally(() => { activeStart = undefined; }); }
  else await task;
}

async function loop() {
  let nextHeartbeat = 0;
  let failureCount = 0;
  let lastError = { message: "", at: 0 };
  while (!stopped) {
    let loopFailed = false;
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
        execute(command).catch((error) => { handled.delete(command.id); process.stderr.write(`command ${command.id}: ${error.message}\n`); });
      }
      failureCount = 0;
    } catch (error) {
      loopFailed = true;
      failureCount += 1;
      const message = String(error?.message || "unknown");
      if (lastError.message !== message || Date.now() - lastError.at >= 60_000) {
        process.stderr.write(`CNC agent: ${message}; retry ${failureCount}\n`);
        lastError = { message, at: Date.now() };
      }
    }
    const base = activeStart ? ACTIVE_POLL_MS : IDLE_POLL_MS;
    await sleep(loopFailed ? Math.min(60_000, base * (2 ** Math.min(failureCount, 6))) : base);
  }
}

process.on("SIGINT", () => { stopped = true; });
process.on("SIGTERM", () => { stopped = true; });
process.stdout.write(JSON.stringify({ event: "CNC_CLOUD_AGENT_READY", project: PROJECT_URL, socket: SOCKET_PATH }) + "\n");
await loop();
