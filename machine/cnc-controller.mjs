import net from "node:net";
import { EventEmitter } from "node:events";
import { analyzeProgram } from "./cnc-program.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const now = () => Date.now();

export class GrblTcpController extends EventEmitter {
  constructor({ host, port = 10086, connectTimeoutMs = 5000, statusTimeoutMs = 800, commandTimeoutMs = 4000, motionGuard, workspaceGuard, programGuard, maxJogMm = 25, maxJogFeed = 500, maxSessionTravelMm = 2000, maxSpindleTestRpm = 2000, maxSpindleTestMs = 5000 } = {}) {
    super();
    if (!host) throw new Error("CNC host is required");
    Object.assign(this, { host, port, connectTimeoutMs, statusTimeoutMs, commandTimeoutMs, motionGuard, workspaceGuard, programGuard, maxJogMm, maxJogFeed, maxSessionTravelMm, maxSpindleTestRpm, maxSpindleTestMs });
    this.sessionTravelMm = 0;
    this.socket = undefined;
    this.socketGeneration = 0;
    this.connectionState = "disconnected";
    this.connectPromise = undefined;
    this.fault = undefined;
    this.buffer = "";
    this.statusWaiter = undefined;
    this.lineWaiter = undefined;
    this.queue = Promise.resolve();
    this.programRunning = false;
    this.pauseRequested = false;
    this.abortRequested = false;
  }

  get connected() {
    return this.connectionState === "connected" && Boolean(this.socket && !this.socket.destroyed);
  }

