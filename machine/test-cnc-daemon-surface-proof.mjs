// Live daemon tests for the plate-thickness plumbing, stale-calibration rejection,
// and the surface-contact proof gate. These drive the real daemon process against a
// simulated GRBL controller, so they prove behaviour rather than source strings.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const waitFor = async (predicate, timeoutMs = 8000) => {
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
  let z = 0, contactZ = -22, probeSucceeded = false, probeZ = 0, probeActive = false, hardLimits = true, incremental = false, g54z = 0, jogPolls = 0, g10Count = 0;
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
        if (command === "$$") socket.write(`$13=0\r\n$21=${hardLimits ? 1 : 0}\r\nok\r\n`);
        else if (command === "$#") socket.write(`[G54:0.000,0.000,${g54z.toFixed(3)},0.000]\r\n[G92:0,0,0]\r\n[TLO:0]\r\n[PRB:0.000,0.000,${probeZ.toFixed(3)}:${probeSucceeded ? 1 : 0}]\r\nok\r\n`);
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
        else if (/^G10 L20 P1 Z/.test(command)) { g10Count += 1; const workZ = Number(command.match(/Z(-?\d+(?:\.\d+)?)/)?.[1] || 0); g54z = z - workZ; socket.write("ok\r\n"); }
        else socket.write("ok\r\n");
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    setProbe({ startZ, targetZ }) { z = startZ; contactZ = targetZ; probeSucceeded = false; probeActive = false; },
    position() { return z; },
    g54() { return g54z; },
    zeroWrites() { return g10Count; },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const startDaemon = (dir, grbl, socketPath) => spawn(process.execPath, [new URL("./cnc-daemon.mjs", import.meta.url).pathname], {
  cwd: new URL("../", import.meta.url).pathname,
  env: {
    ...process.env,
    CNC_HOST: "127.0.0.1", CNC_PORT: String(grbl.port), CNC_DAEMON_SOCKET: socketPath, CNC_LOCAL_UI_PORT: "0",
    CNC_PROBE_STATE: join(dir, "probe.json"), CNC_MATERIAL_STATE: join(dir, "material.json"), CNC_XY_STATE: join(dir, "xy.json"),
    CNC_PROGRAM_STATE: join(dir, "program.json"), CNC_RUN_STATE: join(dir, "run.json"), CNC_EVENT_JOURNAL: join(dir, "events.jsonl"),
    CNC_FRAME_INCIDENT: join(dir, "frame-incident.json"), CNC_PLATE_CONFIG: join(dir, "plate.json"),
  },
  stdio: ["ignore", "pipe", "pipe"],
});

const PLATE_MM = 14.19;

