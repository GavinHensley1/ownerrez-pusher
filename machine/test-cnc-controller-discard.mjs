import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import { GrblTcpController } from "./cnc-controller.mjs";

// The suspended controller accepts realtime bytes, but deliberately cannot
// answer $N or any other normal query until its old planner/RX are discarded.
async function fixture(t, { welcome = true, afterReset = "Idle", pins = "", pinsAfterReset = pins, feed = 0 } = {}) {
  let state = "Door:0", position = "10,20,30", planner = ["G1 X100 Y100 Z-5"], rx = "G1 X200", buffer = "", reset = false;
  const wire = [], sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket));
    socket.on("data", chunk => {
      for (const byte of chunk) {
        const c = String.fromCharCode(byte);
        if (c === "?") { const activePins = reset ? pinsAfterReset : pins; wire.push("?"); socket.write(`<${state}|MPos:${position}|FS:${reset && state === "Run" ? 100 : feed},0${activePins ? `|Pn:${activePins}` : ""}>\r\n`); continue; }
        if (byte === 0x18) { wire.push("reset"); planner = []; rx = ""; buffer = ""; reset = true; state = afterReset; if (welcome) socket.write("Grbl 1.1h ['$' for help]\r\n"); continue; }
        if (c === "~") { wire.push("~"); position = "100,100,-5"; state = "Run"; continue; }
        if (c === "!" || byte === 0x85 || byte === 0x9e) { wire.push(`realtime:${byte}`); state = "Hold:0"; continue; }
        buffer += c;
        if (c !== "\r") continue;
        const line = buffer.trim(); buffer = ""; wire.push(line);
        if (["Hold:0", "Door:0"].includes(state)) { rx += line; continue; }
        if (line === "$X") state = "Idle";
        socket.write("ok\r\n");
      }
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const controller = new GrblTcpController({ host: "127.0.0.1", port: server.address().port, commandTimeoutMs: 80, statusTimeoutMs: 20, motionGuard: async () => {} });
  t.after(async () => { await controller.close(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  return { controller, wire, buffers: () => ({ planner, rx }), position: () => position, clearPins: () => { pins = ""; pinsAfterReset = ""; } };
}

test("explicit reset clears simulated planner and partial RX without Cycle Start or normal held-state queries", async t => {
  const f = await fixture(t);
  const result = await f.controller.discardHeldMotion();
  assert.equal(result.discardedBufferedMotion, true); assert.match(result.resetWelcome, /^Grbl/);
  assert.equal(result.after.state, "Idle"); assert.equal(f.position(), "10,20,30");
  assert.deepEqual(f.buffers(), { planner: [], rx: "" });
  assert.deepEqual(f.wire, ["?", "reset", "?"]);
});

test("an Idle status cannot substitute for the missing reset acknowledgment", async t => {
  const f = await fixture(t, { welcome: false });
  await assert.rejects(() => f.controller.discardHeldMotion(), /reset was not acknowledged/);
  assert.deepEqual(f.wire, ["?", "reset"]);
});

test("reset-to-Alarm unlocks only after reset acknowledgment, without axis command or Cycle Start", async t => {
  const f = await fixture(t, { afterReset: "Alarm" });
  const result = await f.controller.discardHeldMotion();
  assert.equal(result.after.state, "Idle");
  assert.deepEqual(f.wire, ["?", "reset", "?", "$X", "?"]);
});

test("reset-to-Alarm with an active pin is blocked but can recover explicitly after the pin clears", async t => {
  const f = await fixture(t, { afterReset: "Alarm", pinsAfterReset: "D" });
  await assert.rejects(() => f.controller.discardHeldMotion(), /inputs are not clear/);
  assert(!f.wire.includes("$X"), "never unlock an asserted safety input");
  f.clearPins();
  const retried = await f.controller.discardHeldMotion();
  assert.equal(retried.after.state, "Idle"); assert.equal(f.wire.filter(c => c === "reset").length, 2);
  assert(!f.wire.includes("~"));
});

test("unexpected firmware startup motion is stopped and quarantined, not accepted as manual readiness", async t => {
  const f = await fixture(t, { afterReset: "Run" });
  await assert.rejects(() => f.controller.discardHeldMotion(), /UNEXPECTED_MOTION_AFTER_BUFFER_DISCARD/);
  assert(f.wire.includes("realtime:33")); assert(f.wire.includes("realtime:133"));
  assert(!f.wire.includes("~")); assert.equal(f.controller.connected, false);
});

for (const options of [{ pins: "D" }, { feed: 100 }]) test(`reset is refused before transmission for ${JSON.stringify(options)}`, async t => {
  const f = await fixture(t, options);
  await assert.rejects(() => f.controller.discardHeldMotion(), /requires stopped/);
  assert.deepEqual(f.wire, ["?"]);
});
