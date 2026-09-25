import http from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, openSync, closeSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { cameraFresh, consumeDiagnosticChunk, createDiagnostics, selectAnalyzedCandidate } from "./cnc-camera-diagnostics.mjs";

const HOST = "127.0.0.1";
const PORT = Number(process.env.CNC_CAMERA_PORT || 47831);
const CLIENT_ROOT = process.env.EUFY_CLIENT_ROOT || "/Users/gavinsclaude/.openclaw/tools/eufy-security-client";
const DIRECT_KEYCHAIN_SERVICE = process.env.CNC_CAMERA_KEYCHAIN_SERVICE || "com.openclaw.cnc-camera.eufy";
const OP_TOKEN_SERVICE = process.env.CNC_CAMERA_OP_TOKEN_SERVICE || "com.openclaw.1password.service-account";
const OP_TOKEN_ACCOUNT = process.env.CNC_CAMERA_OP_TOKEN_ACCOUNT || "token";
const OP_USERNAME_REF = process.env.CNC_CAMERA_OP_USERNAME_REF || "";
const OP_PASSWORD_REF = process.env.CNC_CAMERA_OP_PASSWORD_REF || "";
const PERSISTENT_DIR = `${CLIENT_ROOT}/state`;
const PIN_PATH = `${PERSISTENT_DIR}/cnc-camera-serial`;
const RUN_DIR = process.env.CNC_CAMERA_RUN_DIR || "/Users/gavinsclaude/.openclaw/run/cnc-camera";
const FRAME_PATH = path.join(RUN_DIR, "latest.jpg");
const FFMPEG = process.env.FFMPEG_PATH || "/opt/homebrew/bin/ffmpeg";
const OP = process.env.OP_PATH || "/opt/homebrew/bin/op";
const KEYCHAIN_HELPER = process.env.CNC_CAMERA_KEYCHAIN_HELPER || "/Users/gavinsclaude/.openclaw/tools/cnc-keychain-helper";
const TARGET_FPS = Number(process.env.CNC_CAMERA_FPS || 1);
const MAX_FRAME_AGE_MS = 3000;

const eufy = await import(pathToFileURL(`${CLIENT_ROOT}/node_modules/eufy-security-client/build/index.js`).href);
const { EufySecurity, P2PConnectionType, PanTiltDirection, CommandName, VideoCodec } = eufy;

let client, device, station, videoStream, decoder;
let state = "starting", detail = "", lastFrameAt = 0, lastFrameMonotonic = 0, restartTimer, framePoll;
let softwareDecode = false, desiredRunning = true, shuttingDown = false, generation = 0;
let diagnostics = createDiagnostics();
let connectionEpoch = 0, connecting = false, connectionTimer;

const ensurePrivateDirectory = (dir) => {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const info = lstatSync(dir);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid()) throw new Error(`UNSAFE_CAMERA_DIRECTORY:${dir}`);
  chmodSync(dir, 0o700);
};
ensurePrivateDirectory(PERSISTENT_DIR);
ensurePrivateDirectory(RUN_DIR);

const stripCommandNewline = (value) => String(value).replace(/\r?\n$/, "");
const keychainRead = (service, account) => stripCommandNewline(execFileSync(
  existsSync(KEYCHAIN_HELPER) ? KEYCHAIN_HELPER : "/usr/bin/security",
  existsSync(KEYCHAIN_HELPER)
    ? ["get", service, account]
    : ["find-generic-password", "-s", service, "-a", account, "-w"],
  { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 },
));

const opRead = (ref, token) => stripCommandNewline(execFileSync(OP, ["read", ref, "--no-newline"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "ignore"],
  timeout: 5_000,
  env: {
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    PATH: process.env.PATH || "/usr/bin:/bin:/opt/homebrew/bin",
    OP_SERVICE_ACCOUNT_TOKEN: token,
  },
}));