  async connect() {
    if (this.fault) throw new Error(`Controller fault is latched: ${this.fault.message}`);
    if (this.connected) return;
    if (this.connectionState === "connecting" && this.connectPromise) return this.connectPromise;
    const generation = ++this.socketGeneration;
    const socket = net.createConnection({ host: this.host, port: this.port });
    this.socket = socket;
    this.buffer = "";
    this.connectionState = "connecting";
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 2000);
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => this.#onData(generation, chunk));
    socket.on("error", (error) => {
      if (generation === this.socketGeneration && this.connectionState === "connected") this.#latchFault(error, true);
    });
    socket.on("close", () => {
      if (generation !== this.socketGeneration) return;
      const intentional = this.connectionState === "closing";
      this.socket = undefined;
      this.connectionState = intentional ? "disconnected" : "fault";
      if (!intentional && !this.fault) this.fault = new Error("CNC socket closed unexpectedly");
      this.#rejectWaiters(this.fault || new Error("CNC socket closed"));
      this.emit("close");
    });
    this.connectPromise = new Promise((resolve, reject) => {
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (generation === this.socketGeneration) this.#latchFault(error, true);
        reject(error);
      };
      const timer = setTimeout(() => fail(new Error("CNC connect timeout")), this.connectTimeoutMs);
      socket.once("connect", () => {
        if (settled || generation !== this.socketGeneration || socket !== this.socket) return;
        settled = true;
        clearTimeout(timer);
        this.connectionState = "connected";
        this.connectPromise = undefined;
        this.emit("connect");
        resolve();
      });
      socket.once("error", fail);
    });
    return this.connectPromise;
  }

  status(options = {}) { return this.#enqueue(() => this.#statusUnlocked(options)); }

  query(command) {
    const allowed = new Set(["$G", "$$", "$I", "$#", "$N"]);
    if (!allowed.has(command)) return Promise.reject(new Error(`Read-only query not allowed: ${command}`));
    return this.#enqueue(() => this.#lineCommandUnlocked(command, false));
  }

  setBooleanSetting(setting, enabled) {
    const allowed = new Set([20, 22]);
    if (!allowed.has(Number(setting))) return Promise.reject(new Error(`Setting $${setting} is not allowed through this controller`));
    return this.#enqueue(() => this.#lineCommandUnlocked(`$${Number(setting)}=${enabled ? 1 : 0}`, false));
  }

  setWorkOffset({ x, y, z }) {
    const values = { X: x, Y: y, Z: z };
    const words = Object.entries(values).filter(([, value]) => value !== undefined).map(([axis, value]) => {
      const number = Number(value);
      if (!Number.isFinite(number)) throw new Error(`Invalid ${axis} work offset`);
      return `${axis}${number.toFixed(3)}`;
    });
    if (!words.length) return Promise.reject(new Error("At least one work-offset axis is required"));
    return this.#enqueue(() => this.#lineCommandUnlocked(`G10 L20 P1 ${words.join(" ")}`, false));
  }

  jog(axis, distanceMm, feedMmPerMin, { calibration = false } = {}) {
    return this.#enqueue(async () => {
      if (typeof this.motionGuard !== "function") throw new Error("Motion guard is required for jogging");
      const normalizedAxis = String(axis).toUpperCase();
      if (!new Set(["X", "Y", "Z"]).has(normalizedAxis)) throw new Error(`Unsupported jog axis: ${axis}`);
      const formattedDistance = Number(distanceMm).toFixed(3);
      const formattedFeed = Number(feedMmPerMin).toFixed(0);
      const distance = Number(formattedDistance);
      const feed = Number(formattedFeed);
      if (!Number.isFinite(distance) || distance === 0 || Math.abs(distance) > this.maxJogMm) throw new Error(`Jog distance must round to non-zero and be no more than ${this.maxJogMm} mm`);
      if (!Number.isFinite(feed) || feed < 1 || feed > this.maxJogFeed) throw new Error(`Jog feed must round to 1-${this.maxJogFeed} mm/min`);
      if (this.sessionTravelMm + Math.abs(distance) > this.maxSessionTravelMm) throw new Error(`Session jog envelope of ${this.maxSessionTravelMm} mm would be exceeded`);
      await this.motionGuard();
      const before = parseStatus(await this.#statusUnlocked({ attempts: 5 }));
      if (before.state !== "Idle") throw new Error(`Controller must be Idle, got ${before.state}`);
      const [currentFeed, spindle] = String(before.FS || "0,0").split(",").map(Number);
      if (currentFeed !== 0 || spindle !== 0) throw new Error(`Non-zero feed/spindle before jog: ${before.FS}`);
      if (before.Pn) throw new Error(`Active input pins before jog: ${before.Pn}`);
      const beforeCoordinate = coordinateAxis(before, normalizedAxis);
      if (!calibration) {
        if (typeof this.workspaceGuard !== "function") throw new Error("Virtual workspace is not calibrated");
        await this.workspaceGuard({ before, axis: normalizedAxis, distanceMm: distance });
      }
      const reply = await this.#lineCommandUnlocked(`$J=G91 G21 ${normalizedAxis}${formattedDistance} F${formattedFeed}`, true);
      const expectedMs = (Math.abs(distance) / feed) * 60_000;
      const deadline = now() + Math.min(30_000, Math.max(5_000, expectedMs * 3 + 3_000));
      const samples = [];
      while (now() < deadline) {
        try { await this.motionGuard(); }
        catch (error) { await this.#emergencyStop(`CAMERA_GUARD_FAILED:${error.message}`); throw this.fault; }
        const status = parseStatus(await this.#statusUnlocked({ attempts: 3 }));
        samples.push(status.raw);
        if (status.state === "Idle") {
          const delta = coordinateAxis(status, normalizedAxis) - beforeCoordinate;
          if (Math.sign(delta) !== Math.sign(distance) || Math.abs(Math.abs(delta) - Math.abs(distance)) > 0.75) {
            await this.#emergencyStop(`JOG_DELTA_MISMATCH:expected=${distance},actual=${delta}`);
            throw this.fault;
          }
          await this.motionGuard();
          this.sessionTravelMm += Math.abs(distance);
          return { axis: normalizedAxis, before, reply, after: status, deltaMm: delta, samples };
        }
        if (!(status.state === "Jog" || status.state === "Run")) {
          await this.#emergencyStop(`UNEXPECTED_MOTION_STATE:${status.raw}`);
          throw this.fault;
        }
        await sleep(200);
      }
      await this.#emergencyStop("JOG_COMPLETION_TIMEOUT");
      throw this.fault;
    });
  }

  jogX(distanceMm, feedMmPerMin, options) { return this.jog("X", distanceMm, feedMmPerMin, options); }

  spindleTest(rpm, durationMs) {
    return this.#enqueue(async () => {
      if (typeof this.motionGuard !== "function") throw new Error("Motion guard is required for spindle tests");
      const speed = Math.round(Number(rpm));
      const duration = Math.round(Number(durationMs));
      if (!Number.isFinite(speed) || speed < 1 || speed > this.maxSpindleTestRpm) throw new Error(`Spindle test RPM must be 1-${this.maxSpindleTestRpm}`);
      if (!Number.isFinite(duration) || duration < 250 || duration > this.maxSpindleTestMs) throw new Error(`Spindle test duration must be 250-${this.maxSpindleTestMs} ms`);

      await this.motionGuard();
      const before = parseStatus(await this.#statusUnlocked({ attempts: 5 }));
      if (before.state !== "Idle") throw new Error(`Controller must be Idle, got ${before.state}`);
      const [beforeFeed, beforeSpindle] = feedAndSpindle(before);
      if (beforeFeed !== 0 || beforeSpindle !== 0) throw new Error(`Non-zero feed/spindle before spindle test: ${before.FS}`);
      if (before.Pn) throw new Error(`Active input pins before spindle test: ${before.Pn}`);

      const startReply = await this.#lineCommandUnlocked(`M3 S${speed}`, true);
      const deadline = now() + duration;
      const samples = [];
      let running;
      try {
        while (now() < deadline) {
          try { await this.motionGuard(); }
          catch (error) { await this.#emergencyStop(`CAMERA_GUARD_FAILED:${error.message}`); throw this.fault; }
          const status = parseStatus(await this.#statusUnlocked({ attempts: 3 }));
          samples.push(status.raw);
          const [feed, spindle] = feedAndSpindle(status);
          if (status.state !== "Idle" || feed !== 0) {
            await this.#emergencyStop(`UNEXPECTED_SPINDLE_TEST_STATE:${status.raw}`);
            throw this.fault;
          }
          if (spindle > 0) running = status;
          await sleep(200);
        }
        if (!running) {
          await this.#emergencyStop("SPINDLE_TELEMETRY_DID_NOT_START");
          throw this.fault;
        }
      } catch (error) {
        if (!this.fault) await this.#emergencyStop(`SPINDLE_TEST_FAILED:${error.message}`);
        throw this.fault || error;
      }

      const stopReply = await this.#lineCommandUnlocked("M5", true);
      await sleep(150);
      const after = parseStatus(await this.#statusUnlocked({ attempts: 5 }));
      const [afterFeed, afterSpindle] = feedAndSpindle(after);
      if (after.state !== "Idle" || afterFeed !== 0 || afterSpindle !== 0) {
        await this.#emergencyStop(`SPINDLE_DID_NOT_STOP:${after.raw}`);
        throw this.fault;
      }
      await this.motionGuard();
      return { rpm: speed, durationMs: duration, before, startReply, running, samples, stopReply, after };
    });
  }

  spindleOff() { return this.#enqueue(() => this.#lineCommandUnlocked("M5", true)); }

  probeZ({ thicknessMm = 12.1, fastTravelMm = 20, fastFeed = 100, slowTravelMm = 2, slowFeed = 10, retractMm = 3 } = {}) {
    return this.#enqueue(async () => {
      if (typeof this.motionGuard !== "function") throw new Error("Motion guard is required for probing");
      const thickness = Number(thicknessMm), fastTravel = Math.abs(Number(fastTravelMm)), fast = Number(fastFeed), slowTravel = Math.abs(Number(slowTravelMm)), slow = Number(slowFeed), retract = Number(retractMm);
      if (!Number.isFinite(thickness) || thickness < 1 || thickness > 30) throw new Error("Probe thickness must be 1-30 mm");
      if (!Number.isFinite(fastTravel) || fastTravel < 2 || fastTravel > 25) throw new Error("Fast probe travel must be 2-25 mm");
      if (!Number.isFinite(slowTravel) || slowTravel < 0.5 || slowTravel > 5) throw new Error("Slow probe travel must be 0.5-5 mm");
      if (!Number.isFinite(fast) || fast < 20 || fast > 250 || !Number.isFinite(slow) || slow < 5 || slow > 50) throw new Error("Probe feed is outside the safe range");
      if (!Number.isFinite(retract) || retract < 1 || retract > 10) throw new Error("Probe retract must be 1-10 mm");
      await this.motionGuard();
      const before = parseStatus(await this.#statusUnlocked({ attempts: 5 }));
      if (before.state !== "Idle") throw new Error(`Controller must be Idle, got ${before.state}`);
      const [feed, spindle] = feedAndSpindle(before);
      if (feed !== 0 || spindle !== 0) throw new Error(`Non-zero feed/spindle before probe: ${before.FS}`);
      if (String(before.Pn || "").includes("P")) throw new Error("Probe is already active before motion; remove the clip/plate contact");
      try {
        await this.#lineCommandUnlocked("M5", true);
        await this.#lineCommandUnlocked("G21 G91", false);
        const fastReply = await this.#guardedMotionLine(`G38.2 Z-${fastTravel.toFixed(3)} F${Math.round(fast)}`, 25_000);
        const firstContact = parseStatus(await this.#statusUnlocked({ attempts: 5 }));
        await this.#lineCommandUnlocked("G0 Z1.000", true);
        const slowReply = await this.#guardedMotionLine(`G38.2 Z-${slowTravel.toFixed(3)} F${Math.round(slow)}`, 20_000);
        const finalContact = parseStatus(await this.#statusUnlocked({ attempts: 5 }));
        await this.#lineCommandUnlocked(`G10 L20 P1 Z${thickness.toFixed(3)}`, false);
        await this.#lineCommandUnlocked(`G0 Z${retract.toFixed(3)}`, true);
        await this.#lineCommandUnlocked("G90", false);
        const after = parseStatus(await this.#statusUnlocked({ attempts: 5 }));
        await this.motionGuard();
        return { thicknessMm: thickness, before, fastReply, firstContact, slowReply, finalContact, after };
      } catch (error) {
        if (!this.fault) await this.#emergencyStop(`PROBE_FAILED:${error.message}`);
        throw this.fault || error;
      }
    });
  }

  runProgram(source, { onProgress } = {}) {
    return this.#enqueue(async () => {
      if (typeof this.motionGuard !== "function") throw new Error("Motion guard is required for programs");
      if (typeof this.programGuard !== "function") throw new Error("Program guard is required");
      const analysis = analyzeProgram(source);
      await this.motionGuard();
      const before = parseStatus(await this.#statusUnlocked({ attempts: 5 }));
      if (before.state !== "Idle") throw new Error(`Controller must be Idle, got ${before.state}`);
      const [feed, spindle] = feedAndSpindle(before);
      if (feed !== 0 || spindle !== 0) throw new Error(`Non-zero feed/spindle before program: ${before.FS}`);
      if (before.Pn) throw new Error(`Active input pins before program: ${before.Pn}`);
      await this.programGuard({ before, analysis });
      this.programRunning = true;
      this.pauseRequested = false;
      this.abortRequested = false;
      let cameraError;
      let checking = false;
      const monitor = setInterval(async () => {
        if (checking || cameraError || !this.programRunning) return;
        checking = true;
        try { await this.motionGuard(); }
        catch (error) { cameraError = error; await this.#emergencyStop(`CAMERA_GUARD_FAILED:${error.message}`); }
        finally { checking = false; }
      }, 250);
      monitor.unref?.();
      try {
        for (let index = 0; index < analysis.lines.length; index += 1) {
          if (cameraError) throw this.fault || cameraError;
          if (this.abortRequested) throw new Error("PROGRAM_ABORTED");
          while (this.pauseRequested) {
            if (cameraError) throw this.fault || cameraError;
            await this.motionGuard();
            await sleep(200);
          }
          await this.#lineCommandUnlocked(analysis.lines[index], true, { timeoutMs: 15_000 });
          const progress = Math.round(((index + 1) / analysis.lines.length) * 1000) / 10;
          this.emit("programProgress", { progress, line: index + 1, total: analysis.lines.length });
          if (typeof onProgress === "function" && (index === analysis.lines.length - 1 || index % 20 === 0)) await onProgress({ progress, line: index + 1, total: analysis.lines.length });
        }
        const deadline = now() + 60_000;
        let after;
        while (now() < deadline) {
          if (cameraError) throw this.fault || cameraError;
          await this.motionGuard();
          after = parseStatus(await this.#statusUnlocked({ attempts: 3 }));
          if (after.state === "Idle") break;
          if (!new Set(["Run", "Hold", "Door"]).has(after.state.split(":")[0])) throw new Error(`Unexpected final program state: ${after.raw}`);
          await sleep(200);
        }
        if (!after || after.state !== "Idle") throw new Error("PROGRAM_COMPLETION_TIMEOUT");
        const [, finalSpindle] = feedAndSpindle(after);
        if (finalSpindle !== 0) await this.#lineCommandUnlocked("M5", true);
        await this.motionGuard();
        return { before, after, analysis: { bounds: analysis.bounds, maxSpindleRpm: analysis.maxSpindleRpm, executableLines: analysis.executableLines } };
      } catch (error) {
        if (!this.fault) await this.#emergencyStop(`PROGRAM_FAILED:${error.message}`);
        throw this.fault || error;
      } finally {
        clearInterval(monitor);
        this.programRunning = false;
        this.pauseRequested = false;
      }
    });
  }

  pauseProgramNow() {
    if (!this.connected || !this.programRunning) throw new Error("No running program to pause");
    this.pauseRequested = true;
    this.socket.write("!");
  }

  resumeProgramNow() {
    if (!this.connected || !this.programRunning) throw new Error("No paused program to resume");
    this.pauseRequested = false;
    this.socket.write("~");
  }

  async stopProgramNow(reason = "PROGRAM_STOP_REQUESTED") {
    this.abortRequested = true;
    await this.#emergencyStop(reason);
  }

  home({ timeoutMs = 90_000 } = {}) {
    return this.#enqueue(async () => {
      if (typeof this.motionGuard !== "function") throw new Error("Motion guard is required for homing");
      if (!Number.isFinite(timeoutMs) || timeoutMs < 10_000 || timeoutMs > 120_000) throw new Error("Homing timeout must be 10-120 seconds");
      await this.motionGuard();
      const before = parseStatus(await this.#statusUnlocked({ attempts: 5 }));
      if (before.state !== "Idle") throw new Error(`Controller must be Idle, got ${before.state}`);
      const [currentFeed, spindle] = String(before.FS || "0,0").split(",").map(Number);
      if (currentFeed !== 0 || spindle !== 0) throw new Error(`Non-zero feed/spindle before homing: ${before.FS}`);
      if (before.Pn) throw new Error(`Active input pins before homing: ${before.Pn}`);

      let reply;
      let replyError;
      let replySettled = false;
      const replyPromise = this.#lineCommandUnlocked("$H", true, { timeoutMs }).then(
        (value) => { reply = value; replySettled = true; },
        (error) => { replyError = error; replySettled = true; },
      );

      const deadline = now() + timeoutMs;
      while (now() < deadline && !replySettled) {
        try { await this.motionGuard(); }
        catch (error) { await this.#emergencyStop(`CAMERA_GUARD_FAILED:${error.message}`); throw this.fault; }
        await Promise.race([replyPromise, sleep(200)]);
      }
      if (!replySettled) {
        await this.#emergencyStop("HOMING_COMPLETION_TIMEOUT");
        throw this.fault;
      }
      if (replyError && !/^ALARM:\d+/.test(replyError.message)) throw replyError;

      await this.motionGuard();
      let after;
      try { after = parseStatus(await this.#statusUnlocked({ attempts: 8 })); }
      catch (error) {
        if (!replyError) throw error;
      }
      return { before, reply, replyError: replyError?.message, after, samples: [] };
    });
  }

  emergencyStop(reason = "MANUAL_EMERGENCY_STOP") { return this.#enqueue(() => this.#emergencyStop(reason)); }

  close() {
    return this.#enqueue(async () => {
      const socket = this.socket;
      ++this.socketGeneration;
      this.connectionState = "closing";
      this.socket = undefined;
      this.connectPromise = undefined;
      this.buffer = "";
      this.#rejectWaiters(new Error("Controller closed"));
      if (socket && !socket.destroyed) socket.destroy();
      this.connectionState = "disconnected";
      await sleep(25);
    });
  }

  async #statusUnlocked({ attempts = 5 } = {}) {
    await this.connect();
    if (!this.connected) throw new Error("CNC socket is not connected");
    if (this.statusWaiter) throw new Error("Status query already pending");
    const generation = this.socketGeneration;
    let resolveStatus, rejectStatus;
    const response = new Promise((resolve, reject) => { resolveStatus = resolve; rejectStatus = reject; });
    this.statusWaiter = { generation, resolve: resolveStatus, reject: rejectStatus };
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (!this.connected || generation !== this.socketGeneration) throw this.fault || new Error("CNC socket changed during status query");
      this.socket.write("?");
      const result = await Promise.race([response.then((line) => ({ line })), sleep(this.statusTimeoutMs).then(() => ({ timeout: true }))]);
      if (result.line) return result.line;
    }
    if (this.statusWaiter?.generation === generation) this.statusWaiter = undefined;
    this.#latchFault(new Error(`No GRBL status after ${attempts} same-socket attempts`), true);
    throw this.fault;
  }

  async #lineCommandUnlocked(command, motion, { timeoutMs = this.commandTimeoutMs } = {}) {
    await this.connect();
    if (!this.connected) throw new Error("CNC socket is not connected");
    if (this.lineWaiter) throw new Error("Line command already pending");
    const generation = this.socketGeneration;
    const lines = [];
    let resolveLine, rejectLine;
    const response = new Promise((resolve, reject) => { resolveLine = resolve; rejectLine = reject; });
    const timer = setTimeout(async () => {
      if (this.lineWaiter?.generation !== generation) return;
      this.lineWaiter = undefined;
      const error = new Error(`GRBL response timeout for ${motion ? "motion command" : command}`);
      if (motion) await this.#emergencyStop(error.message); else this.#latchFault(error, true);
      rejectLine(this.fault || error);
    }, timeoutMs);
    this.lineWaiter = { generation, lines, resolve: (value) => { clearTimeout(timer); resolveLine(value); }, reject: (error) => { clearTimeout(timer); rejectLine(error); } };
    this.socket.write(`${command}\r`);
    return response;
  }

  async #emergencyStop(reason) {
    if (this.connected) {
      try {
        this.socket.write("!");
        this.socket.write(Buffer.from([0x9e]));
        this.socket.write("M5\r");
        this.socket.write(Buffer.from([0x85]));
        await sleep(100);
        this.socket.write(Buffer.from([0x18]));
      } catch {}
    }
    this.#latchFault(new Error(reason), true);
  }

  #onData(generation, chunk) {
    if (generation !== this.socketGeneration) return;
    this.buffer += chunk;
    while (true) {
      const indexes = [this.buffer.indexOf("\r"), this.buffer.indexOf("\n")].filter((index) => index >= 0);
      if (!indexes.length) break;
      const index = Math.min(...indexes);
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      this.emit("line", line);
      if (line.startsWith("<") && line.endsWith(">") && this.statusWaiter?.generation === generation) {
        const waiter = this.statusWaiter; this.statusWaiter = undefined; waiter.resolve(line); continue;
      }
      if (this.lineWaiter?.generation === generation) {
        this.lineWaiter.lines.push(line);
        if (line === "ok" || /^error:\d+$/.test(line) || /^ALARM:\d+$/.test(line)) {
          const waiter = this.lineWaiter; this.lineWaiter = undefined;
          if (line === "ok") waiter.resolve([...waiter.lines]); else waiter.reject(new Error(`${line}; ${waiter.lines.join(" | ")}`));
        }
      }
    }
  }

  #latchFault(error, destroy) {
    if (!this.fault) this.fault = error instanceof Error ? error : new Error(String(error));
    this.connectionState = "fault";
    this.#rejectWaiters(this.fault);
    const socket = this.socket;
    this.socket = undefined;
    this.connectPromise = undefined;
    this.buffer = "";
    ++this.socketGeneration;
    if (destroy && socket && !socket.destroyed) socket.destroy();
    this.emit("fault", this.fault);
  }

  #enqueue(operation) { const next = this.queue.then(operation, operation); this.queue = next.catch(() => {}); return next; }
  #rejectWaiters(error) { this.statusWaiter?.reject(error); this.lineWaiter?.reject(error); this.statusWaiter = undefined; this.lineWaiter = undefined; }

  async #guardedMotionLine(command, timeoutMs) {
    let settled = false, value, failure;
    const pending = this.#lineCommandUnlocked(command, true, { timeoutMs }).then(
      (result) => { settled = true; value = result; },
      (error) => { settled = true; failure = error; },
    );
    while (!settled) {
      try { await this.motionGuard(); }
      catch (error) { await this.#emergencyStop(`CAMERA_GUARD_FAILED:${error.message}`); throw this.fault; }
      await Promise.race([pending, sleep(200)]);
    }
    if (failure) throw failure;
    return value;
  }
}

