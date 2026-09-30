import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const waitFor = async (predicate, timeoutMs = 5000) => {
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

async function makeGrbl() {
  let z = 0, contactZ = -22, probeSucceeded = false, probeZ = 0, probeActive = false, hardLimits = true, incremental = false, g54z = 0, jogPolls = 0;
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      for (const byte of chunk) {
        const char = String.fromCharCode(byte);
        if (char === "?") {
          const jogging = jogPolls > 0; if (jogPolls > 0) jogPolls -= 1;
          socket.write(`<${jogging ? "Jog" : "Idle"}|MPos:0.000,0.000,${z.toFixed(3)}|FS:${jogging ? "100,0" : "0,0"}${probeActive ? "|Pn:P" : ""}>\r\n`);
          continue;
        }
        if (byte === 0x85 || byte === 0x9e || byte === 0x18 || char === "!" || char === "~") continue;
        buffer += char;
        if (char !== "\r") continue;
        const command = buffer.trim(); buffer = "";
        if (command === "$$") socket.write(`$21=${hardLimits ? 1 : 0}\r\nok\r\n`);
        else if (command === "$#") socket.write(`[G54:0.000,0.000,${g54z.toFixed(3)},0.000]\r\n[PRB:0.000,0.000,${probeZ.toFixed(3)}:${probeSucceeded ? 1 : 0}]\r\nok\r\n`);
        else if (command === "$G") socket.write(`[GC:G0 G54 G17 G21 ${incremental ? "G91" : "G90"} G94 M5 M9 T0 F0 S0]\r\nok\r\n`);
        else if (/^\$21=[01]$/.test(command)) { hardLimits = command.endsWith("1"); socket.write("ok\r\n"); }
        else if (command === "M5") socket.write("ok\r\n");
        else if (command === "G21 G91") { incremental = true; socket.write("ok\r\n"); }
        else if (command === "G90") { incremental = false; socket.write("ok\r\n"); }
        else if (/^G38\.3 Z-/.test(command)) {
          const distance = Math.abs(Number(command.match(/Z(-?\d+(?:\.\d+)?)/)?.[1] || 0)), target = z - distance;
          probeSucceeded = target <= contactZ;
          z = probeSucceeded ? contactZ : target; probeZ = z; probeActive = probeSucceeded;
          socket.write("ok\r\n");
        }
        else if (/^\$J=G91 G21 Z/.test(command)) { z += Number(command.match(/Z(-?\d+(?:\.\d+)?)/)?.[1] || 0); probeActive = false; jogPolls = 1; socket.write("ok\r\n"); }
        else if (/^G0 Z/.test(command)) { const value = Number(command.match(/Z(-?\d+(?:\.\d+)?)/)?.[1] || 0); z = incremental ? z + value : value; probeActive = false; socket.write("ok\r\n"); }
        else if (/^G10 L20 P1 Z/.test(command)) { const workZ = Number(command.match(/Z(-?\d+(?:\.\d+)?)/)?.[1] || 0); g54z = z - workZ; socket.write("ok\r\n"); }
        else socket.write("ok\r\n");
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    setProbe({ startZ, targetZ }) { z = startZ; contactZ = targetZ; probeSucceeded = false; probeActive = false; },
    position() { return z; },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("daemon completes new-board setup, changed-bit touch-off, and no-contact recovery without live hardware", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cnc-daemon-probe-")), socketPath = join(dir, "cnc.sock"), grbl = await makeGrbl();
  const child = spawn(process.execPath, [new URL("./cnc-daemon.mjs", import.meta.url).pathname], { cwd: new URL("../", import.meta.url).pathname, env: { ...process.env, CNC_HOST: "127.0.0.1", CNC_PORT: String(grbl.port), CNC_DAEMON_SOCKET: socketPath, CNC_LOCAL_UI_PORT: "0", CNC_PROBE_STATE: join(dir, "probe.json"), CNC_MATERIAL_STATE: join(dir, "material.json"), CNC_XY_STATE: join(dir, "xy.json"), CNC_PROGRAM_STATE: join(dir, "program.json"), CNC_RUN_STATE: join(dir, "run.json"), CNC_EVENT_JOURNAL: join(dir, "events.jsonl"), CNC_FRAME_INCIDENT: join(dir, "frame-incident.json") }, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = ""; child.stderr.on("data", (chunk) => { stderr += chunk; });
  t.after(async () => { child.kill("SIGTERM"); await new Promise((resolve) => child.once("exit", resolve)); await grbl.close(); });
  await waitFor(() => existsSync(socketPath));
  await waitFor(async () => { const h = (await unixRequest(socketPath, "/health")).value; return h.connected === true && !h.moving; });

  grbl.setProbe({ startZ: 0, targetZ: -22 });
  const bed = await unixRequest(socketPath, "/probe/bed", { thicknessMm: 12.1, maxSearchMm: 73, confirmReprobe: true });
  assert.equal(bed.status, 200, stderr);
  assert(bed.value.searchedMm >= 22);

  grbl.setProbe({ startZ: 10, targetZ: -8 });
  const stock = await unixRequest(socketPath, "/probe/stock", { thicknessMm: 12.1, maxSearchMm: 73 });
  assert.equal(stock.status, 200, stderr);
  assert.equal(stock.value.setup.probeLocked, true);
  assert.equal(stock.value.setup.materialReady, true);
  const measuredThickness = stock.value.setup.stockThicknessMm;
  assert(measuredThickness > 0);

  const zero = await unixRequest(socketPath, "/zero/xy", { confirmNewProject: true });
  assert.equal(zero.status, 200, `${stderr}\n${JSON.stringify(zero.value)}`);
  assert.equal(zero.value.probePreserved, true);
  assert.equal(zero.value.setup.probeLocked, true);
  assert.equal(zero.value.setup.stockThicknessMm, measuredThickness);

  grbl.setProbe({ startZ: 15, targetZ: -6 });
  const tool = await unixRequest(socketPath, "/probe/tool", { thicknessMm: 12.1, maxSearchMm: 73 });
  assert.equal(tool.status, 200, stderr);
  assert.equal(tool.value.setup.probeLockStatus, "locked_after_tool_touch");
  assert.equal(tool.value.setup.stockThicknessMm, measuredThickness);

  grbl.setProbe({ startZ: 20, targetZ: -1000 });
  const missed = await unixRequest(socketPath, "/probe/tool", { thicknessMm: 12.1, maxSearchMm: 25 });
  assert.equal(missed.status, 500);
  assert.match(missed.value.error, /physical 25\.0 mm search budget/);
  assert(Math.abs(grbl.position() - 20) < 0.001);
  const health = (await unixRequest(socketPath, "/health")).value;
  assert.equal(health.connected, true);
  assert.equal(health.lastControllerStatus.state, "Idle");
  assert.equal(health.setup.probePhase, "returned_no_contact");
  assert.equal(health.setup.materialReady, true);
});