const credentials = () => {
  let serviceAccountFailed = false;
  try {
    if (OP_USERNAME_REF && OP_PASSWORD_REF) {
      const token = keychainRead(OP_TOKEN_SERVICE, OP_TOKEN_ACCOUNT);
      const username = opRead(OP_USERNAME_REF, token);
      const password = opRead(OP_PASSWORD_REF, token);
      if (!username || !password) throw new Error("empty service-account result");
      return { username, password, source: "1password-service-account" };
    }
  } catch {
    serviceAccountFailed = true;
  }
  try {
    const username = keychainRead(DIRECT_KEYCHAIN_SERVICE, "username");
    const password = keychainRead(DIRECT_KEYCHAIN_SERVICE, "password");
    if (!username || !password) throw new Error("empty Keychain result");
    return { username, password, source: serviceAccountFailed ? "macos-keychain-cache" : "macos-keychain" };
  } catch {
    state = "awaiting_credentials";
    detail = serviceAccountFailed
      ? "1Password service account unavailable and no cached camera credentials"
      : `Missing macOS Keychain items for ${DIRECT_KEYCHAIN_SERVICE}`;
    return null;
  }
};

const stopDecoder = () => {
  if (framePoll) clearInterval(framePoll);
  framePoll = undefined;
  try { videoStream?.unpipe(decoder?.stdin); } catch {}
  try { decoder?.stdin?.destroy(); } catch {}
  try { decoder?.kill("SIGTERM"); } catch {}
  videoStream = undefined;
  decoder = undefined;
};

const scheduleStreamRestart = (reason, ownedGeneration = generation) => {
  if (!desiredRunning || shuttingDown || ownedGeneration !== generation || restartTimer) return;
  state = "restarting";
  detail = reason;
  stopDecoder();
  try { if (station && device) station.stopLivestream(device); } catch {}
  restartTimer = setTimeout(() => {
    restartTimer = undefined;
    if (!desiredRunning || shuttingDown || ownedGeneration !== generation) return;
    try { station.startLivestream(device); }
    catch (error) { scheduleStreamRestart(`STREAM_RESTART_FAILED:${error?.message || "Error"}`, ownedGeneration); }
  }, 2000);
};

const validJpeg = (file) => {
  const info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || info.size < 100) return null;
  const data = readFileSync(file);
  if (data[0] !== 0xff || data[1] !== 0xd8 || data.at(-2) !== 0xff || data.at(-1) !== 0xd9) return null;
  return data;
};

const publishFrames = (ownedGeneration, generationDir, ownedDiagnostics) => {
  let lastSequence = 0;
  framePoll = setInterval(() => {
    if (ownedGeneration !== generation || !desiredRunning) return;
    const candidates = readdirSync(generationDir)
      .map((name) => ({ name, match: name.match(/^frame-(\d+)\.jpg$/) }))
      .filter((entry) => entry.match)
      .map((entry) => ({ name: entry.name, sequence: Number(entry.match[1]) }))
      .filter((entry) => entry.sequence > lastSequence)
      .sort((a, b) => a.sequence - b.sequence);
    const candidate = selectAnalyzedCandidate(candidates, ownedDiagnostics);
    if (!candidate) return;
    const analyzedFrame = candidate.sequence;
    const source = path.join(generationDir, candidate.name);
    try {
      const sourceProducedAt = statSync(source).mtimeMs;
      const sourceAge = Date.now() - sourceProducedAt;
      if (sourceAge < 0 || sourceAge > MAX_FRAME_AGE_MS) throw new Error(`STALE_SOURCE_FRAME:${sourceAge}`);
      const data = validJpeg(source);
      if (!data) return;
      ownedDiagnostics.black = ownedDiagnostics.blackFrames.includes(analyzedFrame);
      ownedDiagnostics.validated = true;
      const temp = `${FRAME_PATH}.tmp-${process.pid}`;
      try { unlinkSync(temp); } catch {}
      writeFileSync(temp, data, { mode: 0o600, flag: "wx" });
      if (lstatSync(temp).isSymbolicLink()) throw new Error("unsafe temporary frame");
      if (readdirSync(RUN_DIR).includes("latest.jpg")) {
        const current = lstatSync(FRAME_PATH);
        if (!current.isFile() || current.isSymbolicLink() || current.uid !== process.getuid()) throw new Error("unsafe latest frame");
      }
      renameSync(temp, FRAME_PATH);
      lastFrameAt = sourceProducedAt;
      lastFrameMonotonic = performance.now() - sourceAge;
      state = "ready";
      detail = softwareDecode ? "LOCAL_P2P_SOFTWARE_DECODE" : "LOCAL_P2P_VIDEOTOOLBOX";
      lastSequence = candidate.sequence;
      for (const stale of candidates.filter((entry) => entry.sequence <= candidate.sequence)) {
        try { unlinkSync(path.join(generationDir, stale.name)); } catch {}
      }
    } catch (error) {
      state = "error";
      detail = `FRAME_PUBLISH_FAILED:${error?.message || "Error"}`;
    }
  }, 250);
  framePoll.unref();
};

