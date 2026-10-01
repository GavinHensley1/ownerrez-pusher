import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
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

export function readLatestCompletedStockProbe(path) {
  if (!existsSync(path)) return null;
  const lines = readFileSync(path, "utf8").trim().split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    let event; try { event = JSON.parse(lines[index]); } catch { continue; }
    if (event?.type !== "probe.completed" || event?.detail?.kind !== "stock") continue;
    const stockThicknessMm = Number(event.detail.stockThicknessMm), maxCutDepthMm = Number(event.detail.maxCutDepthMm), safetyFloorMm = Math.round((stockThicknessMm - maxCutDepthMm) * 1000) / 1000;
    if (!(stockThicknessMm > 0 && maxCutDepthMm > 0 && safetyFloorMm >= 0.8 && maxCutDepthMm < stockThicknessMm)) continue;
    // The ABSOLUTE references and the plate used are carried through, not just the
    // derived thicknesses. A caller restoring this measurement has to answer two
    // questions the thicknesses alone cannot: which plate was it taken with, and
    // is the controller's Z origin still that same one? Dropping these is why
    // restoreProbeAfterXyOnlyReset read prior.probeThickness as undefined and so
    // always threw, and why it could adopt whatever G54 Z happened to be loaded
    // with no continuity check at all.
    //
    // Nullable on purpose: entries written before these fields existed must stay
    // readable, and the caller refuses them with a clear reason rather than
    // treating a missing reference as a matching one.
    // Number("") and Number(null) are both 0, and Number.isFinite accepts that.
    // Coercing a missing origin to 0 would make the Z-continuity check compare
    // against machine zero and pass for a machine that happens to sit near it, so
    // only an actual finite number counts.
    const num = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);
    return {
      at: String(event.at || ""),
      stockThicknessMm,
      safetyFloorMm,
      maxCutDepthMm,
      probeThickness: num(event.detail.probeThickness),
      stockSurfaceMPos: num(event.detail.stockSurfaceMPos),
      bedSurfaceMPos: num(event.detail.bedSurfaceMPos),
      zOriginMPos: num(event.detail.zOriginMPos),
    };
  }
  return null;
}
