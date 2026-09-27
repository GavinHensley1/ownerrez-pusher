import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { controllerFrameLooksReset, machinePosition } from "./cnc-probe-state.mjs";

const finite = (value) => Number.isFinite(Number(value));

export function validateXyLock(raw) {
  if (!raw || typeof raw !== "object" || raw.version !== 1 || raw.locked !== true) throw new Error("X/Y lock is not a supported locked origin");
  for (const point of [raw.xyOriginMPos, raw.lastKnownMPos]) {
    if (!["X", "Y"].every((axis) => finite(point?.[axis]))) throw new Error("X/Y lock position is invalid");
  }
  return {
    version: 1,
    locked: true,
    xyOriginMPos: { X: Number(raw.xyOriginMPos.X), Y: Number(raw.xyOriginMPos.Y) },
    lastKnownMPos: { X: Number(raw.lastKnownMPos.X), Y: Number(raw.lastKnownMPos.Y) },
    lockedAt: String(raw.lockedAt || new Date().toISOString()),
    source: String(raw.source || "Project guarded X/Y origin").slice(0, 160),
  };
}

export function xyContinuous(saved, current, toleranceMm = 0.05) {
  if (!saved || !current) return false;
  return ["X", "Y"].every((axis) => Math.abs(Number(saved[axis]) - Number(current[axis])) <= toleranceMm);
}

export function xyLockFromSetup(setup, status, now = new Date().toISOString()) {
  const current = machinePosition(status), origin = setup.xyOriginMPos;
  if (!current || !["X", "Y"].every((axis) => finite(origin?.[axis]))) throw new Error("Cannot lock X/Y without a valid origin and machine position");
  return validateXyLock({
    version: 1,
    locked: true,
    xyOriginMPos: { X: origin.X, Y: origin.Y },
    lastKnownMPos: { X: current.X, Y: current.Y },
    lockedAt: setup.xyLockedAt || now,
    source: "Project guarded front-left X/Y origin",
  });
}

export function planXyPowerCycleRecovery(raw, status, workOffset, toleranceMm = 0.05) {
  const lock = validateXyLock(raw), current = machinePosition(status);
  if (!current) throw new Error("Current machine position is unavailable");
  if (!["X", "Y"].every((axis) => Math.abs(current[axis]) <= toleranceMm)) {
    throw new Error("X/Y power-cycle recovery is available only before any post-reset X/Y movement");
  }
  const offsetFinite = workOffset && ["X", "Y"].every((axis) => finite(workOffset[axis]));
  const offsetAtReset = offsetFinite && ["X", "Y"].every((axis) => Math.abs(Number(workOffset[axis])) <= toleranceMm);
  const offsetMatchesSavedOrigin = offsetFinite && xyContinuous(lock.xyOriginMPos, workOffset, toleranceMm);
  if (!offsetAtReset && !offsetMatchesSavedOrigin) throw new Error("Controller X/Y work offsets do not match the saved project or reset state");
  const savedWorkPosition = {
    X: Number((lock.lastKnownMPos.X - lock.xyOriginMPos.X).toFixed(3)),
    Y: Number((lock.lastKnownMPos.Y - lock.xyOriginMPos.Y).toFixed(3)),
  };
  if (savedWorkPosition.X < -60.001 || savedWorkPosition.X > 400.001 || savedWorkPosition.Y < -60.001 || savedWorkPosition.Y > 400.001) {
    throw new Error(`Saved X/Y work position ${savedWorkPosition.X},${savedWorkPosition.Y} is outside the recoverable machine range`);
  }
  const rebasedOriginMPos = {
    X: Number((current.X - savedWorkPosition.X).toFixed(3)),
    Y: Number((current.Y - savedWorkPosition.Y).toFixed(3)),
  };
  return { lock, current, savedWorkPosition, rebasedOriginMPos };
}

export function applyXyLock(setup, raw, status, toleranceMm = 0.05, workOffset) {
  const lock = validateXyLock(raw), current = machinePosition(status);
  if (controllerFrameLooksReset({ ...lock.lastKnownMPos, Z: 1 }, current)) {
    throw new Error("Controller machine coordinates reset to zero; reset X/Y zero before restoring the origin");
  }
  const reference = workOffset && finite(workOffset.X) && finite(workOffset.Y)
    ? { X: Number(workOffset.X), Y: Number(workOffset.Y) }
    : current;
  const expected = workOffset ? lock.xyOriginMPos : lock.lastKnownMPos;
  if (!xyContinuous(expected, reference, toleranceMm)) {
    const actual = reference || {};
    throw new Error(`Saved X/Y origin does not match this controller session (saved ${expected.X},${expected.Y}; current ${actual.X ?? "?"},${actual.Y ?? "?"})`);
  }
  Object.assign(setup, {
    xyReady: true,
    xyLockStatus: "restored",
    xyLockedAt: lock.lockedAt,
    xyOriginMPos: { X: lock.xyOriginMPos.X, Y: lock.xyOriginMPos.Y, Z: current.Z },
    updatedAt: new Date().toISOString(),
  });
  return lock;
}

export function readXyLock(path) {
  if (!existsSync(path)) return null;
  return validateXyLock(JSON.parse(readFileSync(path, "utf8")));
}

export function writeXyLock(path, raw) {
  const lock = validateXyLock(raw), temp = `${path}.${process.pid}.tmp`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(temp, `${JSON.stringify(lock, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
  chmodSync(path, 0o600);
  return lock;
}

export function removeXyLock(path) {
  rmSync(path, { force: true });
}
