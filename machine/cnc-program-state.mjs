import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { analyzeProgram } from "./cnc-program.mjs";

export function validateSavedProgram(raw) {
  if (!raw || typeof raw !== "object" || raw.version !== 1) throw new Error("Saved CNC program is unsupported");
  const gcode = String(raw.gcode || ""), analysis = analyzeProgram(gcode);
  const context = raw.context && typeof raw.context === "object" ? raw.context : {};
  for (const field of ["stockWidthMm", "stockHeightMm", "stockReserveMm"]) {
    if (!Number.isFinite(Number(context[field]))) throw new Error(`Saved CNC program ${field} is invalid`);
  }
  return {
    version: 1,
    jobId: String(raw.jobId || ""),
    capturedAt: String(raw.capturedAt || new Date().toISOString()),
    state: String(raw.state || "accepted").slice(0, 24),
    context: { stockWidthMm: Number(context.stockWidthMm), stockHeightMm: Number(context.stockHeightMm), stockReserveMm: Number(context.stockReserveMm) },
    analysis: { bounds: analysis.bounds, maxSpindleRpm: analysis.maxSpindleRpm, executableLines: analysis.executableLines },
    gcode,
  };
}

export function saveProgram(path, raw) {
  const saved = validateSavedProgram(raw), temp = `${path}.${process.pid}.tmp`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(temp, `${JSON.stringify(saved)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
  chmodSync(path, 0o600);
  return saved;
}

export function readProgram(path) {
  if (!existsSync(path)) return null;
  return validateSavedProgram(JSON.parse(readFileSync(path, "utf8")));
}
