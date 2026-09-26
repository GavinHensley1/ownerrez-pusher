import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function validateRunCheckpoint(raw) {
  if (!raw || typeof raw !== "object" || raw.version !== 1) throw new Error("CNC run checkpoint is unsupported");
  const completed = Number(raw.lastCompletedLine), total = Number(raw.totalLines);
  if (!Number.isInteger(completed) || !Number.isInteger(total) || completed < 0 || total < 1 || completed > total) throw new Error("CNC run checkpoint line counts are invalid");
  return {
    version: 1,
    jobId: String(raw.jobId || ""),
    programCapturedAt: String(raw.programCapturedAt || ""),
    state: String(raw.state || "running").slice(0, 24),
    lastCompletedLine: completed,
    totalLines: total,
    message: String(raw.message || "").slice(0, 240),
    updatedAt: String(raw.updatedAt || new Date().toISOString()),
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