const startDecoder = (metadata, stream) => {
  const codec = metadata?.videoCodec === VideoCodec.H265 ? "hevc" : metadata?.videoCodec === VideoCodec.H264 ? "h264" : null;
  if (!codec) return scheduleStreamRestart(`UNSUPPORTED_CODEC:${metadata?.videoCodec}`);
  generation += 1;
  const ownedGeneration = generation;
  stopDecoder();
  const generationDir = path.join(RUN_DIR, `generation-${process.pid}-${ownedGeneration}`);
  ensurePrivateDirectory(generationDir);
  const ownedDiagnostics = createDiagnostics();
  diagnostics = ownedDiagnostics;
  lastFrameAt = 0;
  lastFrameMonotonic = 0;
  videoStream = stream;
  const args = ["-hide_banner", "-loglevel", "info"];
  if (!softwareDecode) args.push("-hwaccel", "videotoolbox");
  args.push(
    "-f", codec, "-i", "pipe:0", "-an",
    "-vf", `scale=640:-2:flags=fast_bilinear,fps=${TARGET_FPS},blackframe=amount=98:threshold=32,showinfo,scdet=t=10`,
    "-q:v", "5", path.join(generationDir, "frame-%08d.jpg"),
  );
  const child = spawn(FFMPEG, args, { stdio: ["pipe", "ignore", "pipe"] });
  decoder = child;
  stream.pipe(child.stdin);
  let stderrBuffer = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    if (ownedGeneration === generation) stderrBuffer = consumeDiagnosticChunk(ownedDiagnostics, stderrBuffer, chunk);
  });
  const controlledError = (label, error) => {
    if (ownedGeneration === generation) scheduleStreamRestart(`${label}:${error?.message || "Error"}`, ownedGeneration);
  };
  child.on("error", (error) => controlledError("DECODER_ERROR", error));
  child.stdin.on("error", (error) => controlledError("DECODER_STDIN_ERROR", error));
  stream.on("error", (error) => controlledError("CAMERA_STREAM_ERROR", error));
  publishFrames(ownedGeneration, generationDir, ownedDiagnostics);
  child.on("close", (code) => {
    if (ownedGeneration !== generation || !desiredRunning || shuttingDown) return;
    if (code && !softwareDecode) {
      softwareDecode = true;
      return scheduleStreamRestart("VIDEOTOOLBOX_FAILED_USING_SOFTWARE", ownedGeneration);
    }
    scheduleStreamRestart(`DECODER_EXIT:${code ?? "signal"}`, ownedGeneration);
  });
};

const pinnedDevice = (devices) => {
  const cameras = devices.filter((entry) => entry.isIndoorPanAndTiltCameraS350());
  let serial;
  try { serial = stripCommandNewline(readFileSync(PIN_PATH, "utf8")); } catch {}
  if (serial) return cameras.find((entry) => entry.getSerial() === serial);
  if (cameras.length !== 1) throw new Error(`CAMERA_PIN_REQUIRED:found=${cameras.length}`);
  serial = cameras[0].getSerial();
  const fd = openSync(PIN_PATH, "wx", 0o600);
  try { writeFileSync(fd, serial, { encoding: "utf8" }); }
  finally { closeSync(fd); }
  return cameras[0];
};

