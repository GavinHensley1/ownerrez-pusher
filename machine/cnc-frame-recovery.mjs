import { machinePosition } from "./cnc-probe-state.mjs";

// Offsets alone cannot prove continuity: GRBL may retain G54 across a reset.
// Compare independent axes to the last known endpoint as well as their origin.
export function inspectSavedFrame({ status, workOffset, xyLock, probeLock }) {
  const current = machinePosition(status);
  const near = (a, b) => a !== null && a !== undefined && b !== null && b !== undefined && Number.isFinite(Number(a)) && Number.isFinite(Number(b)) && Math.abs(Number(a) - Number(b)) <= 0.05;
  const xy = !!current && !!xyLock && ["X", "Y"].every(axis => near(current[axis], xyLock.lastKnownMPos?.[axis]) && near(workOffset?.[axis], xyLock.xyOriginMPos?.[axis]));
  const z = !!current && !!probeLock && near(current.Z, probeLock.lastKnownMPos?.Z) && near(workOffset?.Z, probeLock.zOriginMPos);
  return { xy, z, message: xy && z ? "Saved X/Y and Z verified; no coordinates changed and no cut resumed." : xy ? "Saved X/Y verified. Z needs a current-bit touch-off; do not reset X/Y." : "Saved X/Y cannot yet be verified. Use the saved-origin recovery if offered, or explicitly set an origin. Your saved records have not been erased." };
}
