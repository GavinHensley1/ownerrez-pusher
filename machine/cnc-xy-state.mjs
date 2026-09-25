import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { machinePosition } from "./cnc-probe-state.mjs";

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

export function applyXyLock(setup, raw, status, toleranceMm = 0.05) {
  const lock = validateXyLock(raw), current = machinePosition(status);
  if (!xyContinuous(lock.lastKnownMPos, current, toleranceMm)) {
    const saved = lock.lastKnownMPos, actual = current || {};
    throw new Error(`Saved X/Y coordinates do not match this controller session (saved ${saved.X},${saved.Y}; current ${actual.X ?? "?"},${actual.Y ?? "?"})`);
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
