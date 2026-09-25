import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import { GrblTcpController, parseStatus, parseWorkOffset, VirtualWorkspace } from "./cnc-controller.mjs";

const makeMock = async ({ ignoreFirstStatus = false, delimiter = "\r\n", jogNeverIdles = false, lateQueryAckMs = 0, homingAlarm = false, probeAssertsZ = true, startProbeAlarm = false, startDoor = false } = {}) => {
  let connections = 0, statusQueries = 0, x = 0, y = 0, z = startProbeAlarm ? -74 : 0, jogging = false, jogPolls = 0, homing = false, homePolls = 0, alarmed = startProbeAlarm, door = startDoor, spindle = 0, probeActive = startProbeAlarm, zLimitActive = startProbeAlarm, hardLimits = true;
  const writes = [];
  const server = net.createServer((socket) => {
    connections += 1;
    let buffer = "";
    socket.on("data", (chunk) => {
      writes.push(Buffer.from(chunk));
      for (const byte of chunk) {
        const char = String.fromCharCode(byte);
        if (byte === 0x85 || byte === 0x9e || byte === 0x18 || char === "!") { jogging = false; continue; }
        if (char === "~") { jogging = false; door = false; continue; }
        if (char === "?") {
          statusQueries += 1;
          if (ignoreFirstStatus && statusQueries === 1) continue;
          let state = alarmed ? "Alarm" : door ? "Door:0" : "Idle";
          if (jogging) { state = "Jog"; jogPolls += 1; if (!jogNeverIdles && jogPolls >= 2) { jogging = false; state = "Idle"; } }
          if (homing) {
            state = "Home"; homePolls += 1;
            if (homePolls >= 2) {
              homing = false;
              if (homingAlarm) { state = "Alarm"; socket.write(`ALARM:9${delimiter}`); }
              else { state = "Idle"; socket.write(`ok${delimiter}`); }
            }
          }
          const pins = `${probeActive ? "P" : ""}${zLimitActive ? "Z" : ""}`;
          socket.write(`<${state}|MPos:${x.toFixed(3)},${y.toFixed(3)},${z.toFixed(3)}|FS:${state === "Idle" || state === "Alarm" || state.startsWith("Door") ? `0,${spindle}` : "100,0"}${pins ? `|Pn:${pins}` : ""}>${delimiter}`);
        } else {
          buffer += char;
          if (char === "\r") {
            const command = buffer.trim(); buffer = "";
            if (command === "$G") setTimeout(() => socket.write(`[GC:G0 G54 G17 G21 G90 G94 M5 M9 T0 F0 S0]${delimiter}ok${delimiter}`), lateQueryAckMs);
            else if (command === "$$") {
              if (alarmed) socket.write(`error:9${delimiter}`);
              else socket.write(`$3=4${delimiter}$21=${hardLimits ? 1 : 0}${delimiter}$27=3.000${delimiter}ok${delimiter}`);
            }
            else if (command === "$X") { alarmed = false; socket.write(`ok${delimiter}`); }
            else if (command.startsWith("$J=")) {
              x += Number(command.match(/X(-?\d+(?:\.\d+)?)/)?.[1] || 0);
              y += Number(command.match(/Y(-?\d+(?:\.\d+)?)/)?.[1] || 0);
              z += Number(command.match(/Z(-?\d+(?:\.\d+)?)/)?.[1] || 0);
              if ((command.match(/Z(-?\d+(?:\.\d+)?)/)?.[1] || 0) > 0) { probeActive = false; zLimitActive = false; }
              jogging = true; jogPolls = 0; socket.write(`ok${delimiter}`);
            }
            else if (/^M3 S\d+$/.test(command)) { spindle = Number(command.slice(command.indexOf("S") + 1)); socket.write(`ok${delimiter}`); }
            else if (command === "M5") { spindle = 0; socket.write(`ok${delimiter}`); }
            else if (/^\$(20|21|22)=[01]$/.test(command)) { if (command.startsWith("$21=")) hardLimits = command.endsWith("1"); socket.write(`ok${delimiter}`); }
            else if (command.startsWith("G10 L20 P1 ")) socket.write(`ok${delimiter}`);
            else if (/^G38\.2 Z-/.test(command)) { z -= 1; probeActive = true; zLimitActive = probeAssertsZ; if (hardLimits && zLimitActive) alarmed = true; socket.write(`ok${delimiter}`); }
            else if (/^(G21|G90|G17|G0\b|G1\b|G4\b|M2\b)/.test(command)) socket.write(`ok${delimiter}`);
            else if (command === "$H") {
              homing = true; homePolls = 0;
              setTimeout(() => {
                homing = false;
                if (homingAlarm) { alarmed = true; socket.write(`ALARM:9${delimiter}`); }
                else socket.write(`ok${delimiter}`);
              }, 50);
            }
            else socket.write(`error:1${delimiter}`);
          }
        }
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: server.address().port, get connections() { return connections; }, get statusQueries() { return statusQueries; }, get bytes() { return Buffer.concat(writes); }, close: () => new Promise((resolve) => server.close(resolve)) };
};

test("keeps one socket and retries ignored status", async () => {
  const mock = await makeMock({ ignoreFirstStatus: true });
  const c = new GrblTcpController({ host: "127.0.0.1", port: mock.port, statusTimeoutMs: 25 });
  assert.equal(parseStatus(await c.status({ attempts: 3 })).state, "Idle"); assert.equal(mock.connections, 1); assert.equal(mock.statusQueries, 2);
  await c.close(); await mock.close();
});

test("parses the persistent G54 work origin", () => {
  assert.deepEqual(parseWorkOffset(["[G54:-207.685,-25.000,-46.780,0.000]", "ok"]), { X: -207.685, Y: -25, Z: -46.78 });
  assert.throws(() => parseWorkOffset(["ok"]), /G54 work offset is unavailable/);
});

test("parses CR-only records and serializes queries", async () => {
  const mock = await makeMock({ delimiter: "\r" });
  const c = new GrblTcpController({ host: "127.0.0.1", port: mock.port, statusTimeoutMs: 25 });
  await c.status(); assert((await c.query("$G")).some((line) => line.startsWith("[GC:"))); assert((await c.query("$$")).includes("$27=3.000")); assert.equal(mock.connections, 1);
  await c.close(); await mock.close();
});

test("query timeout quarantines socket and rejects later commands", async () => {
  const mock = await makeMock({ lateQueryAckMs: 100 });
  const c = new GrblTcpController({ host: "127.0.0.1", port: mock.port, commandTimeoutMs: 20 });
  await assert.rejects(() => c.query("$G"), /timeout/); await assert.rejects(() => c.query("$$"), /fault is latched/); await new Promise((r) => setTimeout(r, 120)); assert.equal(mock.connections, 1);
  await c.close(); await mock.close();
});

test("jog requires guard and verifies Idle completion and delta", async () => {
  const mock = await makeMock(); let guardCalls = 0;
  const c = new GrblTcpController({ host: "127.0.0.1", port: mock.port, statusTimeoutMs: 25, motionGuard: async () => { guardCalls += 1; } });
  const result = await c.jogX(10, 100, { calibration: true }); assert.equal(result.after.state, "Idle"); assert.equal(result.deltaMm, 10); assert(guardCalls >= 3); assert.equal(mock.connections, 1);
  await c.close(); await mock.close();
});

test("camera failure sends jog cancel and feed hold and latches fault", async () => {
  const mock = await makeMock({ jogNeverIdles: true }); let guardCalls = 0;
  const c = new GrblTcpController({ host: "127.0.0.1", port: mock.port, statusTimeoutMs: 25, motionGuard: async () => { guardCalls += 1; if (guardCalls >= 3) throw new Error("camera stale"); } });
  await assert.rejects(() => c.jogX(10, 100, { calibration: true }), /CAMERA_GUARD_FAILED/); await new Promise((r) => setTimeout(r, 30)); assert(mock.bytes.includes(0x85)); assert(mock.bytes.includes("!".charCodeAt(0))); await assert.rejects(() => c.status(), /fault is latched/);
  await c.close(); await mock.close();
});

test("rejects rounded-zero, excessive feed, and cumulative travel", async () => {
  const mock = await makeMock();
  const c = new GrblTcpController({ host: "127.0.0.1", port: mock.port, statusTimeoutMs: 25, maxSessionTravelMm: 15, motionGuard: async () => {} });
  await assert.rejects(() => c.jogX(0.0001, 100, { calibration: true }), /round to non-zero/); await assert.rejects(() => c.jogX(10, 500.6, { calibration: true }), /1-500/); await c.jogX(10, 100, { calibration: true }); await assert.rejects(() => c.jogX(10, 100, { calibration: true }), /envelope/);
  await c.close(); await mock.close();
});

test("homing is camera-guarded and captures success", async () => {
  const mock = await makeMock(); let guardCalls = 0;
  const c = new GrblTcpController({ host: "127.0.0.1", port: mock.port, statusTimeoutMs: 25, motionGuard: async () => { guardCalls += 1; } });
  const result = await c.home({ timeoutMs: 10_000 }); assert.equal(result.after.state, "Idle"); assert(result.reply.includes("ok")); assert(guardCalls >= 3);
  await c.close(); await mock.close();
});

test("homing returns exact GRBL alarm", async () => {
  const mock = await makeMock({ homingAlarm: true });
  const c = new GrblTcpController({ host: "127.0.0.1", port: mock.port, statusTimeoutMs: 25, motionGuard: async () => {} });
  const result = await c.home({ timeoutMs: 10_000 }); assert.match(result.replyError, /^ALARM:9/); assert.equal(result.after.state, "Alarm");
  await c.close(); await mock.close();
});

test("virtual workspace permits inside jog and rejects barrier crossing", async () => {
  const workspace = new VirtualWorkspace();
  workspace.setBounds({ X: { min: -20, max: 20 }, Y: { min: -20, max: 20 }, Z: { min: -10, max: 10 } });
  const origin = parseStatus("<Idle|MPos:0.000,0.000,0.000|FS:0,0>");
  assert.throws(() => workspace.assertJog({ before: origin, axis: "Y", distanceMm: 21 }), /Virtual Y barrier rejects/);
  assert.throws(() => workspace.assertJog({ before: origin, axis: "Z", distanceMm: -11 }), /Virtual Z barrier rejects/);
  const mock = await makeMock();
  const c = new GrblTcpController({ host: "127.0.0.1", port: mock.port, statusTimeoutMs: 25, motionGuard: async () => {}, workspaceGuard: (request) => workspace.assertJog(request) });
  await c.jog("X", 10, 100);
  await assert.rejects(() => c.jog("X", 15, 100), /Virtual X barrier rejects/);
  await c.close(); await mock.close();
});

test("probe-staging margin extends only the negative X/Y boundary", () => {
  const workspace = new VirtualWorkspace();
  workspace.setBounds({ X: { min: -20, max: 20 }, Y: { min: -20, max: 20 }, Z: { min: -10, max: 10 } });
  const origin = { MPos: "0.000,0.000,0.000,0.000" };
  assert.equal(workspace.assertJog({ before: origin, axis: "X", distanceMm: -25, negativeMarginMm: 10 }).min, -30);
  assert.equal(workspace.assertJog({ before: origin, axis: "Y", distanceMm: -25, negativeMarginMm: 10 }).target, -25);
  assert.throws(() => workspace.assertJog({ before: origin, axis: "X", distanceMm: 21, negativeMarginMm: 10 }), /barrier rejects/);
  assert.throws(() => workspace.assertJog({ before: origin, axis: "Z", distanceMm: -11, negativeMarginMm: 10 }), /Invalid probe-staging margin/);
  assert.throws(() => workspace.assertJog({ before: origin, axis: "X", distanceMm: -25, negativeMarginMm: 61 }), /Invalid probe-staging margin/);
});

test("safe retract bypasses only the upper workspace ceiling for positive Z", async () => {
  const mock = await makeMock();
  const workspace = new VirtualWorkspace();
  workspace.setBounds({ X: { min: -20, max: 20 }, Y: { min: -20, max: 20 }, Z: { min: -10, max: 1 } });
  const c = new GrblTcpController({ host: "127.0.0.1", port: mock.port, motionGuard: async () => {}, workspaceGuard: (request) => workspace.assertJog(request) });
  await c.connect();
  const result = await c.jog("Z", 5, 100, { safeRetract: true });
  assert.equal(result.deltaMm, 5);
  await assert.rejects(() => c.jog("Z", -1, 100, { safeRetract: true }), /only allowed for positive Z/);
  await assert.rejects(() => c.jog("X", 1, 100, { safeRetract: true }), /only allowed for positive Z/);
  await c.close(); await mock.close();
});

test("virtual workspace is required outside calibration mode", async () => {
  const mock = await makeMock();
  const c = new GrblTcpController({ host: "127.0.0.1", port: mock.port, statusTimeoutMs: 25, motionGuard: async () => {} });
  await assert.rejects(() => c.jog("X", 5, 100), /not calibrated/);
  const result = await c.jog("X", 5, 100, { calibration: true });
  assert.equal(result.deltaMm, 5);
  await c.close(); await mock.close();
});

test("manual and probe-safety settings and work offset are narrowly allowed", async () => {
  const mock = await makeMock();
  const c = new GrblTcpController({ host: "127.0.0.1", port: mock.port, statusTimeoutMs: 25 });
  assert((await c.setBooleanSetting(22, false)).includes("ok"));
  assert((await c.setBooleanSetting(20, false)).includes("ok"));
  assert((await c.setBooleanSetting(21, false)).includes("ok"));
  await assert.rejects(() => c.setBooleanSetting(23, false), /not allowed/);
  assert((await c.setWorkOffset({ x: 0, y: 0, z: 5 })).includes("ok"));
  await c.close(); await mock.close();
});

test("spindle test is camera-guarded, capped, timed, and verifies stop", async () => {
  const mock = await makeMock(); let guardCalls = 0;
  const c = new GrblTcpController({ host: "127.0.0.1", port: mock.port, statusTimeoutMs: 25, motionGuard: async () => { guardCalls += 1; }, maxSpindleTestRpm: 1500 });
  const result = await c.spindleTest(1000, 250);
  assert.equal(result.running.FS, "0,1000"); assert.equal(result.after.FS, "0,0"); assert(guardCalls >= 3);
  await assert.rejects(() => c.spindleTest(1501, 250), /1-1500/);
  await c.close(); await mock.close();
});

test("power-on door acknowledgment is camera-guarded and cannot start motion", async () => {
  const mock = await makeMock({ startDoor: true }); let guards = 0;
  const c = new GrblTcpController({ host: "127.0.0.1", port: mock.port, statusTimeoutMs: 25, motionGuard: async () => { guards += 1; } });
  const result = await c.acknowledgePowerOnDoor();
  assert.equal(result.before.state, "Door:0"); assert.equal(result.after.state, "Idle"); assert.equal(result.after.FS, "0,0"); assert(guards >= 2);
  assert(mock.bytes.includes("~".charCodeAt(0))); assert(!mock.bytes.includes(Buffer.from("$J="))); assert(!mock.bytes.includes(Buffer.from("M3")));
  await c.close(); await mock.close();
});

test("camera failure during spindle test sends M5 and latches fault", async () => {
  const mock = await makeMock(); let guardCalls = 0;
  const c = new GrblTcpController({ host: "127.0.0.1", port: mock.port, statusTimeoutMs: 25, motionGuard: async () => { guardCalls += 1; if (guardCalls >= 3) throw new Error("camera stale"); } });
  await assert.rejects(() => c.spindleTest(1000, 1000), /CAMERA_GUARD_FAILED/);
  await new Promise((r) => setTimeout(r, 30));
  assert(mock.bytes.includes(Buffer.from("M5\r"))); assert(mock.bytes.includes("!".charCodeAt(0)));
  await c.close(); await mock.close();
});

test("probe is camera guarded and establishes Z from a bounded two-pass cycle", async () => {
  const mock = await makeMock(); let guards = 0;
  const c = new GrblTcpController({ host: "127.0.0.1", port: mock.port, statusTimeoutMs: 25, motionGuard: async () => { guards += 1; } });
  const result = await c.probeZ({ thicknessMm: 12.1 });
  assert.equal(result.thicknessMm, 12.1); assert.equal(result.after.state, "Idle"); assert(guards >= 4);
  assert(mock.bytes.includes(Buffer.from("$21=0\r"))); assert(mock.bytes.includes(Buffer.from("$21=1\r")));
  assert(mock.bytes.includes(Buffer.from("G38.2 Z-20.000 F100\r"))); assert(mock.bytes.includes(Buffer.from("G10 L20 P1 Z12.100\r")));
  assert.equal(result.firstContact.Pn, "PZ"); assert.equal(result.after.Pn, undefined); assert.equal(result.hardLimitsRestored, true);
  await c.close(); await mock.close();
});

test("recovers an alarmed probe contact, retracts, and restores hard limits", async () => {
  const mock = await makeMock({ startProbeAlarm: true }); let guards = 0;
  const c = new GrblTcpController({ host: "127.0.0.1", port: mock.port, statusTimeoutMs: 25, motionGuard: async () => { guards += 1; } });
  const result = await c.recoverProbeContact({ retractMm: 3, feed: 100 });
  assert.equal(result.before.state, "Alarm"); assert.equal(result.before.Pn, "PZ"); assert.equal(result.after.state, "Idle"); assert.equal(result.after.Pn, undefined);
  assert(mock.bytes.includes(Buffer.from("$X\r"))); assert(mock.bytes.includes(Buffer.from("$21=0\r"))); assert(mock.bytes.includes(Buffer.from("$21=1\r"))); assert(guards >= 3);
  assert(mock.bytes.indexOf(Buffer.from("$X\r")) < mock.bytes.indexOf(Buffer.from("$$\r")));
  await c.close(); await mock.close();
});

test("program streaming requires both camera and envelope guards", async () => {
  const mock = await makeMock(); let cameraGuards = 0, programGuards = 0;
  const c = new GrblTcpController({ host: "127.0.0.1", port: mock.port, statusTimeoutMs: 25, motionGuard: async () => { cameraGuards += 1; }, programGuard: async ({ analysis }) => { programGuards += 1; assert.equal(analysis.bounds.X.max, 10); } });
  const source = "G21\nG90\nG17\nG0 X0 Y0 Z2\nM3 S1000\nG1 X10 Y10 Z-1 F100\nM5\nM2";
  const result = await c.runProgram(source);
  assert.equal(result.after.state, "Idle"); assert.equal(programGuards, 1); assert(cameraGuards >= 2); assert(mock.bytes.includes(Buffer.from("G1 X10 Y10 Z-1 F100\r")));
  await c.close(); await mock.close();
});

test("unsafe program is rejected before transmission", async () => {
  const mock = await makeMock();
  const c = new GrblTcpController({ host: "127.0.0.1", port: mock.port, statusTimeoutMs: 25, motionGuard: async () => {}, programGuard: async () => {} });
  await assert.rejects(() => c.runProgram("G21\nG90\nG38.2 Z-5\nM3 S1000\nM5"), /Unsafe coordinate\/probe/);
  assert(!mock.bytes.includes(Buffer.from("G38.2")));
  await c.close(); await mock.close();
});
