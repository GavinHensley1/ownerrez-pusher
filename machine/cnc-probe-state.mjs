import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const NUMBER_FIELDS = ["probeThickness", "bedSurfaceMPos", "stockSurfaceMPos", "stockThicknessMm", "safetyFloorMm", "maxCutDepthMm", "zOriginMPos"];

const finite = (value) => Number.isFinite(Number(value));

export function machinePosition(status) {
  const parts = String(status?.MPos || "").split(",").slice(0, 3).map(Number);
  if (parts.length !== 3 || parts.some((value) => !Number.isFinite(value))) return null;
  return { X: parts[0], Y: parts[1], Z: parts[2] };
}

export function validateProbeLock(raw) {
  if (!raw || typeof raw !== "object" || raw.version !== 1 || raw.locked !== true) throw new Error("Probe lock is not a supported locked calibration");
  for (const field of NUMBER_FIELDS) if (!finite(raw[field])) throw new Error(`Probe lock ${field} is invalid`);
  const lastKnownMPos = raw.lastKnownMPos;
  if (!["X", "Y", "Z"].every((axis) => finite(lastKnownMPos?.[axis]))) throw new Error("Probe lock machine position is invalid");
  const probeThickness = Number(raw.probeThickness), stockThicknessMm = Number(raw.stockThicknessMm), safetyFloorMm = Number(raw.safetyFloorMm), maxCutDepthMm = Number(raw.maxCutDepthMm);
  if (!(probeThickness >= 1 && probeThickness <= 30)) throw new Error("Probe lock plate thickness is outside the supported range");
  if (!(stockThicknessMm > 0 && stockThicknessMm <= 120)) throw new Error("Probe lock stock thickness is outside the supported range");
  if (!(safetyFloorMm >= 0.8 && safetyFloorMm < stockThicknessMm)) throw new Error("Probe lock protected floor is invalid");
  if (!(maxCutDepthMm > 0 && maxCutDepthMm <= stockThicknessMm - safetyFloorMm + 0.001)) throw new Error("Probe lock maximum cut depth is invalid");
  return {
    version: 1,
    locked: true,
    probeThickness,
    bedSurfaceMPos: Number(raw.bedSurfaceMPos),
    stockSurfaceMPos: Number(raw.stockSurfaceMPos),
    stockThicknessMm,
    safetyFloorMm,
    maxCutDepthMm,
    zOriginMPos: Number(raw.zOriginMPos),
    lastKnownMPos: { X: Number(lastKnownMPos.X), Y: Number(lastKnownMPos.Y), Z: Number(lastKnownMPos.Z) },
    capturedAt: String(raw.capturedAt || raw.lockedAt || new Date().toISOString()),
    lockedAt: String(raw.lockedAt || raw.capturedAt || new Date().toISOString()),
    source: String(raw.source || "Project guarded probe calibration").slice(0, 160),
  };
}

export function positionContinuous(saved, current, toleranceMm = 0.05) {
  if (!saved || !current) return false;
  return ["X", "Y", "Z"].every((axis) => Math.abs(Number(saved[axis]) - Number(current[axis])) <= toleranceMm);
}

export function calibrationFromSetup(setup, status, now = new Date().toISOString()) {
  const lastKnownMPos = machinePosition(status);
  if (!lastKnownMPos) throw new Error("Cannot lock probe calibration without a valid machine position");
  return validateProbeLock({
    version: 1,
    locked: true,
    probeThickness: setup.probeThickness,
    bedSurfaceMPos: setup.bedSurfaceMPos,
    stockSurfaceMPos: setup.stockSurfaceMPos,
    stockThicknessMm: setup.stockThicknessMm,
    safetyFloorMm: setup.safetyFloorMm,
    maxCutDepthMm: setup.maxCutDepthMm,
    zOriginMPos: setup.zOriginMPos,
    lastKnownMPos,
    capturedAt: setup.updatedAt || now,
    lockedAt: setup.probeLockedAt || now,
    source: "Project guarded two-touch bed and stock probes",
  });
}

export function applyProbeLock(setup, raw, status, toleranceMm = 0.05) {
  const lock = validateProbeLock(raw), current = machinePosition(status);
  if (!positionContinuous(lock.lastKnownMPos, current, toleranceMm)) {
    const saved = lock.lastKnownMPos, actual = current || {};
    throw new Error(`Saved probe coordinates do not match this controller session (saved ${saved.X},${saved.Y},${saved.Z}; current ${actual.X ?? "?"},${actual.Y ?? "?"},${actual.Z ?? "?"})`);
  }
  Object.assign(setup, {
    bedProbeReady: true,
    stockProbeReady: true,
    probeReady: true,
    probeLocked: true,
    probeLockStatus: "restored",
    probeLockedAt: lock.lockedAt,
    probeThickness: lock.probeThickness,
    bedSurfaceMPos: lock.bedSurfaceMPos,
    stockSurfaceMPos: lock.stockSurfaceMPos,
    stockThicknessMm: lock.stockThicknessMm,
    safetyFloorMm: lock.safetyFloorMm,
    maxCutDepthMm: lock.maxCutDepthMm,
    zOriginMPos: lock.zOriginMPos,
    updatedAt: new Date().toISOString(),
  });
  return lock;
}

export function readProbeLock(path) {
  if (!existsSync(path)) return null;
  return validateProbeLock(JSON.parse(readFileSync(path, "utf8")));
}

export function writeProbeLock(path, raw) {
  const lock = validateProbeLock(raw), temp = `${path}.${process.pid}.tmp`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(temp, `${JSON.stringify(lock, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
  chmodSync(path, 0o600);
  return lock;
}

export function removeProbeLock(path) {
  rmSync(path, { force: true });
}
