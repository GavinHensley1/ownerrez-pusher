import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const socketPath = path.join(os.tmpdir(), `cnc-daemon-offline-${process.pid}.sock`);
const probeStatePath = path.join(os.tmpdir(), `cnc-daemon-offline-probe-${process.pid}.json`);
const xyStatePath = path.join(os.tmpdir(), `cnc-daemon-offline-xy-${process.pid}.json`);
const child = spawn(process.execPath, [new URL("./cnc-daemon.mjs", import.meta.url).pathname], {
  env: {
    ...process.env,
    CNC_HOST: "127.0.0.1",
    CNC_PORT: "9",
    CNC_DAEMON_SOCKET: socketPath,
    CNC_PROBE_STATE: probeStatePath,
    CNC_XY_STATE: xyStatePath,
    CNC_CAMERA_REQUIRED: "0",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let output = "";
child.stdout.on("data", (chunk) => { output += chunk; });
child.stderr.on("data", (chunk) => { output += chunk; });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const requestHealth = () => new Promise((resolve, reject) => {
  const request = http.request({ socketPath, path: "/health", method: "GET" }, (response) => {
    let body = "";
    response.setEncoding("utf8");
    response.on("data", (chunk) => { body += chunk; });
    response.on("end", () => resolve({ status: response.statusCode, body: JSON.parse(body) }));
  });
  request.on("error", reject);
  request.end();
});

try {
  const deadline = Date.now() + 5000;
  while (!existsSync(socketPath) && Date.now() < deadline) await sleep(25);
  assert.equal(existsSync(socketPath), true, `daemon socket was not created: ${output}`);
  await sleep(1200);
  assert.equal(child.exitCode, null, `daemon exited while CNC was offline: ${output}`);
  const health = await requestHealth();
  assert.equal(health.status, 200);
  assert.equal(health.body.connected, false);
  assert.match(health.body.incident, /^CONNECT_FAILED:/);
  assert.equal(child.exitCode, null, `daemon exited after health check: ${output}`);
  process.stdout.write("PASS offline CNC remains a stable disconnected state\n");
} finally {
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
}