test("the configured plate thickness is honoured end to end and never silently defaulted", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cnc-plate-flow-")), socketPath = join(dir, "cnc.sock"), grbl = await makeGrbl();
  const child = startDaemon(dir, grbl, socketPath);
  let stderr = ""; child.stderr.on("data", (chunk) => { stderr += chunk; });
  t.after(async () => { child.kill("SIGTERM"); await new Promise((resolve) => child.once("exit", resolve)); await grbl.close(); });
  await waitFor(() => existsSync(socketPath));
  await waitFor(async () => { const h = (await unixRequest(socketPath, "/health")).value; return h.connected === true && !h.moving; });

  // Before anything is measured, the daemon reports the default as UNCONFIRMED.
  let health = (await unixRequest(socketPath, "/health")).value;
  assert.equal(health.plate.thicknessMm, PLATE_MM);
  assert.equal(health.plate.confirmed, false, "an unmeasured default must never be presented as confirmed");
  assert.equal(health.surfaceProof.ready, false, "there must be no surface proof before one is taken");

  // A probe without a plate value must be refused outright, not defaulted.
  const noPlate = await unixRequest(socketPath, "/probe/bed", { maxSearchMm: 73, confirmReprobe: true });
  assert.equal(noPlate.status, 500);
  assert.match(noPlate.value.error, /Probe plate thickness must be supplied/);
  for (const bad of [0, "", null, 4.9, 30.1, "abc"]) {
    const rejected = await unixRequest(socketPath, "/probe/bed", { thicknessMm: bad, maxSearchMm: 73, confirmReprobe: true });
    assert.equal(rejected.status, 500, `plate ${JSON.stringify(bad)} should be refused`);
    assert.match(rejected.value.error, /Probe plate thickness must be supplied and between 5 and 30/);
  }

  // Now probe with the real measured plate and confirm the ABSOLUTE zero uses it.
  grbl.setProbe({ startZ: 0, targetZ: -22 });
  const bed = await unixRequest(socketPath, "/probe/bed", { thicknessMm: PLATE_MM, maxSearchMm: 73, confirmReprobe: true });
  assert.equal(bed.status, 200, stderr);
  // Surface = contact - plate. Contact is -22, so the bed surface must be -22 - 14.19.
  assert.equal(Math.abs(bed.value.setup.bedSurfaceMPos - (-22 - PLATE_MM)) < 1e-6, true,
    `bed surface ${bed.value.setup.bedSurfaceMPos} must equal contact minus the configured plate`);

  grbl.setProbe({ startZ: 10, targetZ: -8 });
  const stock = await unixRequest(socketPath, "/probe/stock", { thicknessMm: PLATE_MM, maxSearchMm: 73 });
  assert.equal(stock.status, 200, stderr);
  assert.equal(Math.abs(stock.value.setup.stockSurfaceMPos - (-8 - PLATE_MM)) < 1e-6, true);
  assert.equal(stock.value.setup.probeThickness, PLATE_MM);
  // The plate error cancels here, which is exactly why thickness alone cannot reveal it.
  assert.equal(Math.abs(stock.value.setup.stockThicknessMm - 14) < 1e-6, true);

  health = (await unixRequest(socketPath, "/health")).value;
  assert.equal(health.plate.thicknessMm, PLATE_MM);
  assert.equal(health.plate.confirmed, true);
  assert.equal(JSON.parse(readFileSync(join(dir, "plate.json"), "utf8")).plateThicknessMm, PLATE_MM);
  // Persisted calibration records the plate it was made with, so it can be judged later.
  assert.equal(JSON.parse(readFileSync(join(dir, "probe.json"), "utf8")).probeThickness, PLATE_MM);
});

