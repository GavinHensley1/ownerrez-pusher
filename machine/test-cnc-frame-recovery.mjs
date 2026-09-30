import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";
import { inspectSavedFrame } from "./cnc-frame-recovery.mjs";
import { writeFrameIncident } from "./cnc-frame-incident.mjs";

const xy = { version: 1, locked: true, xyOriginMPos: { X: -75, Y: -49 }, lastKnownMPos: { X: 10, Y: 90 }, lockedAt: "2026-09-29T12:00:00Z" };
const probe = { version: 1, locked: true, probeThickness: 20, bedSurfaceMPos: -49, stockSurfaceMPos: -45, stockThicknessMm: 4, safetyFloorMm: .8, maxCutDepthMm: 3.2, zOriginMPos: -45, lastKnownMPos: { X: 10, Y: 90, Z: 5 }, lockedAt: "2026-09-29T12:00:00Z" };
const offset = { X: -75, Y: -49, Z: -45 };
test("frame check distinguishes unchanged coordinates, persisted offsets after reset, and independent Z change", () => {
  const check = MPos => inspectSavedFrame({ status: { MPos }, workOffset: offset, xyLock: xy, probeLock: probe });
  assert.deepEqual([check("10,90,5").xy, check("10,90,5").z], [true, true]);
  assert.deepEqual([check("0,0,0").xy, check("0,0,0").z], [false, false]);
  assert.deepEqual([check("10,90,0").xy, check("10,90,0").z], [true, false]);
});

