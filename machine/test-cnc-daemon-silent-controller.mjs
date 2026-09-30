import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const socketPath = path.join(os.tmpdir(), `cnc-daemon-silent-${process.pid}.sock`);
const silentSockets = new Set();
const silent = net.createServer((socket) => {
  silentSockets.add(socket);
  socket.once("close", () => silentSockets.delete(socket));
});
await new Promise((resolve) => silent.listen(0, "127.0.0.1", resolve));

const child = spawn(process.execPath, [new URL("./cnc-daemon.mjs", import.meta.url).pathname], {
  env: {
    ...process.env,
    CNC_HOST: "127.0.0.1",
    CNC_PORT: String(silent.address().port),
    CNC_STATUS_TIMEOUT_MS: "25",
    CNC_DAEMON_SOCKET: socketPath,
    CNC_LOCAL_UI_PORT: "0",
    CNC_PROBE_STATE: path.join(os.tmpdir(), `cnc-silent-probe-${process.pid}.json`),
    CNC_MATERIAL_STATE: path.join(os.tmpdir(), `cnc-silent-material-${process.pid}.json`),
    CNC_XY_STATE: path.join(os.tmpdir(), `cnc-silent-xy-${process.pid}.json`),
    CNC_PROGRAM_STATE: path.join(os.tmpdir(), `cnc-silent-program-${process.pid}.json`),
    CNC_RUN_STATE: path.join(os.tmpdir(), `cnc-silent-run-${process.pid}.json`),
    CNC_EVENT_JOURNAL: path.join(os.tmpdir(), `cnc-silent-events-${process.pid}.jsonl`),
    CNC_FRAME_INCIDENT: path.join(os.tmpdir(), `cnc-silent-frame-${process.pid}.json`),
  },
  stdio: ["ignore", "pipe", "pipe"],
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const requestHealth = () => new Promise((resolve, reject) => {
  const started = Date.now();
  const request = http.request({ socketPath, path: "/health", method: "GET" }, (response) => {
    let body = "";
    response.setEncoding("utf8");
    response.on("data", (chunk) => { body += chunk; });
    response.on("end", () => resolve({ elapsedMs: Date.now() - started, status: response.statusCode, body: JSON.parse(body) }));
  });
  request.setTimeout(1000, () => request.destroy(new Error("health request blocked on silent controller")));
  request.on("error", reject);
  request.end();
});

try {
  const deadline = Date.now() + 5000;
  while (!existsSync(socketPath) && Date.now() < deadline) await sleep(25);
  assert.equal(existsSync(socketPath), true);
  const health = await requestHealth();
  assert.equal(health.status, 200);
  assert(health.elapsedMs < 1000, `health took ${health.elapsedMs} ms`);
  assert.equal(health.body.moving && !health.body.reconnecting, false, "Only startup verification may own the operation guard; no machine motion is allowed");
  assert.equal(health.body.workspace.calibrated, false);
  process.stdout.write("PASS health remains nonblocking when the GRBL Wi-Fi socket accepts but never answers\n");
} finally {
  if (child.exitCode === null) {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    await exited;
  }
  for (const socket of silentSockets) socket.destroy();
  await new Promise((resolve) => silent.close(resolve));
}