const resetClient = () => {
  connectionEpoch += 1;
  connecting = false;
  if (connectionTimer) clearTimeout(connectionTimer);
  connectionTimer = undefined;
  try { client?.close(); } catch {}
  client = undefined;
  station = undefined;
  device = undefined;
};

const connect = async () => {
  if (connecting) return;
  const auth = credentials();
  if (!auth) return;
  connecting = true;
  const ownedEpoch = ++connectionEpoch;
  desiredRunning = true;
  state = "connecting";
  detail = "";
  let ownedClient;
  try {
    ownedClient = await EufySecurity.initialize({
      username: auth.username,
      password: auth.password,
      country: "US",
      language: "en",
      trustedDeviceName: "Boxer CNC camera monitor",
      persistentDir: PERSISTENT_DIR,
      p2pConnectionSetup: P2PConnectionType.ONLY_LOCAL,
      pollingIntervalMinutes: 10,
      eventDurationSeconds: 10,
      acceptInvitations: false,
    });
  } catch (error) {
    if (ownedEpoch === connectionEpoch) {
      state = "error";
      detail = `EUFY_INITIALIZE_FAILED:${error?.message || "Error"}`;
      resetClient();
    }
    return;
  }
  if (ownedEpoch !== connectionEpoch || !desiredRunning) { try { ownedClient.close(); } catch {} return; }
  client = ownedClient;
  auth.username = "";
  auth.password = "";
  ownedClient.on("tfa request", () => { if (ownedEpoch === connectionEpoch) { state = "blocked"; detail = "EUFY_TFA_REQUIRED"; connecting = false; } });
  ownedClient.on("captcha request", () => { if (ownedEpoch === connectionEpoch) { state = "blocked"; detail = "EUFY_CAPTCHA_REQUIRED"; connecting = false; } });
  ownedClient.on("connection error", (error) => { if (ownedEpoch === connectionEpoch) { state = "error"; detail = `EUFY_CONNECTION_ERROR:${error?.name || "Error"}`; connecting = false; } });
  ownedClient.on("station connection error", (_station, error) => { if (ownedEpoch === connectionEpoch) scheduleStreamRestart(`EUFY_P2P_ERROR:${error?.name || "Error"}`); });
  ownedClient.on("station livestream start", (_station, startedDevice, metadata, stream) => {
    if (ownedEpoch !== connectionEpoch) return;
    if (desiredRunning && startedDevice.getSerial() === device?.getSerial()) startDecoder(metadata, stream);
  });
  ownedClient.on("connect", async () => {
    try {
      if (ownedEpoch !== connectionEpoch || !desiredRunning) return;
      const selectedDevice = pinnedDevice(await ownedClient.getDevices());
      if (ownedEpoch !== connectionEpoch || !desiredRunning) return;
      if (!selectedDevice) throw new Error("PINNED_EUFY_S350_NOT_FOUND");
      const selectedStation = await ownedClient.getStation(selectedDevice.getStationSerial());
      if (ownedEpoch !== connectionEpoch || !desiredRunning) return;
      if (!selectedStation.isConnected()) await ownedClient.connectToStation(selectedStation.getSerial(), P2PConnectionType.ONLY_LOCAL);
      if (ownedEpoch !== connectionEpoch || !desiredRunning) return;
      device = selectedDevice;
      station = selectedStation;
      station.startLivestream(device);
      state = "streaming";
      detail = `WAITING_FOR_FIRST_FRAME:${auth.source}`;
      connecting = false;
      if (connectionTimer) clearTimeout(connectionTimer);
      connectionTimer = undefined;
    } catch (error) {
      if (ownedEpoch === connectionEpoch) {
        state = "error";
        detail = error?.message || "EUFY_RUNTIME_ERROR";
        resetClient();
      }
    }
  });
  connectionTimer = setTimeout(() => {
    if (ownedEpoch !== connectionEpoch || !connecting) return;
    state = "error";
    detail = "EUFY_CONNECT_TIMEOUT";
    resetClient();
  }, 20_000);
  connectionTimer.unref();
  try { await ownedClient.connect({ force: false }); }
  catch (error) {
    if (ownedEpoch === connectionEpoch) {
      state = "error";
      detail = `EUFY_CONNECT_FAILED:${error?.message || "Error"}`;
      resetClient();
    }
  }
};