const request = (socketPath, path, payload) => new Promise((resolve, reject) => {
  const data = payload === undefined ? "" : JSON.stringify(payload);
  const req = http.request({ socketPath, path, method: payload === undefined ? "GET" : "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) } }, res => {
    let text = ""; res.on("data", chunk => text += chunk); res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
  });
  req.on("error", reject); req.end(data);
});
async function fixture(t, initialPosition, initialState = "Idle", { latched = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "cnc-reconnect-test-")), socketPath = join(dir, "cnc.sock"), wire = [];
  let position = initialPosition, state = initialState, jogPolls = 0, g54 = [-75, -49, -45];
  const server = net.createServer(socket => {
    let buffer = "";
    socket.on("data", chunk => { for (const byte of chunk) {
      const char = String.fromCharCode(byte);
      if (char === "?") { wire.push("?"); socket.write(`<${jogPolls-- > 0 ? "Jog" : state}|MPos:${position}|FS:0,0>\r\n`); continue; }
      if (byte < 32 && char !== "\r" && char !== "\n") { wire.push(`byte:${byte}`); continue; }
      if (char === "~" || char === "!") { wire.push(char); continue; }
      buffer += char;
      if (char !== "\r") continue;
      const command = buffer.trim(); buffer = ""; wire.push(command);
      if (command === "$#") socket.write(`[G54:${g54.join(",")}]\r\nok\r\n`);
      else if (command.startsWith("G10 L20 P1")) { const p = position.split(",").map(Number); for (const match of command.matchAll(/([XYZ])(-?[\d.]+)/g)) { const i = "XYZ".indexOf(match[1]); g54[i] = p[i] - Number(match[2]); } socket.write("ok\r\n"); }
      else if (command === "$$") socket.write("$21=1\r\nok\r\n");
      else if (command === "$X") { state = "Idle"; socket.write("ok\r\n"); }
      else if (command.startsWith("$J=")) { const p = position.split(",").map(Number), m = command.match(/([XYZ])(-?[\d.]+) F/); p["XYZ".indexOf(m[1])] += Number(m[2]); position = p.join(","); jogPolls = 1; socket.write("ok\r\n"); }
      else socket.write("ok\r\n");
    }});
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const env = { ...process.env, CNC_HOST: "127.0.0.1", CNC_PORT: String(server.address().port), CNC_DAEMON_SOCKET: socketPath, CNC_LOCAL_UI_PORT: "0" };
  for (const key of ["PROBE_STATE", "MATERIAL_STATE", "XY_STATE", "PROGRAM_STATE", "RUN_STATE", "EVENT_JOURNAL", "FRAME_INCIDENT"]) env[`CNC_${key}`] = join(dir, key + ".json");
  writeFileSync(env.CNC_XY_STATE, JSON.stringify(xy)); writeFileSync(env.CNC_PROBE_STATE, JSON.stringify(probe));
  if (latched) writeFrameIncident(env.CNC_FRAME_INCIDENT, { reason: "Wi-Fi timeout", duringMotion: true });
  const child = spawn(process.execPath, [new URL("./cnc-daemon.mjs", import.meta.url).pathname], { env, stdio: ["ignore", "ignore", "pipe"] });
  let errors = ""; child.stderr.on("data", chunk => errors += chunk);
  t.after(async () => { const exited = new Promise(resolve => child.once("exit", resolve)); child.kill("SIGTERM"); await exited; await new Promise(resolve => server.close(resolve)); });
  const deadline = Date.now() + 5000; while (!existsSync(socketPath) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert(existsSync(socketPath), errors);
  return { request: (path, payload) => request(socketPath, path, payload), wire, env, getPosition: () => position };
}

test("visible reconnect restores unchanged saved coordinates with read-only commands and never resumes a program", async t => {
  const f = await fixture(t, "10,90,5");
  assert.equal((await f.request("/job/resume", {})).status, 500);
  const reconnected = await f.request("/controller/reconnect-verify", {});
  assert.equal(reconnected.status, 200, JSON.stringify(reconnected));
  const h = (await f.request("/health")).body;
  assert.equal(h.frameValid, true); assert.equal(h.setup.xyReady, true); assert.equal(h.setup.probeLocked, true);
  assert.deepEqual([h.setup.xyOriginMPos.X, h.setup.xyOriginMPos.Y, h.setup.zOriginMPos], [-75, -49, -45]);
  assert.equal(h.setup.probeLockedAt, probe.lockedAt); // reconnect must not fake a new bit touch
  assert(f.wire.every(command => command === "?" || command === "$#"), JSON.stringify(f.wire));
  assert.equal((await f.request("/job/resume", {})).status, 500);
  assert.equal(JSON.parse(readFileSync(f.env.CNC_FRAME_INCIDENT)).latched, false);
});

test("actual reset retains saved files, offers origin recovery and small manual moves, but never cutting", async t => {
  const f = await fixture(t, "0,0,0");
  const savedXy = readFileSync(f.env.CNC_XY_STATE, "utf8"), savedProbe = readFileSync(f.env.CNC_PROBE_STATE, "utf8");
  assert.equal((await f.request("/controller/reconnect-verify", {})).status, 200);
  const h = (await f.request("/health")).body;
  assert.equal(h.frameValid, false); assert.equal(h.frameRecovery.active, true);
  assert.equal(h.setup.xyReady, false); assert.equal(h.setup.probeLocked, false); assert.equal(h.xyRecovery.available, true);
  assert.equal(readFileSync(f.env.CNC_XY_STATE, "utf8"), savedXy); assert.equal(readFileSync(f.env.CNC_PROBE_STATE, "utf8"), savedProbe);
  for (const path of ["/job/start", "/job/resume", "/job/resume-saved", "/spindle/test"]) assert.equal((await f.request(path, {})).status, 500, path);
  assert.equal((await f.request("/jog/z", { distanceMm: 6, feedMmPerMin: 100, manualPositioning: true })).status, 500);
  const jog = await f.request("/jog/z", { distanceMm: 1, feedMmPerMin: 100, manualPositioning: true });
  assert.equal(jog.status, 200, JSON.stringify(jog)); assert.equal(f.getPosition(), "0,0,1");
  assert(!f.wire.includes("~")); assert(!f.wire.includes("byte:24"));
});

test("a held unknown buffer is observed without cycle-start, soft reset, or enabling setup", async t => {
  const f = await fixture(t, "10,90,5", "Hold:0");
  assert.equal((await f.request("/controller/reconnect-verify", {})).status, 200);
  const h = (await f.request("/health")).body;
  assert.equal(h.frameValid, false); assert.equal(h.frameRecovery.active, false);
  assert.equal((await f.request("/jog/z", { distanceMm: 1, feedMmPerMin: 100, manualPositioning: true })).status, 500);
  assert(f.wire.every(command => command === "?"));
  assert.match(h.frameRecovery.message, /power the controller OFF then ON/);
});

test("startup rejects stale Z even without a previous incident while retaining verified X/Y", async t => {
  const f = await fixture(t, "10,90,1", "Idle", { latched: false });
  const deadline = Date.now() + 4000;
  let h;
  do { h = (await f.request("/health")).body; if (h.frameRecovery?.active) break; await new Promise(resolve => setTimeout(resolve, 20)); } while (Date.now() < deadline);
  assert.equal(h.setup.xyReady, true); assert.equal(h.setup.probeLocked, false); assert.equal(h.frameValid, false);
  assert(!f.wire.some(line => line.startsWith("G10")));
});

test("XY-only reset preserves independently verified Z and provides saved XY recovery", async t => {
  const f = await fixture(t, "0,0,5");
  await f.request("/controller/reconnect-verify", {});
  const h = (await f.request("/health")).body;
  assert.equal(h.setup.xyReady, false); assert.equal(h.setup.probeLocked, true); assert.equal(h.xyRecovery.available, true);
  assert.equal(h.setup.zOriginMPos, -45); assert.equal(h.frameValid, false);
  assert(!f.wire.some(command => command.startsWith("G10")));
  assert.equal((await f.request("/zero/xy/restore-after-power-cycle", {})).status, 500);
  assert.equal((await f.request("/zero/xy/restore-after-power-cycle", { confirmGantryUnmoved: true })).status, 200);
  const restored = (await f.request("/health")).body;
  assert.equal(restored.frameValid, true); assert.equal(restored.setup.probeLocked, true);
  assert.equal(restored.setup.zOriginMPos, -45); assert.equal(restored.setup.probeLockedAt, probe.lockedAt);
  assert.equal(f.getPosition(), "0,0,5");
});

test("Alarm recovery is explicit, verifies coordinates and never releases a held buffer", async t => {
  const f = await fixture(t, "10,90,5", "Alarm");
  await f.request("/controller/reconnect-verify", {});
  assert.equal((await f.request("/controller/recover-stopped", {})).status, 500);
  assert.equal((await f.request("/controller/recover-stopped", { confirm: true })).status, 200);
  const h = (await f.request("/health")).body;
  assert.equal(h.frameValid, true); assert.equal(h.setup.xyReady, true); assert.equal(h.setup.probeLocked, true);
  assert(f.wire.includes("$X")); assert(!f.wire.includes("~")); assert(!f.wire.includes("byte:24"));
});

test("verification serializes against a concurrent manual move", async t => {
  const f = await fixture(t, "10,90,5");
  const reconnect = f.request("/controller/reconnect-verify", {});
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal((await f.request("/jog/z", { distanceMm: 1, feedMmPerMin: 100, manualPositioning: true })).status, 500);
  assert.equal((await reconnect).status, 200);
  assert(!f.wire.some(command => command.startsWith("$J=")));
});

test("visible disconnected-state recovery button dispatches read-only reconnect, not resume", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const extract = name => { const start = html.indexOf(`function ${name}(`), end = html.indexOf("\nfunction ", start + 1); return html.slice(start, end); };
  const ids = ["cncPositioningState", "cncPositioningTitle", "cncPositioningDetail", "cncControllerRecoverBtn"];
  const nodes = Object.fromEntries(ids.map(id => [id, { dataset: {}, disabled: true, textContent: "" }]));
  const calls = [], context = vm.createContext({ document: { getElementById: id => nodes[id] }, CNC: { agent: {} }, CNC_COMMAND_IN_FLIGHT: false, cncMachineAction: (...args) => calls.push(args) });
  vm.runInContext(extract("cncControllerState") + "\n" + extract("cncRenderPositioning"), context);
  context.cncRenderPositioning({ connected: false, frameValid: false }, true);
  assert.equal(nodes.cncControllerRecoverBtn.disabled, false);
  assert.match(nodes.cncPositioningDetail.textContent, /Saved zeros and probes are retained/);
  nodes.cncControllerRecoverBtn.onclick(); assert.equal(calls[0][0], "reconnect_verify");
  context.cncRenderPositioning({ connected: true, frameValid: false, frameRecovery: { active: true, message: "Saved X/Y verified; touch off Z" }, lastControllerStatus: { state: "Idle", FS: "0,0" } }, false);
  assert.match(nodes.cncPositioningTitle.textContent, /Setup controls available/);
});
