import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function validateRunCheckpoint(raw) {
  if (!raw || typeof raw !== "object" || raw.version !== 1) throw new Error("CNC run checkpoint is unsupported");
  const completed = Number(raw.lastCompletedLine), total = Number(raw.totalLines);
  if (!Number.isInteger(completed) || !Number.isInteger(total) || completed < 0 || total < 1 || completed > total) throw new Error("CNC run checkpoint line counts are invalid");
  const position = (value) => {
    if (!value || typeof value !== "object") return null;
    const parsed = { X: Number(value.X), Y: Number(value.Y), Z: Number(value.Z) };
    return Object.values(parsed).every(Number.isFinite) ? parsed : null;
  };
  return {
    version: 1,
    jobId: String(raw.jobId || ""),
    programCapturedAt: String(raw.programCapturedAt || ""),
    state: String(raw.state || "running").slice(0, 24),
    lastCompletedLine: completed,
    totalLines: total,
    message: String(raw.message || "").slice(0, 240),
    updatedAt: String(raw.updatedAt || new Date().toISOString()),
    stopWorkPosition: position(raw.stopWorkPosition),
    postStopPosition: position(raw.postStopPosition),
    postStopMoveCount: Math.max(0, Math.min(10_000, Number(raw.postStopMoveCount) || 0)),
    positionReason: String(raw.positionReason || "").slice(0, 80),
    positionUpdatedAt: String(raw.positionUpdatedAt || ""),
  };
}

export function writeRunCheckpoint(path, raw) {
  const checkpoint = validateRunCheckpoint(raw), temp = `${path}.${process.pid}.tmp`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(temp, `${JSON.stringify(checkpoint)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
  chmodSync(path, 0o600);
  return checkpoint;
}

export function readRunCheckpoint(path) {
  if (!existsSync(path)) return null;
  return validateRunCheckpoint(JSON.parse(readFileSync(path, "utf8")));
}