test("surface-contact proof: a plate-free touch corroborates zero, catches a wrong plate, and never redefines zero", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cnc-surface-flow-")), socketPath = join(dir, "cnc.sock"), grbl = await makeGrbl();
  const child = startDaemon(dir, grbl, socketPath);
  let stderr = ""; child.stderr.on("data", (chunk) => { stderr += chunk; });
  t.after(async () => { child.kill("SIGTERM"); await new Promise((resolve) => child.once("exit", resolve)); await grbl.close(); });
  await waitFor(() => existsSync(socketPath));
  await waitFor(async () => { const h = (await unixRequest(socketPath, "/health")).value; return h.connected === true && !h.moving; });

  // Verification is impossible before there is a stored reference to corroborate.
  const tooEarly = await unixRequest(socketPath, "/probe/verify-surface", { method: "conductive-stock-touch" });
  assert.equal(tooEarly.status, 500);
  assert.match(tooEarly.value.error, /Probe the stock before verifying surface contact/);

  grbl.setProbe({ startZ: 0, targetZ: -22 });
  assert.equal((await unixRequest(socketPath, "/probe/bed", { thicknessMm: PLATE_MM, maxSearchMm: 73, confirmReprobe: true })).status, 200, stderr);
  grbl.setProbe({ startZ: 10, targetZ: -8 });
  const stock = await unixRequest(socketPath, "/probe/stock", { thicknessMm: PLATE_MM, maxSearchMm: 73 });
  assert.equal(stock.status, 200, stderr);
  const storedSurface = stock.value.setup.stockSurfaceMPos;

  // CASE 1 — the plate figure was right. The plate-free touch finds the SAME surface.
  // Raise the bit above the stored surface and make bare-stock contact occur there.
  grbl.setProbe({ startZ: storedSurface + 5, targetZ: storedSurface });
  const zeroWritesBefore = grbl.zeroWrites(), g54Before = grbl.g54();
  const agree = await unixRequest(socketPath, "/probe/verify-surface", { method: "conductive-stock-touch", maxSearchMm: 10 });
  assert.equal(agree.status, 200, `${stderr}\n${JSON.stringify(agree.value)}`);
  assert.equal(agree.value.surfaceProof.verified, true);
  assert.equal(Math.abs(agree.value.surfaceProof.deltaMm) < 1e-6, true);
  assert.equal(agree.value.surfaceProof.method, "conductive-stock-touch");
  // CRITICAL: verification must measure, never redefine. No G10 and no G54 change.
  assert.equal(grbl.zeroWrites(), zeroWritesBefore, "the verification touch must not emit G10");
  assert.equal(grbl.g54(), g54Before, "the verification touch must not move the work origin");
  let health = (await unixRequest(socketPath, "/health")).value;
  assert.equal(health.surfaceProof.ready, true);

  // CASE 2 — THE INCIDENT. The stored zero is ~5.81 mm too low (a 20 mm plate was
  // used when the plate is 14.19 mm), so the true surface is 5.81 mm ABOVE the
  // stored one. The plate-free touch must find that and refuse to verify.
  const trueSurface = storedSurface + 5.81;
  grbl.setProbe({ startZ: trueSurface + 5, targetZ: trueSurface });
  const disagree = await unixRequest(socketPath, "/probe/verify-surface", { method: "conductive-stock-touch", maxSearchMm: 10 });
  assert.equal(disagree.status, 200, stderr);
  assert.equal(disagree.value.surfaceProof.verified, false, "a 5.81 mm disagreement must not verify");
  assert.equal(Math.abs(disagree.value.surfaceProof.deltaMm - 5.81) < 1e-3, true);
  health = (await unixRequest(socketPath, "/health")).value;
  assert.equal(health.surfaceProof.ready, false, "an unverified proof must leave the gate closed");

  // CASE 3 — a successful proof is invalidated by re-probing, because the Z
  // reference it corroborated has been replaced.
  grbl.setProbe({ startZ: storedSurface + 5, targetZ: storedSurface });
  assert.equal((await unixRequest(socketPath, "/probe/verify-surface", { method: "conductive-stock-touch", maxSearchMm: 10 })).value.surfaceProof.verified, true);
  assert.equal((await unixRequest(socketPath, "/health")).value.surfaceProof.ready, true);
  grbl.setProbe({ startZ: 15, targetZ: -6 });
  assert.equal((await unixRequest(socketPath, "/probe/tool", { thicknessMm: PLATE_MM, maxSearchMm: 73 })).status, 200, stderr);
  health = (await unixRequest(socketPath, "/health")).value;
  assert.equal(health.surfaceProof.ready, false, "a new probe must invalidate the previous surface proof");
  assert.equal(health.surfaceProof.proof, null);

  // CASE 4 — changing the plate thickness invalidates a proof taken under the old one.
  grbl.setProbe({ startZ: health.setup.stockSurfaceMPos + 5, targetZ: health.setup.stockSurfaceMPos });
  assert.equal((await unixRequest(socketPath, "/probe/verify-surface", { method: "conductive-stock-touch", maxSearchMm: 10 })).value.surfaceProof.verified, true);
  assert.equal((await unixRequest(socketPath, "/probe/plate", { thicknessMm: 14.0 })).status, 200);
  health = (await unixRequest(socketPath, "/health")).value;
  assert.equal(health.plate.thicknessMm, 14.0);
  assert.equal(health.surfaceProof.ready, false, "a plate change must invalidate the surface proof");
});

