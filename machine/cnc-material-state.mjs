import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const finite = (value) => Number.isFinite(Number(value));

export function validateMaterialProfile(raw) {
  if (!raw || typeof raw !== "object" || raw.version !== 1) throw new Error("Material profile is not supported");
  for (const field of ["stockThicknessMm", "safetyFloorMm", "maxCutDepthMm"]) {
    if (!finite(raw[field])) throw new Error(`Material profile ${field} is invalid`);
  }
  const stockThicknessMm = Number(raw.stockThicknessMm);
  const safetyFloorMm = Number(raw.safetyFloorMm);
  const maxCutDepthMm = Number(raw.maxCutDepthMm);
  if (!(stockThicknessMm > 0 && stockThicknessMm <= 120)) throw new Error("Material thickness is outside the supported range");
  if (!(safetyFloorMm >= 0.8 && safetyFloorMm < stockThicknessMm)) throw new Error("Material protected floor is invalid");
  if (Math.abs(maxCutDepthMm - (stockThicknessMm - safetyFloorMm)) > 0.01) throw new Error("Material maximum cut depth is inconsistent");
  return {
    version: 1,
    stockThicknessMm,
    safetyFloorMm,
    maxCutDepthMm,
    capturedAt: String(raw.capturedAt || new Date().toISOString()),
    source: String(raw.source || "Project measured bed and stock").slice(0, 160),
  };
}

export function materialProfileFromSetup(setup, now = new Date().toISOString()) {
  return validateMaterialProfile({
    version: 1,
    stockThicknessMm: setup.stockThicknessMm,
    safetyFloorMm: setup.safetyFloorMm,
    maxCutDepthMm: setup.maxCutDepthMm,
    capturedAt: setup.updatedAt || now,
    source: "Project measured bed and stock",
  });
}

export function applyMaterialProfile(setup, raw) {
  const profile = validateMaterialProfile(raw);
  Object.assign(setup, {
    materialReady: true,
    savedStockThicknessMm: profile.stockThicknessMm,
    savedSafetyFloorMm: profile.safetyFloorMm,
    updatedAt: new Date().toISOString(),
  });
  return profile;
}

export function readMaterialProfile(path) {
  if (!existsSync(path)) return null;
  return validateMaterialProfile(JSON.parse(readFileSync(path, "utf8")));
}

export function writeMaterialProfile(path, raw) {
  const profile = validateMaterialProfile(raw), temp = `${path}.${process.pid}.tmp`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(temp, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
  chmodSync(path, 0o600);
  return profile;
}

export function removeMaterialProfile(path) {
  rmSync(path, { force: true });
}
