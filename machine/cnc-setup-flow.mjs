import { measuredStockProtection } from "./cnc-program.mjs";
import { validateMaterialProfile } from "./cnc-material-state.mjs";

export function completeStockProbe(setup, surfaceZ, now = new Date().toISOString()) {
  const protection = measuredStockProtection(setup.bedSurfaceMPos, Number(surfaceZ));
  Object.assign(setup, {
    stockSurfaceMPos: Number(surfaceZ),
    stockThicknessMm: protection.stockThicknessMm,
    safetyFloorMm: protection.safetyFloorMm,
    maxCutDepthMm: protection.maxCutDepthMm,
    zOriginMPos: Number(surfaceZ),
    stockProbeReady: true,
    probeReady: true,
    probeLocked: true,
    probeLockStatus: "locked_after_stock_probe",
    probeLockedAt: now,
    updatedAt: now,
  });
  return protection;
}

export function completeToolTouch(setup, surfaceZ, rawProfile, now = new Date().toISOString()) {
  const profile = validateMaterialProfile(rawProfile), stock = Number(surfaceZ);
  Object.assign(setup, {
    stockSurfaceMPos: stock,
    bedSurfaceMPos: stock - profile.stockThicknessMm,
    stockThicknessMm: profile.stockThicknessMm,
    safetyFloorMm: profile.safetyFloorMm,
    maxCutDepthMm: profile.maxCutDepthMm,
    zOriginMPos: stock,
    materialReady: true,
    savedStockThicknessMm: profile.stockThicknessMm,
    savedSafetyFloorMm: profile.safetyFloorMm,
    bedProbeReady: true,
    stockProbeReady: true,
    probeReady: true,
    probeLocked: true,
    probeLockStatus: "locked_after_tool_touch",
    probeLockedAt: now,
    updatedAt: now,
  });
  return profile;
}