test("a calibration captured with a different plate is REJECTED, not migrated, and its X/Y origin survives", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cnc-stale-cal-")), socketPath = join(dir, "cnc.sock"), grbl = await makeGrbl();

  // A stale lock that is otherwise FULLY CONTINUOUS with the controller: its
  // lastKnownMPos Z and G54 Z both match the simulated controller, so the saved
  // frame passes the continuity check and the ONLY thing left that can reject it is
  // the plate mismatch. That is what makes this a real test of requirement 3 rather
  // than of the pre-existing coordinate check. Stock thickness 3.855 mm is the real
  // measured value from the incident, and it looks perfectly plausible because the
  // plate error cancels out of bed-minus-stock.
  writeFileSync(join(dir, "probe.json"), JSON.stringify({
    version: 1, locked: true, probeThickness: 20,
    bedSurfaceMPos: -3.855, stockSurfaceMPos: 0, stockThicknessMm: 3.855,
    safetyFloorMm: 0.8, maxCutDepthMm: 3.055, zOriginMPos: 0,
    lastKnownMPos: { X: 0, Y: 0, Z: 0 },
    capturedAt: new Date().toISOString(), lockedAt: new Date().toISOString(),
    source: "stale 20 mm plate calibration",
  }));
  // X/Y handling must keep working exactly as it already does: continuous X/Y is
  // restored even while the Z calibration is refused.
  writeFileSync(join(dir, "xy.json"), JSON.stringify({
    version: 1, locked: true, xyOriginMPos: { X: 0, Y: 0 }, lastKnownMPos: { X: 0, Y: 0 },
    lockedAt: new Date().toISOString(), source: "Project guarded front-left X/Y origin",
  }));
  // The configured plate is the corrected 14.19 mm.
  writeFileSync(join(dir, "plate.json"), JSON.stringify({ version: 1, plateThicknessMm: PLATE_MM, updatedAt: new Date().toISOString(), source: "operator measured" }));

  const child = startDaemon(dir, grbl, socketPath);
  let stderr = ""; child.stderr.on("data", (chunk) => { stderr += chunk; });
  t.after(async () => { child.kill("SIGTERM"); await new Promise((resolve) => child.once("exit", resolve)); await grbl.close(); });
  await waitFor(() => existsSync(socketPath));
  await waitFor(async () => { const h = (await unixRequest(socketPath, "/health")).value; return h.connected === true; });

  const health = (await unixRequest(socketPath, "/health")).value;
  assert.equal(health.plate.thicknessMm, PLATE_MM, "the configured plate must come from its own file, not from the stale calibration");
  assert.equal(health.setup.probeLocked, false, "a calibration made with a different plate must not be restored");
  assert.match(String(health.setup.probeLockStatus), /^rejected: /);
  assert.match(String(health.setup.probeLockStatus), /20\.00 mm probe plate but 14\.19 mm is configured/);
  assert.match(String(health.setup.probeLockStatus), /cannot be converted/);
  // Rejected, never migrated: none of the stale absolute Z numbers may be adopted.
  assert.equal(health.setup.stockSurfaceMPos, null);
  assert.equal(health.setup.bedSurfaceMPos, null);
  assert.equal(health.setup.zOriginMPos, null);
  assert.equal(health.setup.probeReady, false);
  assert.equal(health.setup.stockProbeReady, false);
  // X/Y origin handling is untouched: continuous X/Y is still restored.
  assert.equal(health.setup.xyReady, true, "rejecting the Z calibration must not discard a continuous X/Y origin");
  assert.equal(health.setup.xyOriginMPos.X, 0);
  assert.equal(health.setup.xyOriginMPos.Y, 0);
  // And with no Z calibration there can be no surface proof, so Start stays shut.
  assert.equal(health.surfaceProof.ready, false);
  assert.equal(stderr.includes("Error: Cannot"), false, stderr.slice(0, 400));
});