const snapshot = () => {
  const frameAgeMs = lastFrameMonotonic ? performance.now() - lastFrameMonotonic : null;
  return {
    state,
    detail,
    monitoring: Boolean(decoder),
    lastFrameAt,
    frameAgeMs,
    fresh: cameraFresh({ state, monitoring: Boolean(decoder), lastFrameAt, frameAgeMs, diagnostics }),
    diagnostics: { ...diagnostics },
    frame: FRAME_PATH,
  };
};

const move = (direction) => {
  if (!snapshot().fresh || !station || !device) throw new Error("CAMERA_NOT_READY");
  const mapped = { left: PanTiltDirection.LEFT, right: PanTiltDirection.RIGHT, up: PanTiltDirection.UP, down: PanTiltDirection.DOWN }[direction];
  if (mapped === undefined || !device.hasCommand(CommandName.DevicePanAndTilt)) throw new Error("BAD_DIRECTION");
  station.panAndTilt(device, mapped, 1);
};

const send = (res, statusCode, body) => {
  res.writeHead(statusCode, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};
const trustedMutation = (req) => !req.headers.origin && new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]).has(req.headers.host);

const server = http.createServer((req, res) => {
  try {
    if (req.method === "GET" && req.url === "/status") return send(res, 200, snapshot());
    if (req.method === "POST" && !trustedMutation(req)) return send(res, 403, { ok: false, error: "Untrusted request" });
    if (req.method === "POST" && req.url === "/monitor/start") {
      desiredRunning = true;
      if (!client || !station || !device) {
        if (!connecting) { resetClient(); connect().catch((error) => { state = "error"; detail = error?.message || "CONNECT_FAILED"; }); }
      } else if (!decoder) station.startLivestream(device);
      return send(res, 200, { ok: true });
    }
    if (req.method === "POST" && req.url === "/monitor/stop") {
      desiredRunning = false;
      generation += 1;
      if (restartTimer) clearTimeout(restartTimer);
      restartTimer = undefined;
      stopDecoder();
      try { station?.stopLivestream(device); } catch {}
      resetClient();
      state = "stopped";
      detail = "STOPPED_BY_REQUEST";
      return send(res, 200, { ok: true });
    }
    if (req.method === "POST" && req.url === "/frame") return send(res, 200, { ok: snapshot().fresh, path: FRAME_PATH, lastFrameAt });
    if (req.method === "POST" && req.url?.startsWith("/ptz/")) {
      move(req.url.split("/").pop());
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { ok: false, error: "Not found" });
  } catch (error) {
    return send(res, 500, { ok: false, error: error?.message || "Error" });
  }
});

server.listen(PORT, HOST, () => {
  process.stdout.write(JSON.stringify({ event: "CNC_CAMERA_MONITOR_READY", url: `http://${HOST}:${PORT}` }) + "\n");
  connect().catch((error) => { state = "error"; detail = error?.message || "CONNECT_FAILED"; });
});

const shutdown = () => {
  shuttingDown = true;
  desiredRunning = false;
  generation += 1;
  connectionEpoch += 1;
  if (restartTimer) clearTimeout(restartTimer);
  stopDecoder();
  try { station?.stopLivestream(device); } catch {}
  try { client?.close(); } catch {}
  server.close(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