export function parseStatus(line) {
  if (!/^<.*>$/.test(line)) throw new Error(`Invalid GRBL status: ${line}`);
  const fields = line.slice(1, -1).split("|");
  const parsed = { state: fields.shift(), raw: line };
  for (const field of fields) { const split = field.indexOf(":"); if (split !== -1) parsed[field.slice(0, split)] = field.slice(split + 1); }
  return parsed;
}

export function coordinates(status) {
  const source = status.MPos || status.WPos;
  if (!source) throw new Error(`Status lacks MPos/WPos: ${status.raw}`);
  const [x, y, z] = source.split(",").map(Number);
  if (![x, y, z].every(Number.isFinite)) throw new Error(`Invalid coordinates: ${source}`);
  return { X: x, Y: y, Z: z };
}

function coordinateAxis(status, axis) { return coordinates(status)[axis]; }

function feedAndSpindle(status) {
  const [feed, spindle] = String(status.FS || "0,0").split(",").map(Number);
  if (![feed, spindle].every(Number.isFinite)) throw new Error(`Invalid feed/spindle telemetry: ${status.FS}`);
  return [feed, spindle];
}

export class VirtualWorkspace {
  constructor() { this.clear(); }

  clear() { this.bounds = undefined; this.createdAt = undefined; }

  setBounds(bounds) {
    const normalized = {};
    for (const axis of ["X", "Y", "Z"]) {
      const pair = bounds?.[axis];
      if (!pair) throw new Error(`Missing ${axis} bounds`);
      const min = Number(pair.min), max = Number(pair.max);
      if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) throw new Error(`Invalid ${axis} bounds`);
      normalized[axis] = { min, max };
    }
    this.bounds = normalized;
    this.createdAt = Date.now();
    return this.snapshot();
  }

  assertJog({ before, axis, distanceMm }) {
    if (!this.bounds) throw new Error("Virtual workspace is not calibrated");
    const current = coordinateAxis(before, axis);
    const target = current + Number(distanceMm);
    const { min, max } = this.bounds[axis];
    if (target < min - 0.001 || target > max + 0.001) {
      throw new Error(`Virtual ${axis} barrier rejects target ${target.toFixed(3)}; allowed ${min.toFixed(3)}..${max.toFixed(3)}`);
    }
    return { axis, current, target, min, max };
  }

  snapshot() { return { calibrated: Boolean(this.bounds), createdAt: this.createdAt, bounds: this.bounds }; }
}
