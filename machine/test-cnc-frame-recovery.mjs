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
import { runJogSegments } from "./cnc-jog.mjs";
import { loadBrowserScript } from "./cnc-browser-harness.mjs";

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
async function fixture(t, initialPosition, initialState = "Idle", { latched = true, streaming = false, savedProgramForBounds = false, stoppedState = "Idle", probeRecord = probe, materialRecord = null, resetState = "Idle", resetPosition = null, resetDelayMs = 0, hardLimitsInitially = true, ignoreHardLimitWrite = false, omitZSteps = false, stepsZ = 800 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "cnc-reconnect-test-")), socketPath = join(dir, "cnc.sock"), wire = [];
  let position = initialPosition, state = initialState, jogPolls = 0, g54 = [-75, -49, -45], connections = 0, hardLimits = hardLimitsInitially;
  const server = net.createServer(socket => {
    connections++;
    let buffer = "";
    socket.on("data", chunk => { for (const byte of chunk) {
      const char = String.fromCharCode(byte);
      if (char === "?") { wire.push("?"); socket.write(`<${jogPolls-- > 0 ? "Jog" : state}|MPos:${position}|FS:0,0>\r\n`); continue; }
      if (byte === 0x18) { wire.push(`byte:${byte}`); buffer = ""; setTimeout(() => { state = resetState; if (resetPosition !== null) position = resetPosition; if (!socket.destroyed) socket.write("Grbl 1.1h ['$' for help]\r\n"); }, resetDelayMs); continue; }
      if (byte < 32 && char !== "\r" && char !== "\n") { wire.push(`byte:${byte}`); continue; }
      if (char === "~" || char === "!") { wire.push(char); if(char === "!" && streaming){state=stoppedState;if(stoppedState==="Idle")position="0,0,0";} continue; }
      buffer += char;
      if (char !== "\r") continue;
      const command = buffer.trim(); buffer = ""; wire.push(command);
      // GRBL's suspend loop only processes realtime bytes. A mock that answers
      // $N/$#/$$ while held would conceal an impossible recovery prerequisite.
      if (["Hold:0", "Door:0"].includes(state)) continue;
      if (command === "$#") socket.write(`[G54:${g54.join(",")}]\r\n[G92:0,0,0]\r\n[TLO:0]\r\nok\r\n`);
      else if (command === "$G") socket.write("[GC:G0 G54 G17 G21 G90 G94 G49 M5 M9 T0 F0 S0]\r\nok\r\n");
      else if (command.startsWith("G10 L20 P1")) { const p = position.split(",").map(Number); for (const match of command.matchAll(/([XYZ])(-?[\d.]+)/g)) { const i = "XYZ".indexOf(match[1]); g54[i] = p[i] - Number(match[2]); } socket.write("ok\r\n"); }
      else if (streaming && /^G1\b/.test(command)) { state="Run";setTimeout(()=>{if(!socket.destroyed)socket.write("ok\r\n");},500); }
      else if (command === "$$") socket.write(`$13=0\r\n$20=0\r\n$21=${hardLimits ? 1 : 0}\r\n$100=800.000\r\n$101=800.000\r\n${omitZSteps ? "" : `$102=${stepsZ}.000\r\n`}$130=400.000\r\n$131=400.000\r\n$132=80.000\r\nok\r\n`);
      else if (command === "$21=1") { if (!ignoreHardLimitWrite) hardLimits = true; socket.write("ok\r\n"); }
      else if (command === "$X") { state = "Idle"; socket.write("ok\r\n"); }
      else if (command.startsWith("$J=")) { const p = position.split(",").map(Number), m = command.match(/([XYZ])(-?[\d.]+) F/); p["XYZ".indexOf(m[1])] += Number(m[2]); position = p.join(","); jogPolls = 1; socket.write("ok\r\n"); }
      else socket.write("ok\r\n");
    }});
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const env = { ...process.env, CNC_HOST: "127.0.0.1", CNC_PORT: String(server.address().port), CNC_DAEMON_SOCKET: socketPath, CNC_LOCAL_UI_PORT: "0" };
  // PLATE_CONFIG must be included, otherwise the daemon under test reads the real
  // machine's plate file and these coordinate-recovery tests stop being isolated.
  for (const key of ["PROBE_STATE", "MATERIAL_STATE", "XY_STATE", "PROGRAM_STATE", "RUN_STATE", "EVENT_JOURNAL", "FRAME_INCIDENT", "PLATE_CONFIG", "CONTROLLER_SETTINGS"]) env[`CNC_${key}`] = join(dir, key + ".json");
  // These tests exercise coordinate continuity, not plate thickness, so the
  // configured plate deliberately matches the fixture's. Plate MISMATCH rejection is
  // covered separately in test-cnc-daemon-surface-proof.mjs.
  writeFileSync(env.CNC_PLATE_CONFIG, JSON.stringify({ version: 1, plateThicknessMm: probe.probeThickness, updatedAt: new Date().toISOString(), source: "test fixture", confirmedByOperator: true, measuredBy: "operator" }));
  if(streaming || savedProgramForBounds)writeFileSync(env.CNC_PROGRAM_STATE,JSON.stringify({version:1,jobId:"fake",context:{stockWidthMm:300,stockHeightMm:200,stockReserveMm:5,manualRouter:true},gcode:"G21\nG90\nG0 Z5\nG1 X85 Y139 Z-0.1 F50\nG0 Z5\nM30"}));
  if(stepsZ!==800)writeFileSync(env.CNC_CONTROLLER_SETTINGS,JSON.stringify({version:1,stepsPerMm:{X:800,Y:800,Z:800},capturedAt:new Date().toISOString(),source:"test baseline"}));
  writeFileSync(env.CNC_XY_STATE, JSON.stringify(xy)); writeFileSync(env.CNC_PROBE_STATE, JSON.stringify(probeRecord));
  if (materialRecord) writeFileSync(env.CNC_MATERIAL_STATE, JSON.stringify(materialRecord));
  if (latched) writeFrameIncident(env.CNC_FRAME_INCIDENT, { reason: "Wi-Fi timeout", duringMotion: true });
  const child = spawn(process.execPath, [new URL("./cnc-daemon.mjs", import.meta.url).pathname], { env, stdio: ["ignore", "ignore", "pipe"] });
  let errors = ""; child.stderr.on("data", chunk => errors += chunk);
  t.after(async () => { const exited = new Promise(resolve => child.once("exit", resolve)); child.kill("SIGTERM"); await exited; await new Promise(resolve => server.close(resolve)); });
  const deadline = Date.now() + 5000; while (!existsSync(socketPath) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert(existsSync(socketPath), errors);
  // Startup now performs the same read-only check automatically.
  let startup; const readyDeadline=Date.now()+5000;
  do { startup=(await request(socketPath,"/health")).body; if(!startup.moving)break;await new Promise(r=>setTimeout(r,20)); } while(Date.now()<readyDeadline);
  return { request: (path, payload) => request(socketPath, path, payload), wire, env, getPosition: () => position, getConnections: () => connections, hideZSteps: () => { omitZSteps = true; }, repairProtection: () => { hardLimits = true; omitZSteps = false; ignoreHardLimitWrite = false; stepsZ = 800; } };
}

// Reproduces the 2026-10-01 dead end exactly: a latched frame incident plus a
// deliberately invalidated Z calibration. readProbeLock used to THROW on that
// record, which aborted recovery before frameRecovery.active was set, so jog and
// probe stayed blocked, X/Y recovery was hidden, and the only way to clear the
// latch (probe, then lock) was itself forbidden by the latch. Start was
// unreachable with no operator action that could fix it.
const invalidatedProbe = {
  version: 1, locked: false, invalidated: true,
  invalidatedAt: "2026-10-01T12:31:00.000Z",
  invalidatedReason: "Captured with probeThickness=20mm against a ~14.19mm plate",
  probeThickness: null, bedSurfaceMPos: null, stockSurfaceMPos: null,
  stockThicknessMm: null, safetyFloorMm: 0.8, maxCutDepthMm: null, zOriginMPos: null, lastKnownMPos: null,
};

test("an invalidated Z calibration still lands in a usable setup state instead of a dead end", async t => {
  const f = await fixture(t, "10,90,5", "Idle", { probeRecord: invalidatedProbe });
  assert.equal((await f.request("/controller/reconnect-verify", {})).status, 200);
  const h = (await f.request("/health")).body;
  // The latch legitimately stands (Z is unverified) but recovery must be OPEN.
  assert.equal(h.frameValid, false);
  assert.equal(h.frameRecovery.active, true, `recovery must be reachable: ${JSON.stringify(h.frameRecovery)}`);
  assert.equal(h.setup.probeLocked, false);
  assert.match(h.frameRecovery.message, /invalidated/i);
  // No STOPPED_FRAME_CHECK_FAILED / "not a supported locked calibration" throw.
  assert.doesNotMatch(String(h.incident || ""), /not a supported locked calibration/);
  // The operator can actually move, which is what the dead end prevented.
  const jog = await f.request("/jog/z", { distanceMm: 1, feedMmPerMin: 100, manualPositioning: true });
  assert.equal(jog.status, 200, JSON.stringify(jog));
  // Cutting still refuses: degrade to setup, never to an unguarded Start.
  for (const path of ["/job/start", "/job/resume", "/job/resume-saved"]) assert.equal((await f.request(path, {})).status, 500, path);
});

test("a material profile captured before its calibration was invalidated is rejected, not reported ready", async t => {
  const f = await fixture(t, "10,90,5", "Idle", {
    probeRecord: invalidatedProbe,
    // Exactly the live file: measured 2026-09-30, i.e. BEFORE the invalidation.
    materialRecord: { version: 1, stockThicknessMm: 3.855, safetyFloorMm: 0.8, maxCutDepthMm: 3.055, capturedAt: "2026-09-30T19:07:23.768Z", source: "Project measured bed and stock" },
  });
  assert.equal((await f.request("/controller/reconnect-verify", {})).status, 200);
  const h = (await f.request("/health")).body;
  assert.equal(h.setup.materialReady, false, "a profile from an invalidated Z reference must not claim ready");
  assert.equal(h.setup.savedStockThicknessMm, null);
  assert.equal(h.setup.maxCutDepthMm, null);
});

test("a corrupt calibration that still claims locked:true is surfaced but never strands the operator", async t => {
  const f = await fixture(t, "10,90,5", "Idle", { probeRecord: { ...probe, maxCutDepthMm: 999 } });
  assert.equal((await f.request("/controller/reconnect-verify", {})).status, 200);
  const h = (await f.request("/health")).body;
  assert.equal(h.frameRecovery.active, true);
  assert.match(h.frameRecovery.message, /Could not reuse/);
  assert.equal(h.setup.probeLocked, false);
});

test("visible reconnect restores unchanged saved coordinates with read-only commands and never resumes a program", async t => {
  const f = await fixture(t, "10,90,5");
  assert.equal((await f.request("/job/resume", {})).status, 500);
  const reconnected = await f.request("/controller/reconnect-verify", {});
  assert.equal(reconnected.status, 200, JSON.stringify(reconnected));
  const h = (await f.request("/health")).body;
  assert.equal(h.frameValid, true); assert.equal(h.setup.xyReady, true); assert.equal(h.setup.probeLocked, true);
  assert.deepEqual([h.setup.xyOriginMPos.X, h.setup.xyOriginMPos.Y, h.setup.zOriginMPos], [-75, -49, -45]);
  assert.equal(h.setup.probeLockedAt, probe.lockedAt); // reconnect must not fake a new bit touch
  assert(f.wire.every(command => command === "?" || command === "$#" || command === "$G" || command === "$$"), JSON.stringify(f.wire));
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

test("a held unknown buffer exposes explicit recovery, without automatically resuming or resetting", async t => {
  const f = await fixture(t, "10,90,5", "Hold:0");
  assert.equal((await f.request("/controller/reconnect-verify", {})).status, 200);
  const h = (await f.request("/health")).body;
  assert.equal(h.frameValid, false); assert.equal(h.frameRecovery.active, true); assert.equal(h.frameRecovery.requiresBufferDiscard, true);
  assert.equal((await f.request("/jog/z", { distanceMm: 1, feedMmPerMin: 100, manualPositioning: true })).status, 500);
  assert(f.wire.every(command => command === "?"));
  assert.match(h.frameRecovery.message, /Discard held motion/);
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
  // Commit 4fea1eb reworded this to separate "no connection" from "coordinates
  // locked"; the assertion still checks the operator-meaningful claim, that saved
  // zeros and probes are not what is blocking manual movement.
  assert.match(nodes.cncPositioningDetail.textContent, /Saved zeros and probes are not what is blocking it/);
  nodes.cncControllerRecoverBtn.onclick(); assert.equal(calls[0][0], "reconnect_verify");
  context.cncRenderPositioning({ connected: true, frameValid: false, frameRecovery: { active: true, message: "Saved X/Y verified; touch off Z" }, lastControllerStatus: { state: "Idle", FS: "0,0" } }, false);
  assert.match(nodes.cncPositioningTitle.textContent, /Manual positioning ready/);
  assert.equal(nodes.cncControllerRecoverBtn.disabled,true);
  assert.equal(nodes.cncControllerRecoverBtn.onclick,null);
});

test("recovery jog selector preserves operator-selected travel without issuing motion or changing calibration", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const start = html.indexOf("function cncSyncJogStep("), end = html.indexOf("\nfunction ", start + 1);
  const select = { value: "50", options: [.1,.25,.5,1,5,10,25,50,100].map(value => ({value:String(value),disabled:false})) };
  const note = {textContent:""};
  const context = vm.createContext({document:{getElementById:id=>id==="cncJogStep"?select:note},cncClamp:(v,min,max)=>Math.max(min,Math.min(max,Number(v)))});
  vm.runInContext(html.slice(start,end),context);
  const health = {frameRecovery:{active:true},frameValid:false,setup:{bedProbeReady:true,bedSurfaceMPos:-40.174,xyReady:false}};
  const original = JSON.stringify(health);
  assert.equal(context.cncSyncJogStep(health),50);
  assert.equal(select.value,"50");
  assert(select.options.filter(o=>Number(o.value)>5).every(o=>!o.disabled));
  assert(select.options.filter(o=>Number(o.value)<=5).every(o=>!o.disabled));
  assert.match(note.textContent,/full distance/);
  assert.equal(JSON.stringify(health),original);
  select.value="1";assert.equal(context.cncSyncJogStep(health),1);
  context.cncSyncJogStep({frameRecovery:{active:false}});
  assert(select.options.every(o=>!o.disabled));assert.equal(note.textContent,"");
  select.value="50";assert.equal(context.cncSyncJogStep({}),50);
  select.value="0.01";assert.equal(context.cncSyncJogStep(health),0.01);
});

for (const heldState of ["Door:0", "Hold:0"]) test(`${heldState}: reset recovery reaches manual XYZ and XY zero without calibration or resuming buffered work`, async t => {
  const f = await fixture(t, "0,0,0", heldState, { probeRecord: invalidatedProbe, hardLimitsInitially: false });
  let h = (await f.request("/health")).body;
  assert.equal(h.connected, true); assert.equal(h.moving, false); assert.equal(h.frameRecovery.requiresBufferDiscard, true);
  const xyBefore = readFileSync(f.env.CNC_XY_STATE, "utf8"), probeBefore = readFileSync(f.env.CNC_PROBE_STATE, "utf8");
  assert.equal((await f.request("/controller/recover-stopped", { confirm: true })).status, 500);
  assert(!f.wire.includes("byte:24"), "generic recovery may not silently become a reset");
  const recovered = await f.request("/controller/recover-stopped", { confirm: true, discardBufferedMotion: true });
  assert.equal(recovered.status, 200, JSON.stringify(recovered));
  assert.equal(recovered.body.protection.verified, true);
  assert(f.wire.includes("$21=1"));
  assert.equal(f.wire.filter(c => c === "$$").length, 2, "hard limits must be read back after restoration");
  assert.equal(readFileSync(f.env.CNC_XY_STATE, "utf8"), xyBefore); assert.equal(readFileSync(f.env.CNC_PROBE_STATE, "utf8"), probeBefore);
  h = (await f.request("/health")).body;
  assert.equal(h.lastControllerStatus.state, "Idle"); assert.equal(h.frameValid, false); assert.equal(h.frameRecovery.active, true);
  assert.equal(h.setup.probeLocked, false); assert.equal(h.setup.xyReady, false);
  for (const axis of ["x", "y", "z"]) assert.equal((await f.request(`/jog/${axis}`, { distanceMm: .01, feedMmPerMin: 100, manualPositioning: true })).status, 200);
  assert(f.wire.includes("$J=G91 G21 Z0.010 F100"), "fine touch-off must reach the controller, not round to 0.1 or zero");
  await runJogSegments("X", 25, { move: async distanceMm => { const r = await f.request("/jog/x", { distanceMm, feedMmPerMin: 100, manualPositioning: true }); assert.equal(r.status, 200, JSON.stringify(r)); return r.body; } });
  assert(Math.abs(Number(f.getPosition().split(",")[0]) - 25.01) < .000001);
  assert.equal((await f.request("/zero/xy", { confirmNewProject: true })).status, 200);
  assert.equal((await f.request("/health")).body.setup.xyReady, true);
  for (const path of ["/job/start", "/job/resume", "/job/resume-saved"]) assert.equal((await f.request(path, {})).status, 500, path);
  assert(!f.wire.includes("~"), "manual recovery must never release a held planner");
  assert(!f.wire.includes("$N"), "normal commands cannot run in the held suspend loop");
  assert(!f.wire.some(c => /^G[0123]\s/.test(c)), "no buffered cut may be replayed");
});

test("a held connected controller stays connected instead of entering a 10-second reconnect loop", async t => {
  const f = await fixture(t, "0,0,0", "Door:0", { probeRecord: invalidatedProbe });
  const connections = f.getConnections();
  await new Promise(resolve => setTimeout(resolve, 10_050));
  const h = (await f.request("/health")).body;
  assert.equal(h.connected, true); assert.equal(h.reconnecting, false); assert.equal(h.moving, false);
  assert.equal(f.getConnections(), connections);
  assert(f.wire.every(c => c === "?"), JSON.stringify(f.wire));
});

test("reset recovery serializes manual motion and rejects stale Start while waiting for reset acknowledgment", async t => {
  const f = await fixture(t, "0,0,0", "Door:0", { probeRecord: invalidatedProbe, resetDelayMs: 100 });
  const reset = f.request("/controller/recover-stopped", { confirm: true, discardBufferedMotion: true });
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal((await f.request("/jog/z", { distanceMm: 1, feedMmPerMin: 100, manualPositioning: true })).status, 500);
  assert.equal((await f.request("/zero/xy", { confirmNewProject: true })).status, 500);
  assert.equal((await f.request("/job/start", { gcode: "G21\nG90\nG1 X10 F100" })).status, 500);
  assert.equal((await reset).status, 200);
  assert(!f.wire.some(c => c.startsWith("$J=") || /^G[0123]\s/.test(c)));
});

test("a reset that does not become Idle keeps motion blocked and explicit recovery reachable", async t => {
  const f = await fixture(t, "0,0,0", "Door:0", { probeRecord: invalidatedProbe, resetState: "Door:0" });
  const result = await f.request("/controller/recover-stopped", { confirm: true, discardBufferedMotion: true });
  assert.equal(result.status, 500); assert.match(result.body.error, /must be Idle/);
  const h = (await f.request("/health")).body;
  assert.equal(h.frameRecovery.active, true); assert.equal(h.frameRecovery.requiresBufferDiscard, true); assert.equal(h.moving, false);
  assert.equal((await f.request("/jog/z", { distanceMm: 1, feedMmPerMin: 100, manualPositioning: true })).status, 500);
  assert(!f.wire.includes("~"));
});

test("stationary reset reuses unchanged verified calibration; XY zero retains completed bed and stock probes", async t => {
  const f = await fixture(t, "10,90,5", "Door:0");
  assert.equal((await f.request("/controller/recover-stopped", { confirm: true, discardBufferedMotion: true })).status, 200);
  let h = (await f.request("/health")).body;
  assert.equal(h.frameValid, true); assert.equal(h.setup.probeLocked, true); assert.equal(h.setup.xyReady, true);
  assert.equal(h.surfaceProof.ready, false, "reset does not preserve cutting authorization");
  assert.equal((await f.request("/zero/xy", { confirmNewProject: true })).status, 200);
  h = (await f.request("/health")).body;
  assert.equal(h.setup.bedSurfaceMPos, probe.bedSurfaceMPos); assert.equal(h.setup.stockSurfaceMPos, probe.stockSurfaceMPos);
  assert.equal(h.setup.probeLocked, true); assert.equal(h.setup.probeLockedAt, probe.lockedAt);
});

test("changed reset coordinates are never accepted merely because persistent offsets survived", async t => {
  const f = await fixture(t, "10,90,5", "Door:0", { resetPosition: "0,0,0" });
  const saved = readFileSync(f.env.CNC_PROBE_STATE, "utf8");
  assert.equal((await f.request("/controller/recover-stopped", { confirm: true, discardBufferedMotion: true })).status, 200);
  const h = (await f.request("/health")).body;
  assert.equal(h.frameValid, false); assert.equal(h.setup.xyReady, false); assert.equal(h.setup.probeLocked, false);
  assert.equal(h.frameRecovery.active, true); assert.equal(h.xyRecovery.available, true);
  assert.equal(readFileSync(f.env.CNC_PROBE_STATE, "utf8"), saved);
  assert.equal((await f.request("/job/start", {})).status, 500);
});

for (const [label, defect] of [
  ["$21 write acknowledged but readback still zero", { hardLimitsInitially: false, ignoreHardLimitWrite: true }],
  ["unreadable Z steps/mm", { omitZSteps: true }],
]) test(`${label}: manual setup remains usable, but proof/reconnect cannot release cutting`, async t => {
  const f = await fixture(t, "10,90,5", "Door:0", { savedProgramForBounds: true, ...defect });
  assert.equal((await f.request("/controller/recover-stopped", { confirm: true, discardBufferedMotion: true })).status, 200);
  let h = (await f.request("/health")).body;
  assert.equal(h.controllerProtection.ready, false); assert.equal(h.frameValid, false);
  assert.equal(h.setup.probeLocked, true, "completed measurements are retained, not erased to enforce a cut hold");
  assert.equal(h.workspace.calibrated, true);
  assert.equal((await f.request("/probe/verify-surface", { method: "operator-attested-feeler", confirm: true })).status, 200);
  const cuttingProgram = { jobId: "must-not-cut", stockWidthMm: 300, stockHeightMm: 200, stockReserveMm: 5, manualRouter: true, gcode: "G21\nG90\nG0 Z5\nG1 X85 Y139 Z-0.1 F50\nG0 Z5\nM30" };
  let start = await f.request("/job/start", cuttingProgram);
  assert.equal(start.status, 500); assert.match(start.body.error, /Controller protection blocks cutting/);
  assert.equal((await f.request("/jog/z", { distanceMm: 1, feedMmPerMin: 100, manualPositioning: true })).status, 200);
  assert.equal((await f.request("/zero/xy", { confirmNewProject: true })).status, 200);
  assert.equal((await f.request("/health")).body.frameValid, false, "zeroing cannot erase the protection hold");
  const settingWrites = f.wire.filter(c => c === "$21=1").length;
  assert.equal((await f.request("/controller/reconnect-verify", {})).status, 200);
  assert.equal(f.wire.filter(c => c === "$21=1").length, settingWrites, "ordinary reconnect remains read-only");
  h = (await f.request("/health")).body;
  assert.equal(h.controllerProtection.ready, false); assert.equal(h.frameValid, false);
  assert.equal((await f.request("/probe/verify-surface", { method: "operator-attested-feeler", confirm: true })).status, 200);
  start = await f.request("/job/start", cuttingProgram);
  assert.equal(start.status, 500); assert.match(start.body.error, /Controller protection blocks cutting/);
  assert(!f.wire.some(c => /^G[0123]\s/.test(c)), "no cutting line reaches the controller");
  f.repairProtection();
  assert.equal((await f.request("/controller/recover-stopped", { confirm: true })).status, 200);
  h = (await f.request("/health")).body;
  assert.equal(h.controllerProtection.ready, true); assert.equal(h.frameValid, true);
  assert.equal(h.surfaceProof.ready, false, "successful protection retry is not a new authorization to cut");
  assert(!f.wire.includes("~"));
});

test("ordinary reconnect cannot forget a known steps/mm drift or restore old locks", async t => {
  const f = await fixture(t, "10,90,5", "Door:0", { stepsZ: 400 });
  assert.equal((await f.request("/controller/recover-stopped", { confirm: true, discardBufferedMotion: true })).status, 200);
  let h = (await f.request("/health")).body;
  assert.equal(h.controllerProtection.ready, false); assert.equal(h.controllerProtection.frameInvalid, true);
  assert.equal(h.setup.xyReady, false); assert.equal(h.setup.probeLocked, false);
  assert.equal((await f.request("/controller/reconnect-verify", {})).status, 200);
  h = (await f.request("/health")).body;
  assert.equal(h.controllerProtection.ready, false); assert.equal(h.frameValid, false);
  assert.equal(h.setup.xyReady, false); assert.equal(h.setup.probeLocked, false);
  f.hideZSteps();
  assert.equal((await f.request("/controller/reconnect-verify", {})).status, 200);
  h = (await f.request("/health")).body;
  assert.equal(h.controllerProtection.frameInvalid, true, "an incomplete settings reply cannot forget known scale drift");
  assert.equal(h.setup.xyReady, false); assert.equal(h.setup.probeLocked, false);
  assert.equal((await f.request("/jog/z", { distanceMm: .01, feedMmPerMin: 100, manualPositioning: true })).status, 200);
});

test("actual UI distinguishes connected Door from offline and enables manual controls only after recovery", () => {
  const ui = loadBrowserScript(new URL("../index.html", import.meta.url).pathname);
  const job = { id: "manual-test", agentState: "idle", material: "Wood" };
  const config = { machX: 300, machY: 200, machZ: 80 };
  const h = { connected: true, moving: false, frameValid: false, frameRecovery: { active: true, requiresBufferDiscard: true }, lastControllerStatus: { state: "Door:0", MPos: "0,0,0", FS: "0,0" }, setup: {}, workspace: {}, job: { state: "idle" } };
  ui.renderAgent(job, h, config);
  assert.match(ui.elements.cncPositioningTitle.textContent, /Controller connected/);
  assert.doesNotMatch(ui.elements.cncPositioningTitle.textContent, /offline/);
  assert.equal(ui.elements.cncControllerRecoverBtn.disabled, false);
  assert.equal(ui.elements.cncZeroBtn.disabled, true);
  assert(ui.jogButtons.every(button => button.disabled));
  job.agentState = "stopped"; ui.renderAgent(job, h, config);
  assert.match(ui.elements.cncCommandDetail.textContent, /Use Reset held controller/);
  assert.doesNotMatch(ui.elements.cncCommandDetail.textContent, /Reconnecting/);
  h.lastControllerStatus.state = "Idle";
  ui.renderAgent(job, h, config);
  assert.equal(ui.elements.cncControllerRecoverBtn.disabled, false, "missing reset verification remains recoverable");
  assert.equal(ui.elements.cncZeroBtn.disabled, true); assert(ui.jogButtons.every(button => button.disabled));
  h.frameRecovery = { active: true };
  ui.renderAgent(job, h, config);
  assert.equal(ui.elements.cncZeroBtn.disabled, false); assert(ui.jogButtons.every(button => !button.disabled));
  assert.equal(ui.elements.cncStartBtn.disabled, true);
  h.controllerProtection = { ready: false, reason: "$21 hard limits were not verified" };
  ui.renderAgent(job, h, config);
  assert.equal(ui.elements.cncControllerRecoverBtn.textContent, "Restore controller protection");
  assert.equal(ui.elements.cncControllerRecoverBtn.disabled, false);
  assert.equal(ui.elements.cncZeroBtn.disabled, false); assert(ui.jogButtons.every(button => !button.disabled));
  assert.equal(ui.elements.cncStartBtn.disabled, true);
  job.agentState = "paused"; ui.renderAgent(job, h, config);
  assert(ui.jogButtons.every(button => button.disabled)); assert.equal(ui.elements.cncZeroBtn.disabled, true);
  assert.equal(ui.elements.cncStopBtn.disabled, false);
  job.agentState = "idle";
  h.moving = true;
  ui.renderAgent(job, h, config);
  assert.equal(ui.elements.cncZeroBtn.disabled, true); assert(ui.jogButtons.every(button => button.disabled));
  assert.equal(ui.elements.cncStopBtn.disabled, false);
});

test("Stop restores manual positioning without a reconnect click, but never validates reset cutting coordinates", async t => {
 const f=await fixture(t,"0,0,0");
 const stop=await f.request("/job/stop",{});
 assert.equal(stop.status,200,JSON.stringify(stop));
 const h=(await f.request("/health")).body;assert.equal(h.job.state,"stopped");
 assert.equal(h.frameValid,false);assert.equal(h.frameRecovery.active,true);
 assert.equal(h.setup.xyReady,false);assert.equal(h.setup.probeLocked,false);
 assert.equal((await f.request("/job/start",{})).status,500);
 const jog=await f.request("/jog/z",{distanceMm:5,feedMmPerMin:100,manualPositioning:true});
 assert.equal(jog.status,200,JSON.stringify(jog));assert.equal(f.getPosition(),"0,0,5");
 assert(!f.wire.includes("~"));assert(!f.wire.some(c=>c.startsWith("G10")));
});
test("startup exposes manual positioning after a recorded stop without requiring reconnect", async t => {
 const f=await fixture(t,"0,0,0");const h=(await f.request("/health")).body;
 assert.equal(h.frameRecovery.active,true);assert.equal(h.frameValid,false);
 assert(f.wire.every(c=>c==='?'||c==='$#'||c==='$G'||c==='$$'));
 assert.equal((await f.request("/jog/z",{distanceMm:1,feedMmPerMin:100,manualPositioning:true})).status,200);
});

for(const stoppedState of ["Idle","Hold:0"])test(`actual streamed-program Stop unwinds and handles ${stoppedState} without resuming`,async t=>{
 const f=await fixture(t,"10,90,5","Idle",{streaming:true,stoppedState});
 // Start now requires an independent surface-contact proof. This fixture is a
 // non-metal stage, so satisfy it through the real attested path rather than
 // bypassing the gate: this test is about Stop unwinding, not about the gate.
 const attest=await f.request("/probe/verify-surface",{method:"operator-attested-feeler",confirm:true});
 assert.equal(attest.status,200,JSON.stringify(attest));
 const run=f.request("/job/start",{jobId:"fake",stockWidthMm:300,stockHeightMm:200,stockReserveMm:5,manualRouter:true,gcode:"G21\nG90\nG0 Z5\nG1 X85 Y139 Z-0.1 F50\nG0 Z5\nM30"});
 const deadline=Date.now()+3000;while(!f.wire.some(c=>/^G1\b/.test(c))&&Date.now()<deadline)await new Promise(r=>setTimeout(r,10));
 assert(f.wire.some(c=>/^G1\b/.test(c)),JSON.stringify(await Promise.race([run,Promise.resolve(f.wire)])));
 assert.equal((await f.request("/jog/z",{distanceMm:1,feedMmPerMin:100,manualPositioning:true})).status,500);
 assert.equal((await f.request("/zero/xy",{confirmNewProject:true})).status,500);
 const stop=await f.request("/job/stop",{});assert.equal(stop.status,200,JSON.stringify(stop));
 assert.equal((await run).status,500);const h=(await f.request("/health")).body;assert.equal(h.job.state,"stopped");assert.equal(h.frameValid,false);
 const jog=await f.request("/jog/z",{distanceMm:1,feedMmPerMin:100,manualPositioning:true});
 assert.equal(jog.status,stoppedState==="Idle"?200:500,JSON.stringify(jog));
 assert(!f.wire.includes("~"));assert(!f.wire.includes("byte:24"));
});
