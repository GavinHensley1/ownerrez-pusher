import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const normalize = (value) => {
  if (!value || value.latched !== true) return null;
  return {
    version: 1,
    latched: true,
    frameValid: false,
    reason: String(value.reason || "CONTROLLER_CONNECTION_LOST").slice(0, 500),
    occurredAt: String(value.occurredAt || new Date().toISOString()),
    duringMotion: value.duringMotion === true,
    jobId: String(value.jobId || "").slice(0, 200),
    recoveryRequired: "Reconnect and verify saved coordinates in Project; never resume automatically",
  };
};

export function readFrameIncident(path) {
  if (!path || !existsSync(path)) return null;
  return normalize(JSON.parse(readFileSync(path, "utf8")));
}

export function writeFrameIncident(path, value) {
  if (!path) throw new Error("Frame-incident path is required");
  const incident = normalize({ ...value, latched: true, frameValid: false });
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(incident, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  return incident;
}

export function assertFrameValid(incident) {
  if (!incident?.latched) return true;
  throw new Error(`Cutting is blocked after ${incident.reason}. Reconnect and verify saved coordinates through Project; setup recovery does not resume the cut.`);
}

export function resolveFrameIncident(path, verification) {
  if (verification?.xyReady !== true || verification?.probeLocked !== true) throw new Error("Verified X/Y and Z are required to clear the cutting interlock");
  const resolved = { version: 1, latched: false, resolvedAt: new Date().toISOString(), verification };
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(resolved, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  return null;
}
