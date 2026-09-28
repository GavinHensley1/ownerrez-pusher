import { appendFileSync, chmodSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";

const safe = (value, depth = 0) => {
  if (depth > 3) return "[truncated]";
  if (value == null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return value.slice(0, 500);
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => safe(item, depth + 1));
  if (typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => !/gcode|token|secret|password/i.test(key)).slice(0, 30).map(([key, item]) => [key, safe(item, depth + 1)]));
  return String(value).slice(0, 200);
};

export function appendCncEvent(path, type, detail = {}, now = new Date().toISOString()) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (existsSync(path) && statSync(path).size > 2_000_000) renameSync(path, `${path}.previous`);
  appendFileSync(path, `${JSON.stringify({ at: now, type: String(type).slice(0, 80), detail: safe(detail) })}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}
