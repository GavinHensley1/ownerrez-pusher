import http from "node:http";
import programHolds from "../api/cnc-program-holds.cjs";
// Same modules the Vercel API uses, so the provider a metal program may carry and
// the blank-thickness rule for a through-cut cannot drift between API and bridge.
import certifiedCam from "../api/cnc-certified-library.cjs";
import camStageGate from "../api/cnc-cam-stage-gate.cjs";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { GrblTcpController, coordinates, parseStatus, parseWorkOffset, VirtualWorkspace } from "./cnc-controller.mjs";
import { approvedProgramDepth, assertPlungeFeedWithinLimit, limitVerticalPlungeFeed, validateProgramEnvelope, validateProgramStockEnvelope } from "./cnc-program.mjs";
import { applyProbeLock, assertLockedProbeZJog, calibrationFromSetup, readProbeLock, readProbeLockInvalidation, removeProbeLock, writeProbeLock } from "./cnc-probe-state.mjs";
import { applyMaterialProfile, materialProfileFromSetup, readMaterialProfile, removeMaterialProfile, writeMaterialProfile } from "./cnc-material-state.mjs";
import { applyXyLock, planXyPowerCycleRecovery, readXyLock, removeXyLock, writeXyLock, xyLockFromSetup } from "./cnc-xy-state.mjs";
import { readProgram, saveProgram } from "./cnc-program-state.mjs";
import { buildBufferedStopResume, buildCheckpointReplayResume, buildResumeProgram, programPositionAtLine } from "./cnc-resume.mjs";
import { readRunCheckpoint, writeRunCheckpoint } from "./cnc-run-state.mjs";
import { completeStockProbe, completeToolTouch } from "./cnc-setup-flow.mjs";
import { appendCncEvent, readLatestCompletedStockProbe } from "./cnc-event-journal.mjs";
import { assertWorkJogWithinStock, positioningBoundsFromStock, POSITIONING_OUTSIDE_STOCK_MM } from "./cnc-positioning-envelope.mjs";
import { parseGrblSettings, readSettingsBaseline, validateControllerSettings, writeSettingsBaseline } from "./cnc-controller-settings.mjs";
import { assertFrameValid, readFrameIncident, writeFrameIncident, resolveFrameIncident } from "./cnc-frame-incident.mjs";
import { inspectSavedFrame } from "./cnc-frame-recovery.mjs";
import { configuredPlateThickness, normalizePlateThickness, plateThicknessMatches, writePlateConfig, PLATE_THICKNESS_MIN_MM, PLATE_THICKNESS_MAX_MM } from "./cnc-plate-config.mjs";
import { assertSurfaceProofReady, buildSurfaceProof, requiresMeasuredSurfaceProof, surfaceProofStatus, SURFACE_PROOF_ATTESTED, SURFACE_PROOF_CONDUCTIVE, SURFACE_PROOF_TOLERANCE_MM } from "./cnc-surface-proof.mjs";

const HOST = process.env.CNC_HOST || "192.168.1.183";
const PORT = Number(process.env.CNC_PORT || 10086);
const SOCKET_PATH = process.env.CNC_DAEMON_SOCKET || "/tmp/openclaw-cnc.sock";
const LOCAL_UI_PORT = Number(process.env.CNC_LOCAL_UI_PORT || 47832);
const PROBE_STATE_PATH = process.env.CNC_PROBE_STATE || join(homedir(), ".openclaw", "state", "cnc-probe-calibration.json");
const MATERIAL_STATE_PATH = process.env.CNC_MATERIAL_STATE || join(homedir(), ".openclaw", "state", "cnc-material-profile.json");
const XY_STATE_PATH = process.env.CNC_XY_STATE || join(homedir(), ".openclaw", "state", "cnc-xy-origin.json");
const PROGRAM_STATE_PATH = process.env.CNC_PROGRAM_STATE || join(homedir(), ".openclaw", "state", "cnc-last-program.json");
const RUN_STATE_PATH = process.env.CNC_RUN_STATE || join(homedir(), ".openclaw", "state", "cnc-run-checkpoint.json");
const EVENT_JOURNAL_PATH = process.env.CNC_EVENT_JOURNAL || join(homedir(), ".openclaw", "state", "cnc-events.jsonl");
const FRAME_INCIDENT_PATH = process.env.CNC_FRAME_INCIDENT || join(homedir(), ".openclaw", "state", "cnc-frame-incident.json");
const PLATE_CONFIG_PATH = process.env.CNC_PLATE_CONFIG || join(homedir(), ".openclaw", "state", "cnc-plate-config.json");
const CONTROLLER_SETTINGS_PATH = process.env.CNC_CONTROLLER_SETTINGS || join(homedir(), ".openclaw", "state", "cnc-controller-settings.json");
const STATUS_TIMEOUT_MS = Number(process.env.CNC_STATUS_TIMEOUT_MS || 1500);
const MAX_BODY_BYTES = 900_000;
// High-resolution Finish programs are transported as decoded G-code over the
// loopback-only Unix socket. Keep ordinary control requests tightly bounded,
// but allow machine-program endpoints to receive the generated payload.
const MAX_PROGRAM_BODY_BYTES = 10_000_000;
// Probe plate height is an OPERATOR-MEASURED value, not a machine constant.
// SainSmart ships this plate in 14, 14.19 and 20.17 mm variants and documents that
// thickness varies between units. A wrong value shifts absolute Z zero by exactly
// that error while bed-minus-stock thickness still looks correct, because the same
// error cancels in the subtraction. A 20 mm value was assumed against a ~14.19 mm
// plate and cut a buckle about 6 mm too deep on 2026-09-30.
//
// The configured value is read from its OWN state file. It must never be seeded
// from the calibration record that is validated against it: that is
// self-validation, it always passes, and it would silently adopt exactly the
// stale 20 mm calibration this check exists to reject.
const PROBE_PUCK_MIN_MM = PLATE_THICKNESS_MIN_MM, PROBE_PUCK_MAX_MM = PLATE_THICKNESS_MAX_MM;
const normalizePuckThickness = normalizePlateThickness;
let plateConfig = configuredPlateThickness(PLATE_CONFIG_PATH);
const configuredPlateMm = () => plateConfig.plateThicknessMm;
// `confirmedByOperator` is the flag that releases a cut, so it is a parameter
// here rather than an assumption. Only the dedicated set-plate endpoint passes
// true. A thickness that merely accompanies a probe command is stored and used,
// but does NOT become a confirmation -- on 2026-10-01 that path had written 12.1
// mm (the retired third silent default) and had it recorded as operator-measured.
const setConfiguredPlateMm = (mm, source, { confirmedByOperator = false, measuredBy = "unattributed" } = {}) => {
  const value = normalizePlateThickness(mm);
  if (value === null) throw new Error(`Plate thickness must be between ${PROBE_PUCK_MIN_MM} and ${PROBE_PUCK_MAX_MM} mm`);
  const changed = !plateThicknessMatches(value, plateConfig.plateThicknessMm);
  // Also rewrite when this call would ADD a confirmation to a value that was
  // stored unconfirmed, otherwise an operator re-entering the same number could
  // never promote it.
  if (changed || !plateConfig.confirmed) {
    writePlateConfig(PLATE_CONFIG_PATH, { plateThicknessMm: value, source: source || "Z-probe plate thickness of unrecorded origin", confirmedByOperator, measuredBy });
    // Re-resolve through the SAME reader the daemon uses at startup, rather than
    // assembling the live config here. One code path decides what a stored record
    // means -- including the explanatory source text for an unconfirmed value --
    // so a freshly written plate and a restarted daemon can never disagree.
    plateConfig = configuredPlateThickness(PLATE_CONFIG_PATH);
  }
  // A different plate means every stored Z reference came from the wrong number.
  // Drop any surface proof rather than carrying its approval into a new frame.
  if (changed) clearSurfaceProof(`plate thickness changed to ${value.toFixed(2)} mm`);
  return plateConfig.plateThicknessMm;
};
// The surface-contact proof is deliberately IN-MEMORY ONLY and never persisted.
// It is a statement about the machine's present physical state, so a daemon
// restart, a reconnect, or a power cycle must invalidate it by construction
// rather than by remembering to delete a file. Fail-closed is the default: this
// starts null, and null blocks Start.
let surfaceProof = null, surfaceProofClearedReason = "";
const clearSurfaceProof = (reason) => {
  if (surfaceProof) recordEvent?.("surface_proof.cleared", { reason: String(reason || "unspecified") });
  surfaceProof = null;
  surfaceProofClearedReason = String(reason || "");
};
let controller, lastControllerStatus, lastWorkOffset, incident, moving = false, keepaliveBusy = false;
// WHY `moving` NEEDS A WATCHDOG:
// Every operation raises the flag inside a try with a `finally` that lowers it,
// so it cannot leak through a normal failure. It CAN still latch if an awaited
// controller call never settles -- a GRBL Wi-Fi socket that accepts the TCP
// connection and then answers nothing is the observed case. And a latched
// `moving` is not a cosmetic flag: hazardousOperationActive() consults it, so it
// suppresses auto-reconnect, and index.html disables the "Retry connection"
// control on health.moving. That is precisely the dead end found on the live
// daemon on 2026-10-01, which reported moving:true with job idle and the
// controller Idle at FS:0,0 -- no motion anywhere, and no way to recover.
//
// The bound is deliberately conservative: a real program may legitimately run
// for 20 h, so time alone never clears the flag. It is cleared only when the
// machine demonstrably is not moving -- no running/paused job AND the controller
// last reported Idle with zero feed and spindle and no active input pin -- and
// only after a grace period far longer than any single command timeout.
const STALE_MOTION_GRACE_MS = 120_000;
// Coordinate-continuity window for judging whether a saved lock still describes
// the controller's live frame. Named once because it was previously written as a
// bare 0.05 at each call site. This is a CONTINUITY tolerance, deliberately much
// looser than the plate-thickness match tolerance, which compares two typed
// numbers rather than two measurements of a physical position.
const PROBE_LOCK_TOLERANCE_MM = 0.05;
// How long a saved measurement may still speak for the physical setup. Beyond
// this the stock may have been swapped, shifted or re-clamped with nothing in
// software to notice. Named once: probeRecoverySnapshot and
// restoreProbeAfterXyOnlyReset each carried their own 4 * 60 * 60 * 1000, and the
// /probe/tool touch-off path -- which rebuilds the bed reference from a stored
// material profile -- had NO bound at all and would happily reuse a days-old
// thickness.
const SAVED_MEASUREMENT_MAX_AGE_MS = 4 * 60 * 60 * 1000;
// How far a MANUAL stock Z zero may disagree with the measured bed before it is
// refused. A hand touch-off on paper or feel is worth a few tenths, not
// millimetres, and anything larger means the operator is not where they think
// they are. Deliberately generous enough for a legitimate manual touch-off and
// far tighter than the ~6 mm error that caused the 2026-09-30 damage. A manual
// zero also clears the surface-contact proof, so Start still demands a fresh
// plate-free measurement afterwards.
const MANUAL_Z_ZERO_TOLERANCE_MM = 0.5;
let movingSince = 0, movingReason = "";
const setMoving = (active, reason = "") => {
  moving = active === true;
  movingSince = moving ? Date.now() : 0;
  movingReason = moving ? String(reason || "") : "";
};
// Returns a reason string when the flag is provably stale, otherwise "".
const staleMotionReason = () => {
  if (!moving || !movingSince) return "";
  if (["running", "paused"].includes(job.state)) return "";
  if (Date.now() - movingSince < STALE_MOTION_GRACE_MS) return "";
  const status = lastControllerStatus;
  if (!status || status.state !== "Idle" || String(status.FS || "") !== "0,0" || status.Pn) return "";
  return `${movingReason || "operation"} left the motion flag set for ${Math.round((Date.now() - movingSince) / 1000)}s while the controller reported Idle at FS:0,0 with no active job`;
};
// Called from health(), which the UI polls, so recovery becomes reachable again
// without an operator having to restart the bridge.
const clearStaleMotionFlag = () => {
  const reason = staleMotionReason();
  if (!reason) return false;
  recordEvent("controller.stale_motion_flag_cleared", { reason, movingReason, movingSinceMs: Date.now() - movingSince });
  setMoving(false);
  return true;
};
let frameIncident;
let frameRecovery = { active: false, message: "" };
try { frameIncident = readFrameIncident(FRAME_INCIDENT_PATH); } catch (error) { frameIncident = writeFrameIncident(FRAME_INCIDENT_PATH, { reason: `INVALID_FRAME_INCIDENT_STATE:${error.message}`, duringMotion: false }); }
let reconnectPromise;
let nextReconnectAt = 0;
let nextStoppedFrameCheckAt = 0;
let connectionCheckActive = false;
const RECONNECT_BACKOFF_MS = 10_000;
const workspace = new VirtualWorkspace();
const setup = { xyReady: false, xyLockStatus: "unlocked", xyLockedAt: null, bedProbeReady: false, stockProbeReady: false, probeReady: false, probeLocked: false, probeLockStatus: "unlocked", probeLockedAt: null, probeThickness: null, probePhase: "idle", probeTravelledMm: 0, probeSearchLimitMm: null, bedSurfaceMPos: null, stockSurfaceMPos: null, stockThicknessMm: null, safetyFloorMm: null, maxCutDepthMm: null, materialReady: false, savedStockThicknessMm: null, savedSafetyFloorMm: null, xyOriginMPos: null, zOriginMPos: null, updatedAt: null };
// A material profile derived from an invalidated calibration is wrong by the
// same amount. Reject it at boot too, so a restart cannot resurrect the stale
// measurements and report materialReady on a Z reference we already rejected.
const materialProfileIsStale = (material, invalidation) => {
  const invalidatedAt = Date.parse(invalidation?.invalidatedAt || "");
  if (!Number.isFinite(invalidatedAt)) return false;
  const capturedAt = Date.parse(material?.capturedAt || "");
  return !Number.isFinite(capturedAt) || capturedAt <= invalidatedAt;
};
try {
  const material = readMaterialProfile(MATERIAL_STATE_PATH);
  if (material && materialProfileIsStale(material, readProbeLockInvalidation(PROBE_STATE_PATH))) {
    process.stderr.write(`[cnc] rejected material profile captured ${material.capturedAt}: its Z calibration was invalidated\n`);
  } else if (material) applyMaterialProfile(setup, material);
} catch (error) { process.stderr.write(`[cnc] ignored invalid material profile: ${error.message}\n`); }
const job = { state: "idle", jobId: null, progress: 0, message: "", updatedAt: null };
let activeRunCheckpoint;
try { activeRunCheckpoint = readRunCheckpoint(RUN_STATE_PATH); } catch { activeRunCheckpoint = undefined; }

const json = (res, status, value) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(value)); };
const recordEvent = (type, detail = {}) => { try { appendCncEvent(EVENT_JOURNAL_PATH, type, detail); } catch (error) { logConnectionEvent?.(`journal:${error.message}`, `[cnc] event journal: ${error.message}`); } };
const assertSetupFrame = () => { if (!frameRecovery.active) assertFrameValid(frameIncident); };
const motionGuard = async () => { assertSetupFrame(); return { state: "controller_and_software_guards", frameValid: !frameIncident?.latched }; };
const latchFrameIncident = (reason, duringMotion = hazardousOperationActive?.() === true) => {
  const message = String(reason || "CONTROLLER_CONNECTION_LOST");
  // Losing the frame means the physical relationship the proof asserted is no
  // longer established. Never let a proof survive a frame incident.
  clearSurfaceProof(`frame invalidated: ${message}`);
  // Repeated failed reconnects must not replace the original incident evidence.
  if (!frameIncident?.latched) frameIncident = writeFrameIncident(FRAME_INCIDENT_PATH, { reason: message, occurredAt: new Date().toISOString(), duringMotion, jobId: job.jobId || "" });
  frameRecovery = { active: false, message: "Connection interrupted. Reconnect to verify saved coordinates; the cut will not resume." };
  incident = message;
  workspace.clear();
  // Keep the calibration records for comparison. The cutting interlock makes
  // them unusable until independently verified against the live controller.
  recordEvent("controller.frame_invalidated", { reason: message, duringMotion, jobId: job.jobId, jobState: job.state });
  return frameIncident;
};

const programGuard = async ({ before, analysis, programContext }) => {
  assertFrameValid(frameIncident);
  if (/C752 nickel silver/i.test(String(programContext?.material || ""))) {
    // A program installed from an in-repo certified library must carry exactly
    // that library's provider; the library re-verified the bytes against a fixed
    // SHA-256 and re-ran the per-stage motion audit server-side. Anything with no
    // resolvable library is a hand-import and still has to be a kiri-moto export
    // with the full operator attestation. An unknown library id resolves to "",
    // so it falls back to the stricter kiri-moto requirement rather than to none.
    const libraryProvider = certifiedCam.certifiedLibraryProvider(String(programContext?.certifiedLibraryId || ""));
    const expectedProvider = libraryProvider || "kiri-moto";
    if (programContext?.camProvider !== expectedProvider || programContext?.camCertification !== "verified") throw new Error(`Metal program is not a certified ${expectedProvider} export`);
    for (const field of ["camSourceHash", "camAuditHash"]) if (!/^[a-f0-9]{64}$/.test(String(programContext?.[field] || ""))) throw new Error(`Metal CAM ${field} is invalid`);
    if (!["rough", "cleanup", "finish", "profile", "release"].includes(String(programContext?.camStage || ""))) throw new Error("Metal CAM operation is invalid");
    if (!String(programContext?.camTool || "").trim()) throw new Error("Metal CAM tool contract is missing");
    // A stage that cuts through the blank is only executable if its certified
    // through-depth still agrees with THIS bridge's probed thickness. The same
    // function the API uses, so the refusal and the 409 cannot disagree.
    // approvedProgramDepth below independently re-derives the depth ceiling; this
    // states the rule as its own refusal so the reason given is the real one.
    const thicknessHold = camStageGate.certifiedThicknessHold(
      {
        profileDepthMm: programContext?.profileDepthMm,
        certifiedLibraryId: programContext?.certifiedLibraryId,
        allowSacrificialCutThrough: programContext?.allowSacrificialCutThrough === true,
      },
      String(programContext?.camStage || ""),
      setup,
      certifiedCam,
    );
    if (thicknessHold) throw new Error(thicknessHold);
  }
  const snap = workspace.snapshot();
  if (!snap.calibrated) throw new Error("Virtual boundaries are not calibrated");
  if (!setup.xyReady) throw new Error("Set X/Y zero before starting");
  if (!setup.bedProbeReady || !setup.stockProbeReady || !setup.probeReady) throw new Error("Probe the bed and stock before starting");
  if (!setup.probeLocked) throw new Error("Lock the probe calibration before starting");
  // The controller reporting work Z zero is NOT evidence that the bit is at the
  // surface; it only means the arithmetic that produced that zero was consistent.
  // Require an independent, plate-free measurement taken immediately beforehand.
  // Fails closed: no proof, expired proof, or proof bound to a different plate or
  // Z reference all stop the start here, in the daemon, regardless of the UI.
  if (!plateConfig.confirmed) {
    throw new Error(`The Z-probe plate thickness has never been confirmed (using the ${configuredPlateMm().toFixed(2)} mm default). Measure your plate, save it, re-probe, and verify surface contact before cutting.`);
  }
  assertSurfaceProofReady(surfaceProof, {
    setup,
    plateThicknessMm: configuredPlateMm(),
    material: programContext?.material,
    metalMode: programContext?.metalMode === true,
  });
  const allowedProgramDepthMm = approvedProgramDepth(setup, programContext);
  validateProgramEnvelope(analysis, { widthMm: 360, heightMm: 360, maxDepthMm: allowedProgramDepthMm, maxSafeZMm: 6 });
  validateProgramStockEnvelope(analysis, { widthMm: programContext?.stockWidthMm, heightMm: programContext?.stockHeightMm, reserveMm: programContext?.stockReserveMm });
  const current = coordinates(before);
  for (const axis of ["X", "Y", "Z"]) {
    const allowed = snap.bounds[axis];
    const aboveFiniteMaximum = axis !== "Z" && Number.isFinite(allowed.max) && current[axis] > allowed.max + 0.001;
    if (current[axis] < allowed.min - 0.001 || aboveFiniteMaximum) {
      const allowedText = axis === "Z" ? `${allowed.min.toFixed(3)} or higher` : `${allowed.min.toFixed(3)}..${allowed.max.toFixed(3)}`;
      throw new Error(`Current ${axis} position ${current[axis].toFixed(3)} is outside the calibrated controller frame ${allowedText}; reset coordinates before starting`);
    }
  }
  const origins = { X: setup.xyOriginMPos?.X, Y: setup.xyOriginMPos?.Y, Z: setup.zOriginMPos };
  for (const axis of ["X", "Y", "Z"]) {
    if (!Number.isFinite(origins[axis])) throw new Error(`${axis} work origin is unavailable`);
    const low = origins[axis] + analysis.bounds[axis].min, high = origins[axis] + analysis.bounds[axis].max, allowed = snap.bounds[axis];
    const allowedMin = axis === "Z" && allowedProgramDepthMm > setup.maxCutDepthMm ? origins.Z - allowedProgramDepthMm : allowed.min;
    const aboveFiniteMaximum = axis !== "Z" && Number.isFinite(allowed.max) && high > allowed.max + 0.001;
    if (low < allowedMin - 0.001 || aboveFiniteMaximum) {
      const allowedText = axis === "Z" ? `${allowedMin.toFixed(3)} or higher` : `${allowed.min.toFixed(3)}..${allowed.max.toFixed(3)}`;
      throw new Error(`${axis} program envelope ${low.toFixed(3)}..${high.toFixed(3)} exceeds virtual boundary ${allowedText}`);
    }
  }
};

controller = new GrblTcpController({ host: HOST, port: PORT, statusTimeoutMs: STATUS_TIMEOUT_MS, commandTimeoutMs: 20_000, motionGuard, workspaceGuard: (request) => workspace.assertJog(request), programGuard, maxJogMm: 25, maxJogFeed: 500, maxSessionTravelMm: 2000, maxSpindleTestRpm: 2000, maxProgramSocketLines: 0 });
const persistRunProgress = (patch) => {
  if (!activeRunCheckpoint) return null;
  activeRunCheckpoint = writeRunCheckpoint(RUN_STATE_PATH, { ...activeRunCheckpoint, ...patch, updatedAt: new Date().toISOString() });
  return activeRunCheckpoint;
};
const workPositionForStatus = (status) => {
  const machine = coordinates(status);
  const origin = { X: Number(setup.xyOriginMPos?.X), Y: Number(setup.xyOriginMPos?.Y), Z: Number(setup.zOriginMPos) };
  if (![machine.X, machine.Y, machine.Z, origin.X, origin.Y, origin.Z].every(Number.isFinite)) return null;
  return { X: machine.X - origin.X, Y: machine.Y - origin.Y, Z: machine.Z - origin.Z };
};
const captureInterruptedPosition = (status, reason, { initial = false, moved = false } = {}) => {
  if (activeRunCheckpoint?.state !== "interrupted") return null;
  const position = workPositionForStatus(status);
  if (!position) return null;
  return persistRunProgress({
    stopWorkPosition: initial ? position : activeRunCheckpoint.stopWorkPosition,
    postStopPosition: position,
    postStopMoveCount: Number(activeRunCheckpoint.postStopMoveCount || 0) + (moved ? 1 : 0),
    positionReason: reason,
    positionUpdatedAt: new Date().toISOString(),
  });
};
controller.on("cutFrameVerified", value => recordEvent("program.effective_frame_verified", value));
controller.on("programProgress", (value) => {
  Object.assign(job, { progress: value.progress, message: `Line ${value.line} of ${value.total}`, updatedAt: new Date().toISOString() });
  persistRunProgress({ state: "running", lastCompletedLine: value.line, totalLines: value.total, message: job.message });
});
controller.on("programTransportRefreshed", (value) => {
  recordEvent("controller.transport-refreshed", {
    line: value.line,
    total: value.total,
    before: value.before,
    after: value.after,
  });
});
controller.on("probeProgress", (value) => {
  Object.assign(setup, {
    probePhase: String(value?.phase || "idle"),
    probeTravelledMm: Number(value?.travelledMm) || 0,
    probeSearchLimitMm: Number.isFinite(Number(value?.limitMm)) ? Number(value.limitMm) : null,
    updatedAt: new Date().toISOString(),
  });
});
const clearSetup = () => (clearSurfaceProof("setup cleared"), Object.assign(setup, { xyReady: false, xyLockStatus: "unlocked", xyLockedAt: null, bedProbeReady: false, stockProbeReady: false, probeReady: false, probeLocked: false, probeLockStatus: "unlocked", probeLockedAt: null, probeThickness: null, probePhase: "idle", probeTravelledMm: 0, probeSearchLimitMm: null, bedSurfaceMPos: null, stockSurfaceMPos: null, stockThicknessMm: null, safetyFloorMm: null, maxCutDepthMm: null, materialReady: false, savedStockThicknessMm: null, savedSafetyFloorMm: null, xyOriginMPos: null, zOriginMPos: null, updatedAt: new Date().toISOString() }));
// Any probe-setup clear invalidates the surface proof: the Z reference it
// corroborated no longer exists.
const clearProbeSetup = (status = "unlocked_reprobe_required") => (clearSurfaceProof(`probe setup cleared (${status})`), Object.assign(setup, { bedProbeReady: false, stockProbeReady: false, probeReady: false, probeLocked: false, probeLockStatus: status, probeLockedAt: null, probeThickness: null, probePhase: "idle", probeTravelledMm: 0, probeSearchLimitMm: null, bedSurfaceMPos: null, stockSurfaceMPos: null, stockThicknessMm: null, safetyFloorMm: null, maxCutDepthMm: null, zOriginMPos: null, updatedAt: new Date().toISOString() }));
const rebuildWorkspaceFromSetup = () => {
  if (!setup.xyReady || !setup.probeReady || !Number.isFinite(setup.xyOriginMPos?.X) || !Number.isFinite(setup.xyOriginMPos?.Y) || !Number.isFinite(setup.zOriginMPos) || !Number.isFinite(setup.maxCutDepthMm)) { workspace.clear(); return null; }
  let saved; try { saved = readProgram(PROGRAM_STATE_PATH); } catch {}
  if (!(Number(saved?.context?.stockWidthMm) > 0 && Number(saved?.context?.stockHeightMm) > 0)) { workspace.clear(); return null; }
  const stock = positioningBoundsFromStock(setup.xyOriginMPos, saved?.context || {});
  return workspace.setBounds({ ...stock, Z: { min: setup.zOriginMPos - setup.maxCutDepthMm, max: null } });
};
const persistLockedXy = (status) => {
  if (!setup.xyReady) return null;
  const lock = xyLockFromSetup(setup, status);
  writeXyLock(XY_STATE_PATH, lock);
  setup.xyLockStatus = "locked";
  setup.xyLockedAt = lock.lockedAt;
  return lock;
};
const restoreLockedXy = (status, workOffset) => {
  const raw = readXyLock(XY_STATE_PATH);
  if (!raw) return null;
  try { return applyXyLock(setup, raw, status, PROBE_LOCK_TOLERANCE_MM, workOffset); }
  catch (error) {
    setup.xyReady = false;
    setup.xyLockStatus = `rejected: ${error.message}`;
    setup.updatedAt = new Date().toISOString();
    return null;
  }
};
const persistLockedProbe = (status) => {
  if (!setup.probeLocked) return null;
  const lock = calibrationFromSetup(setup, status);
  writeProbeLock(PROBE_STATE_PATH, lock);
  if (!String(setup.probeLockStatus || "").startsWith("locked_after_")) setup.probeLockStatus = "locked";
  setup.probeLockedAt = lock.lockedAt;
  return lock;
};
const persistMaterialProfile = () => {
  const profile = materialProfileFromSetup(setup);
  writeMaterialProfile(MATERIAL_STATE_PATH, profile);
  applyMaterialProfile(setup, profile);
  return profile;
};
const restoreLockedProbe = (status, workOffset, options) => {
  const raw = readProbeLock(PROBE_STATE_PATH);
  if (!raw) return null;
  try {
    // REJECT, never migrate. A calibration captured with a different plate has a
    // wrong absolute Z zero by exactly that difference, and the error is invisible
    // in its own recorded stock thickness because it cancels in bed-minus-stock.
    // Rescaling it would be guessing; the only safe answer is a fresh probe.
    // The comparison target comes from the independent plate-config file, never
    // from this record, so a stale 20 mm lock cannot validate itself.
    if (!plateThicknessMatches(raw.probeThickness, configuredPlateMm())) {
      throw new Error(`saved calibration used a ${Number(raw.probeThickness).toFixed(2)} mm probe plate but ${configuredPlateMm().toFixed(2)} mm is configured; its Z zero is wrong by ${Math.abs(Number(raw.probeThickness) - configuredPlateMm()).toFixed(2)} mm. Re-probe the bed and stock; this calibration cannot be converted.`);
    }
    return applyProbeLock(setup, raw, status, PROBE_LOCK_TOLERANCE_MM, workOffset, options);
  }
  catch (error) {
    setup.probeLocked = false;
    setup.probeLockStatus = `rejected: ${error.message}`;
    setup.updatedAt = new Date().toISOString();
    return null;
  }
};
const hazardousOperationActive = () => moving || ["running", "paused"].includes(job.state);
let lastConnectionLog = { key: "", at: 0 };
const logConnectionEvent = (key, message) => {
  const now = Date.now();
  if (lastConnectionLog.key !== key || now - lastConnectionLog.at >= 60_000) {
    process.stderr.write(`${message}\n`);
    lastConnectionLog = { key, at: now };
  }
};
controller.on("fault", (error) => {
  const hazardous = hazardousOperationActive();
  incident = error?.message || "CONTROLLER_FAULT";
  if (hazardous || /timeout|socket|connection|EHOSTUNREACH|ECONN|GRBL response/i.test(incident)) latchFrameIncident(incident, hazardous);
  logConnectionEvent(`fault:${incident}`, `[cnc] controller fault hazardous=${hazardous}: ${incident}`);
  recordEvent("controller.fault", { hazardous, incident, jobId: job.jobId, jobState: job.state });
  if (["running", "paused"].includes(job.state)) {
    Object.assign(job, { state: "interrupted", message: incident, updatedAt: new Date().toISOString() });
    persistRunProgress({ state: "interrupted", message: incident });
  }
});
controller.on("close", () => {
  const hazardous = hazardousOperationActive();
  latchFrameIncident("CONTROLLER_CONNECTION_LOST", hazardous);
  logConnectionEvent(`close:${hazardous}`, `[cnc] controller close hazardous=${hazardous}`);
  recordEvent("controller.close", { hazardous, incident, jobId: job.jobId, jobState: job.state });
  if (["running", "paused"].includes(job.state)) {
    Object.assign(job, { state: "interrupted", message: incident || "Controller connection lost", updatedAt: new Date().toISOString() });
    persistRunProgress({ state: "interrupted", message: job.message });
  }
});

const readStatus = async () => (lastControllerStatus = parseStatus(await controller.status({ attempts: 5 })));
const finishFrameRecovery = () => {
  if (!frameRecovery.active || !setup.xyReady || !setup.probeLocked) return;
  if (frameIncident?.latched) frameIncident = resolveFrameIncident(FRAME_INCIDENT_PATH, { xyReady: true, probeLocked: true, xyLockStatus: setup.xyLockStatus, probeLockStatus: setup.probeLockStatus });
  frameRecovery = { active: false, message: "Coordinates verified. No cut resumed; Start remains subject to all job checks." };
  incident = undefined;
  recordEvent("controller.frame_verified", { xyLockStatus: setup.xyLockStatus, probeLockStatus: setup.probeLockStatus });
};
// Reading saved records must NEVER be able to strand the operator. A corrupt or
// unreadable lock means "you have no saved coordinates, set them again" — it is
// a reason to enter manual setup, not a reason to abort recovery. Before this
// was fault-isolated, one unreadable calibration threw here and left the frame
// incident latched with frameRecovery.active false, which blocks jog and probe,
// hides X/Y and probe recovery, and makes Start permanently unreachable, because
// clearing the latch itself requires a probe that the latch forbids.
const restoreVerifiedCalibration = (status, workOffset) => {
  let xyLock = null, probeLock = null;
  const unreadable = [];
  try { xyLock = readXyLock(XY_STATE_PATH); } catch (error) { unreadable.push(`saved X/Y origin (${error.message})`); }
  try { probeLock = readProbeLock(PROBE_STATE_PATH); } catch (error) { unreadable.push(`saved Z calibration (${error.message})`); }
  const checked = inspectSavedFrame({ status, workOffset, xyLock, probeLock });
  if ((xyLock && !checked.xy) || (probeLock && !checked.z)) latchFrameIncident("SAVED_COORDINATE_CONTINUITY_UNVERIFIED", false);
  clearSetup();
  // A material profile is only as good as the Z reference that produced it. If
  // the calibration was invalidated, any profile captured at or before that
  // moment carries the same error and must not report materialReady.
  const invalidation = readProbeLockInvalidation(PROBE_STATE_PATH);
  try {
    const material = readMaterialProfile(MATERIAL_STATE_PATH);
    if (material && materialProfileIsStale(material, invalidation)) {
      recordEvent("material.profile_rejected_stale", { capturedAt: material.capturedAt, invalidatedAt: invalidation.invalidatedAt });
    } else if (material) {
      applyMaterialProfile(setup, material);
    }
  } catch (error) { unreadable.push(`saved material profile (${error.message})`); }
  lastWorkOffset = workOffset;
  if (checked.xy) { try { restoreLockedXy(status, workOffset); } catch (error) { unreadable.push(`X/Y restore (${error.message})`); } }
  if (checked.z) { try { restoreLockedProbe(status, workOffset, { independentlyVerifiedZ: true }); } catch (error) { unreadable.push(`Z restore (${error.message})`); } }
  const notes = [checked.message];
  if (invalidation && !probeLock) notes.push(`Saved Z calibration is invalidated and will not be reused: ${invalidation.reason}`);
  if (unreadable.length) notes.push(`Could not reuse ${unreadable.join("; ")}. Set the affected coordinates again; nothing was moved.`);
  // Unconditional: manual setup is always reachable after a verified read.
  frameRecovery = { active: true, message: notes.join(" ") };
  try { rebuildWorkspaceFromSetup(); } catch (error) { frameRecovery.message += ` Workspace bounds need a fresh probe (${error.message}).`; }
  finishFrameRecovery();
  return checked;
};
const reconnectAndVerifyFrame = async () => {
  if (hazardousOperationActive()) throw new Error("Stop the active operation before reconnecting");
  if (reconnectPromise) throw new Error("A connection check is already in progress");
  connectionCheckActive = true;
  setMoving(true, "reconnect and verify frame"); // serialize connection verification against setup and Start
  try {
  frameRecovery = { active: false, message: "Reading controller state and saved calibration" };
  await controller.resetConnection(); // TCP only: not a GRBL reset, unlock or cycle start.
  const before = await readStatus();
  if (before.state !== "Idle" || before.FS !== "0,0" || before.Pn) {
    const alarm = before.state === "Alarm" && before.FS === "0,0";
    frameRecovery.active = alarm;
    frameRecovery.message = alarm ? `Controller alarm${before.Pn ? `: active ${before.Pn} input` : ""}. Use the explicit alarm/limit recovery control; saved coordinates are retained.` : `Controller reports ${before.state}. No cycle-start or reset was sent. For Hold/Door: switch the external router OFF, power the controller OFF then ON without moving the gantry, then press Reconnect. This discards the held buffer; Project can then offer saved X/Y recovery instead of requiring a new zero.`;
    return { ok: true, status: before, frameRecovery };
  }
  const workOffset = parseWorkOffset(await controller.query("$#"));
  const after = await readStatus();
  if (after.state !== "Idle" || after.FS !== "0,0" || after.Pn || after.MPos !== before.MPos) throw new Error("Controller changed during coordinate verification; no setup enabled");
  restoreVerifiedCalibration(after, workOffset);
  recordEvent("controller.reconnected_read_only", { xyVerified: setup.xyReady, zVerified: setup.probeLocked, status: after.raw });
  return { ok: true, status: after, setup: { ...setup }, frameRecovery };
  } finally { connectionCheckActive = false; setMoving(false); }
};
const recoverIdleConnection = async () => {
  if (frameIncident?.latched) return;
  if (controller.connected || hazardousOperationActive()) return;
  if (reconnectPromise) return reconnectPromise;
  if (Date.now() < nextReconnectAt) return;
  nextReconnectAt = Date.now() + RECONNECT_BACKOFF_MS;
  reconnectPromise = (async () => {
    setMoving(true, "idle connection recovery");
    await controller.resetConnection();
    const startupStatus = await readStatus();
    await restoreHardLimitsOnStartup(startupStatus);
    if (!controller.connected) throw new Error("Controller disconnected during startup safety check");
    if (startupStatus.state !== "Idle") {
      setup.xyLockStatus = `rejected: controller startup state ${startupStatus.state} requires explicit recovery`;
      setup.probeLockStatus = `rejected: controller startup state ${startupStatus.state} requires explicit recovery`;
      workspace.clear();
      incident = undefined;
      return;
    }
    const workOffset = parseWorkOffset(await controller.query("$#"));
    lastWorkOffset = workOffset;
    const verifiedStatus = await readStatus();
    if (verifiedStatus.state !== "Idle" || verifiedStatus.FS !== "0,0" || verifiedStatus.Pn || verifiedStatus.MPos !== startupStatus.MPos) throw new Error("Controller changed during startup coordinate verification");
    restoreVerifiedCalibration(verifiedStatus, workOffset);
    captureInterruptedPosition(startupStatus, "startup_recovery");
    incident = undefined;
  })().catch((error) => {
    incident = `CONNECT_FAILED:${error?.message || "unknown"}`;
  }).finally(() => { setMoving(false); reconnectPromise = undefined; });
  return reconnectPromise;
};
const xyRecoverySnapshot = () => {
  try {
    const lock = readXyLock(XY_STATE_PATH);
    if (!lock || setup.xyReady || lastControllerStatus?.state !== "Idle" || !lastWorkOffset) return { available: false };
    const plan = planXyPowerCycleRecovery(lock, lastControllerStatus, lastWorkOffset);
    return { available: true, savedWorkPosition: plan.savedWorkPosition, rebasedOriginMPos: plan.rebasedOriginMPos, lockedAt: plan.lock.lockedAt };
  } catch (error) { return { available: false, reason: error?.message || "X/Y recovery unavailable" }; }
};
const probeRecoverySnapshot = () => {
  const prior = readLatestCompletedStockProbe(EVENT_JOURNAL_PATH), ageMs = prior ? Date.now() - Date.parse(prior.at) : NaN;
  const continuousXyLock = setup.xyReady && new Set(["locked", "restored"]).has(setup.xyLockStatus);
  return { available: !!prior && Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= SAVED_MEASUREMENT_MAX_AGE_MS && continuousXyLock && !setup.probeLocked, sourceProbeAt: prior?.at || null, stockThicknessMm: prior?.stockThicknessMm ?? null, maxCutDepthMm: prior?.maxCutDepthMm ?? null };
};
// Read-only recovery is housekeeping, not an operator prerequisite. It never
// unlocks, resets coordinates, moves, or releases a held program.
const autoVerifyStoppedFrame = () => {
  if (!frameIncident?.latched || frameRecovery.active || hazardousOperationActive() || reconnectPromise || Date.now() < nextStoppedFrameCheckAt) return;
  nextStoppedFrameCheckAt = Date.now() + RECONNECT_BACKOFF_MS;
  void reconnectAndVerifyFrame().catch(error => {
    incident = `STOPPED_FRAME_CHECK_FAILED:${error.message}`;
    logConnectionEvent(incident, `[cnc] ${incident}`);
  });
};
// Surfaced so the operator can SEE the plate figure and the absolute references it
// produced. A 6 mm plate error was invisible for days precisely because the UI only
// ever showed derived numbers, which all agreed with each other.
const plateSnapshot = () => ({
  thicknessMm: configuredPlateMm(),
  confirmed: plateConfig.confirmed === true,
  // Published so the UI can show WHERE the number came from. A 6 mm error stayed
  // invisible for days partly because the interface never showed the plate used.
  measuredBy: plateConfig.measuredBy || "unattributed",
  minMm: PROBE_PUCK_MIN_MM,
  maxMm: PROBE_PUCK_MAX_MM,
  updatedAt: plateConfig.updatedAt || null,
  source: plateConfig.source || "",
});
const surfaceProofSnapshot = () => {
  const status = surfaceProofStatus(surfaceProof, { setup, plateThicknessMm: configuredPlateMm() });
  return {
    // `ready` here is the non-metal answer. Metal additionally requires a measured
    // touch, which the daemon enforces at Start and the UI mirrors by method.
    ready: status.ready,
    reason: status.reason || (surfaceProof ? "" : surfaceProofClearedReason),
    toleranceMm: SURFACE_PROOF_TOLERANCE_MM,
    proof: surfaceProof ? { ...surfaceProof } : null,
  };
};
// WHY RESUMABILITY IS DECIDED HERE AND NOT IN THE UI:
// /health used to publish the raw checkpoint, so any client that saw
// state === "interrupted" rendered a resume affordance. The checkpoint left by
// the 2026-09-30 stop (job cnc_mun692ol2mq, line 1676 of 173218) belongs to the
// certified metal rough stage that ran against a 20 mm plate figure against a
// ~14.19 mm plate, so every commanded depth was about 5.8 mm too deep. Resuming
// it would repeat the damage at the exact depth that caused it.
//
// resumeSavedProgram already refuses that program, but a button that always
// fails is still wrong: it tells the operator a recovery path exists. Decide it
// once, server-side, fail closed, and state the reason — the UI then has no
// judgement left to get wrong.
const resumeSnapshot = () => {
  if (!activeRunCheckpoint) return null;
  const base = { ...activeRunCheckpoint, resumable: false, blockedReason: "", requiresFreshSetup: false };
  const refuse = (blockedReason, requiresFreshSetup = false) => ({ ...base, blockedReason, requiresFreshSetup });

  // A latched frame incident means the machine coordinate frame the checkpoint
  // was recorded in is no longer established. Nothing may be offered but setup.
  if (frameIncident?.latched) {
    return refuse(`The coordinate frame was invalidated by ${frameIncident.reason}. This checkpoint cannot be resumed; set up X/Y and Z again and restart the stage from line 1.`, true);
  }
  if (String(activeRunCheckpoint.state || "") !== "interrupted" || !(Number(activeRunCheckpoint.lastCompletedLine) > 0)) {
    return refuse("No interrupted checkpoint is available to resume.");
  }

  let saved = null;
  try { saved = readProgram(PROGRAM_STATE_PATH); } catch { /* treated as absent below */ }
  if (!saved) return refuse("The program this checkpoint belongs to is no longer stored.", true);
  if (saved.capturedAt !== activeRunCheckpoint.programCapturedAt) {
    return refuse("This checkpoint belongs to a different program than the one now stored.", true);
  }

  const context = saved.context || {};
  if (/C752 nickel silver/i.test(String(context.material || ""))) {
    return refuse("Resume is permanently disabled for metal. Restart the certified Kiri:Moto stage from line 1 after deliberate X/Y and Z recovery.", true);
  }
  // The cut hold is conditional on the Z reference being proven, so it must be
  // asked with this daemon's live plate/calibration/proof evidence. Passing no
  // evidence would make it answer "held" unconditionally and fail closed, which
  // is safe but uninformative; passing the real snapshot makes the reason true.
  // Detail form, so a hold whose only outstanding item is the surface-contact
  // proof does not tell the operator to tear down and re-probe. A wrong or
  // unknown Z reference still demands a fresh setup.
  const hold = programHolds.programAuditHoldDetail(
    { camSourceHash: context.camSourceHash, certifiedLibraryId: context.certifiedLibraryId, material: context.material },
    { plate: plateSnapshot(), setup, surfaceProof: surfaceProofSnapshot() },
  );
  if (hold.reason) return refuse(hold.reason, hold.requiresFreshSetup);
  if (!context.manualRouter) return refuse("Automatic resume is limited to manual-router stages.");

  // The depth error that caused the incident was a plate-thickness error, so a
  // resume is only ever offered against a confirmed plate and a calibration
  // captured with that same plate.
  if (!plateConfig.confirmed) {
    return refuse(`The Z-probe plate thickness has never been confirmed (using the ${configuredPlateMm().toFixed(2)} mm default). Measure and save your plate, then re-probe.`, true);
  }
  if (!setup.probeLocked) return refuse("No locked Z calibration is available. Re-probe and lock before any resume.", true);
  if (!plateThicknessMatches(setup.probeThickness, configuredPlateMm())) {
    return refuse(`The locked calibration used a ${Number(setup.probeThickness).toFixed(2)} mm plate but ${configuredPlateMm().toFixed(2)} mm is configured. Re-probe instead of resuming.`, true);
  }
  return { ...base, resumable: true };
};
const health = () => {
  // Order matters: release a provably stale motion flag BEFORE the auto-reconnect
  // test below, because hazardousOperationActive() consults `moving`, so a latched
  // flag would otherwise suppress reconnection forever. The UI polls /health, so
  // doing it here makes recovery reachable without restarting the bridge.
  clearStaleMotionFlag();
  autoVerifyStoppedFrame();
  if (!controller.connected && !hazardousOperationActive() && !frameIncident?.latched) void recoverIdleConnection();
  return { ok: true, connected: controller.connected, reconnecting: Boolean(reconnectPromise) || connectionCheckActive, moving, incident, frameValid: !frameIncident?.latched, frameIncident: frameIncident ? { ...frameIncident } : null, frameRecovery: { ...frameRecovery }, lastControllerStatus, workspace: workspace.snapshot(), setup: { ...setup }, plate: plateSnapshot(), surfaceProof: surfaceProofSnapshot(), xyRecovery: (!frameIncident?.latched || frameRecovery.active) && controller.connected ? xyRecoverySnapshot() : { available: false }, probeRecovery: !frameIncident?.latched && controller.connected ? probeRecoverySnapshot() : { available: false }, job: { ...job }, resume: resumeSnapshot() };
};
const observe = async () => ({ cnc: await readStatus() });
const assertIdle = async () => { const status = await readStatus(); if (new Set(["Door:0", "Hold:0"]).has(status.state)) throw new Error(`Controller positioning is paused in ${status.state}. The external router may be removed; use Enable positioning first.`); if (status.state !== "Idle") throw new Error(`Controller must report Idle before positioning, got ${status.state}`); const [feed, spindle] = String(status.FS || "0,0").split(",").map(Number); if (feed || spindle) throw new Error(`Commanded feed/spindle must be zero, got ${status.FS}`); return status; };

const jog = async (axis, payload) => {
  assertSetupFrame();
  if (moving || ["running", "paused"].includes(job.state)) throw new Error("A CNC operation is already active");
  setMoving(true, "jog"); incident = undefined;
  try {
    await motionGuard();
    const distance = Number(payload.distanceMm);
    if (frameRecovery.active && (!Number.isFinite(distance) || Math.abs(distance) > 5 || Number(payload.feedMmPerMin) > 100)) throw new Error("Recovery positioning is limited to 5 mm at 100 mm/min per click");
    if (axis === "Z" && (!Number.isFinite(distance) || Math.abs(distance) > 5)) throw new Error("Z jogs are limited to 5 mm per Project command");
    if (axis === "Z" && setup.probeLocked) assertLockedProbeZJog(setup, await assertIdle(), distance);
    if (new Set(["X", "Y"]).has(axis) && setup.xyReady) {
      const before = await assertIdle(), workPosition = workPositionForStatus(before);
      assertWorkJogWithinStock({ workPosition, axis, distanceMm: distance, stockWidthMm: payload.stockWidthMm, stockHeightMm: payload.stockHeightMm });
    }
    if (new Set(["X", "Y"]).has(axis) && !setup.xyReady && !frameRecovery.active) throw new Error("Verify coordinates before manual positioning");
    const manualPositioning = Boolean(payload.manualPositioning);
    const calibration = manualPositioning && !workspace.snapshot().calibrated;
    const safeRetract = manualPositioning && axis === "Z" && distance > 0;
    const negativeWorkspaceMarginMm = manualPositioning && new Set(["X", "Y"]).has(axis) ? 60 : 0;
    const result = await controller.jog(axis, payload.distanceMm, payload.feedMmPerMin, { calibration, safeRetract, negativeWorkspaceMarginMm });
    lastControllerStatus = result.after;
    persistLockedXy(result.after);
    persistLockedProbe(result.after);
    captureInterruptedPosition(result.after, `jog_${axis.toLowerCase()}`, { moved: true });
    return result;
  }
  catch (error) { incident = error?.message || "JOG_FAILED"; throw error; } finally { setMoving(false); }
};
const spindleTest = async () => {
  assertFrameValid(frameIncident);
  if (moving || ["running", "paused"].includes(job.state)) throw new Error("A CNC operation is already active");
  setMoving(true, "spindle test"); incident = undefined;
  try { await motionGuard(); const result = await controller.spindleTest(1000, 2000); lastControllerStatus = result.after; return result; }
  catch (error) { incident = error?.message || "SPINDLE_TEST_FAILED"; throw error; } finally { setMoving(false); }
};
const setXyZero = async (payload) => {
  assertSetupFrame();
  if (payload.confirmNewProject !== true) throw new Error("Explicit new-project X/Y reset confirmation is required");
  if (moving || ["running", "paused"].includes(job.state)) throw new Error("A CNC operation is already active");
  await motionGuard(); const before = await assertIdle(); await controller.setWorkOffset({ x: 0, y: 0 });
  setup.xyOriginMPos = coordinates(before); setup.xyReady = true; setup.updatedAt = new Date().toISOString();
  setup.xyLockStatus = "locked";
  persistLockedXy(before);
  if (setup.probeLocked) persistLockedProbe(before);
  rebuildWorkspaceFromSetup();
  finishFrameRecovery();
  recordEvent("origin.xy_zeroed", { probePreserved: setup.probeLocked === true, status: before.raw });
  return { setup: { ...setup }, status: before, probePreserved: setup.probeLocked === true };
};
const restoreProbeAfterXyOnlyReset = async (payload) => {
  assertFrameValid(frameIncident);
  if (payload.confirm !== true) throw new Error("Explicit X/Y-only probe restoration confirmation is required");
  if (moving || ["running", "paused"].includes(job.state)) throw new Error("A CNC operation is already active");
  if (!setup.xyReady || !new Set(["locked", "restored"]).has(setup.xyLockStatus)) throw new Error("A continuous saved X/Y frame is required before restoring probes");
  if (setup.probeLocked) throw new Error("Probe calibration is already locked");
  const prior = readLatestCompletedStockProbe(EVENT_JOURNAL_PATH);
  if (!prior) throw new Error("No completed stock probe is available to restore");
  const ageMs = Date.now() - Date.parse(prior.at);
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > SAVED_MEASUREMENT_MAX_AGE_MS) throw new Error("The saved stock probe is too old to restore safely");
  await motionGuard();
  // The restored reference is only as good as the plate used for the original probe.
  // Refuse to resurrect a measurement taken with a different plate than the one now set.
  const priorPuckMm = normalizePuckThickness(prior.probeThickness);
  if (priorPuckMm === null) throw new Error("The saved stock probe did not record a usable plate thickness; re-probe instead of restoring");
  if (!plateThicknessMatches(priorPuckMm, configuredPlateMm())) throw new Error(`The saved stock probe used a ${priorPuckMm.toFixed(2)} mm plate but ${configuredPlateMm().toFixed(2)} mm is configured; re-probe instead of restoring`);
  const status = await assertIdle(), workOffset = parseWorkOffset(await controller.query("$#")), stockSurfaceMPos = Number(workOffset.Z);
  if (!Number.isFinite(stockSurfaceMPos)) throw new Error("Current controller Z origin is unavailable");
  // Z CONTINUITY. This operation adopts the controller's current G54 Z as the
  // stock surface. That is only legitimate after an X/Y-ONLY reset, where Z was
  // never touched -- which is precisely the thing that was never checked. Without
  // it, any G54 Z the controller happened to be holding became "the stock
  // surface", and all the derived numbers (floor, maximum cut depth) were then
  // rebuilt around it and reported as a restored, locked calibration.
  //
  // The prior probe recorded its own absolute Z origin, so compare against it and
  // refuse a discontinuity rather than adopting it. Fails closed when the prior
  // entry predates the field: an unknown reference is not a matching one.
  const priorZOriginMPos = Number.isFinite(prior.zOriginMPos) ? prior.zOriginMPos : prior.stockSurfaceMPos;
  if (!Number.isFinite(priorZOriginMPos)) {
    throw new Error("The saved stock probe did not record its absolute Z origin, so Z continuity cannot be proven; re-probe instead of restoring");
  }
  const zDriftMm = Math.abs(stockSurfaceMPos - priorZOriginMPos);
  if (zDriftMm > PROBE_LOCK_TOLERANCE_MM) {
    throw new Error(`The controller Z origin is ${stockSurfaceMPos.toFixed(3)} mm but the saved stock probe was taken at ${priorZOriginMPos.toFixed(3)} mm, a ${zDriftMm.toFixed(3)} mm difference. Z is not continuous with that probe, so it cannot be restored; re-probe the bed and stock.`);
  }
  lastWorkOffset = workOffset;
  Object.assign(setup, {
    bedProbeReady: true, stockProbeReady: true, probeReady: true, probeLocked: true,
    probeLockStatus: "restored_after_xy_only_reset", probeLockedAt: new Date().toISOString(),
    probeThickness: priorPuckMm,
    bedSurfaceMPos: stockSurfaceMPos - prior.stockThicknessMm,
    stockSurfaceMPos,
    stockThicknessMm: prior.stockThicknessMm,
    safetyFloorMm: prior.safetyFloorMm,
    maxCutDepthMm: prior.maxCutDepthMm,
    zOriginMPos: stockSurfaceMPos,
    materialReady: true,
    savedStockThicknessMm: prior.stockThicknessMm,
    savedSafetyFloorMm: prior.safetyFloorMm,
    updatedAt: new Date().toISOString(),
  });
  persistMaterialProfile();
  persistLockedProbe(status);
  rebuildWorkspaceFromSetup();
  recordEvent("probe.restored_after_xy_only_reset", { sourceProbeAt: prior.at, stockThicknessMm: prior.stockThicknessMm, maxCutDepthMm: prior.maxCutDepthMm });
  return { ok: true, setup: { ...setup }, status, sourceProbeAt: prior.at };
};
const restoreXyAfterPowerCycle = async (payload) => {
  assertSetupFrame();
  if (payload.confirmGantryUnmoved !== true) throw new Error("Confirm the gantry was not moved while controller power was off");
  if (moving || ["running", "paused"].includes(job.state)) throw new Error("A CNC operation is already active");
  await motionGuard();
  const before = await assertIdle(), workOffsetBefore = parseWorkOffset(await controller.query("$#")), raw = readXyLock(XY_STATE_PATH);
  lastWorkOffset = workOffsetBefore;
  if (!raw) throw new Error("No saved X/Y stock origin is available");
  const plan = planXyPowerCycleRecovery(raw, before, workOffsetBefore);
  await controller.setWorkOffset({ x: plan.savedWorkPosition.X, y: plan.savedWorkPosition.Y });
  const workOffset = parseWorkOffset(await controller.query("$#"));
  lastWorkOffset = workOffset;
  for (const axis of ["X", "Y"]) {
    if (Math.abs(workOffset[axis] - plan.rebasedOriginMPos[axis]) > 0.05) throw new Error(`Restored ${axis} origin verification failed: expected ${plan.rebasedOriginMPos[axis]}, got ${workOffset[axis]}`);
  }
  // An independently verified Z is unaffected by this X/Y-only rebase.
  if (!setup.probeLocked) clearProbeSetup("power_cycle_reprobe_required");
  setup.xyReady = true;
  setup.xyLockStatus = "restored_after_power_cycle";
  setup.xyLockedAt = raw.lockedAt;
  setup.xyOriginMPos = { X: workOffset.X, Y: workOffset.Y, Z: coordinates(before).Z };
  setup.updatedAt = new Date().toISOString();
  const lock = persistLockedXy(before);
  rebuildWorkspaceFromSetup();
  lastControllerStatus = await readStatus();
  if (setup.probeLocked) persistLockedProbe(lastControllerStatus);
  finishFrameRecovery();
  captureInterruptedPosition(lastControllerStatus, "xy_power_cycle_restore");
  return { ok: true, status: lastControllerStatus, setup: { ...setup }, restoredWorkPosition: plan.savedWorkPosition, lock: { lockedAt: lock.lockedAt, lastKnownMPos: lock.lastKnownMPos } };
};
const setStockZZero = async (payload) => {
  assertSetupFrame();
  if (payload.confirm !== true) throw new Error("Explicit stock Z-zero confirmation is required");
  if (moving || ["running", "paused"].includes(job.state)) throw new Error("A CNC operation is already active");
  if (!setup.probeLocked || !setup.stockProbeReady || !Number.isFinite(setup.stockThicknessMm)) throw new Error("Lock a measured stock calibration before setting physical stock Z zero");
  await motionGuard();
  const before = await assertIdle(), position = coordinates(before), stockThicknessMm = Number(setup.stockThicknessMm);

  // BOUND THE NEW ZERO AGAINST SOMETHING THAT DID NOT MOVE.
  // This redefines absolute Z0 from wherever the operator has jogged to, and it
  // previously accepted ANY position: every derived number (bed surface,
  // protected floor, maximum cut depth) was then rebuilt around it. The only
  // check was `Math.abs(workOffset.Z - position.Z) > 0.05` AFTER calling
  // setWorkOffset({z: 0}), which is tautological -- that call defines G54 Z as
  // the current machine Z, so the two agree by construction and the comparison
  // can only fail if the controller malfunctioned. It proved nothing about
  // whether the position is anywhere near the real stock surface.
  //
  // The bed is a genuine independent measurement and it does not move when a bit
  // is changed or the stock is re-seated. So the thickness implied by the new
  // zero must agree with the measured stock thickness. That is a real invariant.
  const priorBedMPos = Number(setup.bedSurfaceMPos);
  if (!Number.isFinite(priorBedMPos)) throw new Error("No measured bed reference is available to bound a manual stock Z zero against; re-probe the bed and stock instead");
  const impliedThicknessMm = position.Z - priorBedMPos;
  if (impliedThicknessMm <= 0) {
    throw new Error(`This position is ${Math.abs(impliedThicknessMm).toFixed(3)} mm at or below the measured bed at machine Z ${priorBedMPos.toFixed(3)}. It cannot be the top of the stock.`);
  }
  if (Math.abs(impliedThicknessMm - stockThicknessMm) > MANUAL_Z_ZERO_TOLERANCE_MM) {
    throw new Error(`A stock top here implies a ${impliedThicknessMm.toFixed(3)} mm blank, but the measured thickness is ${stockThicknessMm.toFixed(3)} mm. That is a ${Math.abs(impliedThicknessMm - stockThicknessMm).toFixed(3)} mm disagreement against the measured bed, beyond the ${MANUAL_Z_ZERO_TOLERANCE_MM} mm manual allowance. Re-probe the bed and stock rather than redefining zero by hand.`);
  }

  await controller.setWorkOffset({ z: 0 });
  const workOffset = parseWorkOffset(await controller.query("$#"));
  lastWorkOffset = workOffset;
  // Kept, but understood for what it is: proof the controller accepted the write,
  // not proof the position is correct. The bound above is what does that.
  if (Math.abs(workOffset.Z - position.Z) > PROBE_LOCK_TOLERANCE_MM) throw new Error(`The controller did not accept the stock Z zero: expected G54 Z ${position.Z}, got ${workOffset.Z}`);
  setup.stockSurfaceMPos = position.Z;
  setup.bedSurfaceMPos = position.Z - stockThicknessMm;
  setup.zOriginMPos = position.Z;
  setup.probeLockStatus = "locked_touch_off";
  setup.probeLockedAt = new Date().toISOString();
  setup.updatedAt = setup.probeLockedAt;
  // This redefines absolute zero from an eyeballed position, so it replaces the
  // very reference any earlier surface proof corroborated.
  clearSurfaceProof("stock Z zero redefined by hand");
  persistLockedProbe(before);
  persistLockedXy(before);
  rebuildWorkspaceFromSetup();
  lastControllerStatus = await readStatus();
  captureInterruptedPosition(lastControllerStatus, "stock_z_zero", { moved: true });
  return { ok: true, setup: { ...setup }, status: lastControllerStatus, workOffset };
};
const probeSurface = async (kind, payload) => {
  assertSetupFrame();
  if (moving || ["running", "paused"].includes(job.state)) throw new Error("A CNC operation is already active");
  if (!new Set(["bed", "stock", "tool"]).has(kind)) throw new Error("Unknown probe surface");
  let materialProfile;
  if (kind === "bed") {
    if (setup.probeLocked && payload.confirmReprobe !== true) throw new Error("Probe calibration is locked; confirm a bed re-probe to replace it");
    removeProbeLock(PROBE_STATE_PATH);
    removeMaterialProfile(MATERIAL_STATE_PATH);
    clearProbeSetup("reprobe_in_progress");
    Object.assign(setup, { materialReady: false, savedStockThicknessMm: null, savedSafetyFloorMm: null });
    workspace.clear();
  }
  if (kind === "stock" && !setup.bedProbeReady) throw new Error("Probe the exposed bed before probing the stock");
  if (kind === "tool") {
    materialProfile = readMaterialProfile(MATERIAL_STATE_PATH);
    if (!materialProfile) throw new Error("Complete one bed + stock setup before touching off a changed bit");
    // A tool touch-off measures ONLY the new bit against the stock top, then
    // reconstructs the bed reference, the protected floor and the maximum cut
    // depth from this stored profile. That had no age bound at all, so a days-old
    // thickness could be reinstated as the live Z reference for a blank that may
    // since have been swapped, shifted or re-clamped.
    const profileAgeMs = Date.now() - Date.parse(String(materialProfile.capturedAt || ""));
    if (!Number.isFinite(profileAgeMs) || profileAgeMs < 0 || profileAgeMs > SAVED_MEASUREMENT_MAX_AGE_MS) {
      throw new Error(`The saved bed and stock measurement is from ${materialProfile.capturedAt || "an unrecorded time"} and is too old to rebuild the Z reference from. Probe the bed and stock again for this blank.`);
    }
    // A profile derived from a calibration we already rejected is wrong by the
    // same amount as that calibration was.
    if (materialProfileIsStale(materialProfile, readProbeLockInvalidation(PROBE_STATE_PATH))) {
      throw new Error("The saved bed and stock measurement came from a Z calibration that was invalidated. Probe the bed and stock again.");
    }
    removeProbeLock(PROBE_STATE_PATH);
    clearProbeSetup("tool_touch_in_progress");
    applyMaterialProfile(setup, materialProfile);
    workspace.clear();
  }
  // Never probe against an absent or out-of-range plate value. This number sets
  // absolute Z zero one-for-one, so a silent default here is a silent depth error.
  const puckMm = normalizePuckThickness(payload.thicknessMm);
  if (puckMm === null) throw new Error(`Probe plate thickness must be supplied and between ${PROBE_PUCK_MIN_MM} and ${PROBE_PUCK_MAX_MM} mm`);
  // Carried along with the probe request, so it is stored and used but is NOT a
  // confirmation. Confirming here is how 12.1 mm became "operator-measured".
  setConfiguredPlateMm(puckMm, "Supplied with a Project probe command");
  // Re-probing redefines the surface, so no earlier proof can speak for it.
  clearSurfaceProof(`${kind} probe started`);
  setMoving(true, "probe"); incident = undefined;
  recordEvent("probe.started", { kind, maxSearchMm: payload.maxSearchMm, probeThickness: puckMm, materialReady: setup.materialReady });
  try {
    await motionGuard();
    const result = await controller.probeZ({
      thicknessMm: puckMm,
      maxSearchMm: payload.maxSearchMm,
    });
    const thickness = Number(result.thicknessMm);
    const contactZ = result.finalProbe.position.Z;
    const surfaceZ = contactZ - thickness;
    if (!result.frameReadback?.verified || Math.abs(result.actualWorkOffset.Z - surfaceZ) > 0.02) throw new Error("Probe effective offset was not verified");
    lastWorkOffset = result.actualWorkOffset;
    setup.probeThickness = thickness;
    if (kind === "bed") {
      workspace.clear();
      setup.bedSurfaceMPos = surfaceZ;
      setup.bedProbeReady = true;
      setup.stockProbeReady = false;
      setup.probeReady = false;
      setup.probeLockStatus = "unlocked";
      setup.stockSurfaceMPos = null;
      setup.stockThicknessMm = null;
      setup.safetyFloorMm = null;
      setup.maxCutDepthMm = null;
      setup.zOriginMPos = null;
    } else if (kind === "stock") {
      completeStockProbe(setup, surfaceZ);
    } else {
      completeToolTouch(setup, surfaceZ, materialProfile);
    }
    setup.updatedAt = new Date().toISOString(); lastControllerStatus = result.after;
    if (kind === "stock") persistMaterialProfile();
    if (kind !== "bed") persistLockedProbe(result.after);
    rebuildWorkspaceFromSetup();
    persistLockedXy(result.after);
    finishFrameRecovery();
    captureInterruptedPosition(result.after, `probe_${kind}`, { moved: true });
    recordEvent("probe.completed", { kind, firstProbe: result.firstProbe, finalProbe: result.finalProbe, actualWorkOffset: result.actualWorkOffset, after: result.after, searchedMm: result.searchedMm, probeThickness: setup.probeThickness, bedSurfaceMPos: setup.bedSurfaceMPos, stockSurfaceMPos: setup.stockSurfaceMPos, stockThicknessMm: setup.stockThicknessMm, safetyFloorMm: setup.safetyFloorMm, maxCutDepthMm: setup.maxCutDepthMm, zOriginMPos: setup.zOriginMPos, lockStatus: setup.probeLockStatus });
    return { ...result, setup: { ...setup } };
  } catch (error) { incident = error?.message || "PROBE_FAILED"; setup.probePhase = error?.code === "PROBE_SEARCH_EXHAUSTED" ? "returned_no_contact" : "error"; setup.updatedAt = new Date().toISOString(); recordEvent("probe.failed", { kind, code: error?.code, message: incident, travelledMm: setup.probeTravelledMm, limitMm: setup.probeSearchLimitMm }); throw error; } finally { setMoving(false); }
};
// Persist the operator's measured plate thickness without touching the machine.
// Changing it invalidates any surface proof, and a stored calibration that used a
// different plate is rejected on its next restore attempt.
const setPlateThickness = async (payload = {}) => {
  // The ONE path that may confirm a plate. It is a deliberate operator action in
  // the UI, so it is also the only place the value may be attributed to them.
  const thicknessMm = setConfiguredPlateMm(payload.thicknessMm, "Operator-measured and entered via Project", { confirmedByOperator: true, measuredBy: "operator" });
  recordEvent("plate.configured", { thicknessMm, confirmed: true, confirmedByOperator: true });
  return { ok: true, plate: plateSnapshot(), surfaceProof: surfaceProofSnapshot(), setup: { ...setup } };
};
// Independent surface-contact verification. See cnc-surface-proof.mjs for why a
// second, plate-free measurement is the only thing that can catch a wrong plate:
// every other number in the setup is derived from the same arithmetic, so they
// all agree with each other even when they are all wrong.
const verifySurfaceContact = async (payload = {}) => {
  assertSetupFrame();
  if (moving || ["running", "paused"].includes(job.state)) throw new Error("A CNC operation is already active");
  if (!setup.stockProbeReady || !Number.isFinite(Number(setup.stockSurfaceMPos)) || !Number.isFinite(Number(setup.zOriginMPos))) {
    throw new Error("Probe the stock before verifying surface contact; there is no stored reference to corroborate");
  }
  const method = payload.method === SURFACE_PROOF_ATTESTED ? SURFACE_PROOF_ATTESTED : SURFACE_PROOF_CONDUCTIVE;
  // Replace any previous proof up front, so a failed attempt can never leave an
  // older passing proof in place.
  clearSurfaceProof("new surface verification started");

  if (method === SURFACE_PROOF_ATTESTED) {
    if (payload.confirm !== true) throw new Error("Operator attestation requires explicit confirmation that the bit is touching the surface at work Z zero");
    surfaceProof = buildSurfaceProof({ method, plateThicknessMm: configuredPlateMm(), setup, operatorConfirmed: true });
    recordEvent("surface_proof.recorded", { method, verified: surfaceProof.verified, plateThicknessMm: surfaceProof.plateThicknessMm });
    return { ok: true, surfaceProof: { ...surfaceProof }, setup: { ...setup } };
  }

  // The bit must start ABOVE the stored surface so the touch travels downward onto
  // the stock. Probing up into the work is never acceptable.
  const before = await assertIdle(), startPosition = coordinates(before);
  const clearanceMm = startPosition.Z - Number(setup.stockSurfaceMPos);
  if (!(clearanceMm > 0.2)) {
    throw new Error(`The bit is only ${clearanceMm.toFixed(3)} mm above the stored stock surface. Raise Z a few mm over bare stock, then verify.`);
  }
  // Keep the search tight: this is a confirmation touch from a known height, not a
  // hunt. A large budget would let a wrong reference drive the cutter deep.
  const requested = Number(payload.maxSearchMm);
  const maxSearchMm = Math.max(5, Math.min(25, Number.isFinite(requested) && requested > 0 ? requested : Math.max(5, clearanceMm + 3)));

  setMoving(true, "surface-contact verification"); incident = undefined;
  recordEvent("surface_proof.started", { method, startZ: startPosition.Z, storedSurfaceMPos: setup.stockSurfaceMPos, maxSearchMm, plateThicknessMm: configuredPlateMm() });
  try {
    await motionGuard();
    // thicknessMm 0 and establishZero false: no plate under the bit and no G10.
    // The latched PRB Z IS the true surface, with no plate term anywhere in it.
    const result = await controller.probeZ({ thicknessMm: 0, maxSearchMm, establishZero: false });
    if (!result.frameReadback?.verified) throw new Error("Surface verification could not confirm the controller work frame");
    // Prove the measurement had no side effect on the work frame.
    if (!Number.isFinite(Number(result.actualWorkOffset?.Z)) || Math.abs(Number(result.actualWorkOffset.Z) - Number(setup.zOriginMPos)) > 0.02) {
      throw new Error(`Surface verification changed the Z work origin (${result.actualWorkOffset?.Z} vs ${setup.zOriginMPos}); refusing to trust it`);
    }
    const measuredSurfaceMPosZ = Number(result.finalProbe.position.Z);
    surfaceProof = buildSurfaceProof({
      method,
      measuredSurfaceMPosZ,
      plateThicknessMm: configuredPlateMm(),
      setup,
      evidence: { firstContactZ: Number(result.firstProbe?.position?.Z), secondContactZ: measuredSurfaceMPosZ, searchedMm: Number(result.searchedMm) },
    });
    lastControllerStatus = result.after;
    captureInterruptedPosition(result.after, "verify_surface", { moved: true });
    recordEvent("surface_proof.recorded", { method, verified: surfaceProof.verified, deltaMm: surfaceProof.deltaMm, measuredSurfaceMPosZ, expectedSurfaceMPosZ: surfaceProof.expectedSurfaceMPosZ, plateThicknessMm: surfaceProof.plateThicknessMm });
    if (!surfaceProof.verified) {
      // Do not throw: the operator needs the number. Start stays blocked because
      // the stored proof is not verified.
      incident = `Surface contact disagreed with the stored zero by ${Number(surfaceProof.deltaMm).toFixed(3)} mm`;
    }
    return { ok: true, surfaceProof: { ...surfaceProof }, setup: { ...setup }, status: result.after };
  } catch (error) {
    clearSurfaceProof(`verification failed: ${error?.message || "unknown"}`);
    incident = error?.message || "SURFACE_VERIFICATION_FAILED";
    recordEvent("surface_proof.failed", { method, message: incident, code: error?.code });
    throw error;
  } finally { setMoving(false); }
};
const lockProbeCalibration = async () => {
  assertSetupFrame();
  if (moving || ["running", "paused"].includes(job.state)) throw new Error("A CNC operation is already active");
  if (!setup.bedProbeReady || !setup.stockProbeReady || !setup.probeReady) throw new Error("Probe both the bed and stock before locking calibration");
  await motionGuard();
  const status = await assertIdle();
  setup.probeLocked = true;
  setup.probeLockStatus = "locked";
  setup.probeLockedAt = new Date().toISOString();
  setup.updatedAt = setup.probeLockedAt;
  const lock = persistLockedProbe(status);
  persistMaterialProfile();
  finishFrameRecovery();
  return { ok: true, setup: { ...setup }, lock: { lockedAt: lock.lockedAt, lastKnownMPos: lock.lastKnownMPos } };
};
const unlockProbeCalibration = async (payload) => {
  assertSetupFrame();
  if (payload.confirm !== true) throw new Error("Explicit unlock confirmation is required");
  if (moving || ["running", "paused"].includes(job.state)) throw new Error("A CNC operation is already active");
  await assertIdle();
  removeProbeLock(PROBE_STATE_PATH);
  clearProbeSetup();
  workspace.clear();
  return { ok: true, setup: { ...setup } };
};
const startProgram = async ({ jobId, gcode, stockWidthMm, stockHeightMm, stockReserveMm, manualRouter = false, operation = "", material = "", camProvider = "", camCertification = "", camSourceHash = "", camAuditHash = "", camStage = "", camTool = "", certifiedLibraryId = "", allowSacrificialCutThrough = false, sacrificialBackingConfirmed = false, profileDepthMm = null }) => {
  const actualSourceHash = createHash("sha256").update(String(gcode || "")).digest("hex");
  // Independent third enforcement of the conditional cut hold, after the browser
  // and the Vercel API. The hold no longer blocklists program hashes; it asserts
  // unless this daemon's own plate configuration, locked calibration and
  // surface-contact proof all agree on the Z reference. Evaluated against live
  // local state so a stale or absent cloud snapshot cannot release it.
  const auditHold = programHolds.programAuditHold(
    { camSourceHash: String(camSourceHash || actualSourceHash), material },
    { plate: plateSnapshot(), setup, surfaceProof: surfaceProofSnapshot() },
  );
  if (auditHold) throw new Error(auditHold);
  assertFrameValid(frameIncident);
  if (moving || ["running", "paused"].includes(job.state)) throw new Error("A CNC operation is already active");
  if (/C752 nickel silver/i.test(String(material || "")) && createHash("sha256").update(String(gcode || "")).digest("hex") !== String(camSourceHash || "")) throw new Error("Metal G-code no longer matches its certified Kiri:Moto source hash");
  const savedProgram = saveProgram(PROGRAM_STATE_PATH, { version: 1, jobId, gcode, capturedAt: new Date().toISOString(), state: "accepted", context: { stockWidthMm, stockHeightMm, stockReserveMm, manualRouter: manualRouter === true, operation: String(operation || ""), material: String(material || ""), camProvider: String(camProvider || ""), camCertification: String(camCertification || ""), camSourceHash: String(camSourceHash || ""), camAuditHash: String(camAuditHash || ""), camStage: String(camStage || ""), camTool: String(camTool || ""), certifiedLibraryId: String(certifiedLibraryId || ""), allowSacrificialCutThrough: allowSacrificialCutThrough === true, sacrificialBackingConfirmed: sacrificialBackingConfirmed === true, profileDepthMm: profileDepthMm !== null && profileDepthMm !== undefined && Number.isFinite(Number(profileDepthMm)) ? Number(profileDepthMm) : null } });
  activeRunCheckpoint = writeRunCheckpoint(RUN_STATE_PATH, { version: 1, jobId: savedProgram.jobId, programCapturedAt: savedProgram.capturedAt, state: "running", lastCompletedLine: 0, totalLines: savedProgram.analysis.executableLines, message: "Preflight checks", updatedAt: new Date().toISOString() });
  setMoving(true, "program run"); incident = undefined; Object.assign(job, { state: "running", jobId: String(jobId || ""), progress: 0, message: "Preflight checks", updatedAt: new Date().toISOString() });
  recordEvent("program.started", { jobId, executableLines: savedProgram.analysis.executableLines, manualRouter: manualRouter === true });
  try { const conditionedGcode = limitVerticalPlungeFeed(savedProgram.gcode, 60); assertPlungeFeedWithinLimit(conditionedGcode, 60); const result = await controller.runProgram(conditionedGcode, { programContext: savedProgram.context, expectedOrigin: { X: setup.xyOriginMPos?.X, Y: setup.xyOriginMPos?.Y, Z: setup.zOriginMPos }, onProgress: async (p) => Object.assign(job, { progress: p.progress, message: `Line ${p.line} of ${p.total}`, updatedAt: new Date().toISOString() }) }); lastControllerStatus = result.after; persistLockedXy(result.after); persistLockedProbe(result.after); Object.assign(job, { state: "done", progress: 100, message: "Carve complete", updatedAt: new Date().toISOString() }); persistRunProgress({ state: "done", lastCompletedLine: activeRunCheckpoint.totalLines, message: "Carve complete" }); recordEvent("program.completed", { jobId, totalLines: activeRunCheckpoint.totalLines }); return result; }
  catch (error) { incident = error?.message || "PROGRAM_FAILED"; Object.assign(job, { state: "error", message: incident, updatedAt: new Date().toISOString() }); persistRunProgress({ state: "interrupted", message: incident }); recordEvent("program.interrupted", { jobId, message: incident, lastCompletedLine: activeRunCheckpoint?.lastCompletedLine }); throw error; } finally { setMoving(false); }
};
const resumeSavedProgram = async (payload) => {
  assertFrameValid(frameIncident);
  if (payload.confirm !== true) throw new Error("Explicit resume confirmation is required");
  if (moving || ["running", "paused"].includes(job.state)) throw new Error("A CNC operation is already active");
  // Enforce exactly what /health advertises, through the same function, so the
  // button and the endpoint can never disagree about whether resume is allowed.
  // resumeSnapshot covers metal, audit holds, manual-router, program identity,
  // plate confirmation and plate/calibration agreement, and fails closed.
  const offer = resumeSnapshot();
  if (!offer) throw new Error("No interrupted carve checkpoint is available");
  if (!offer.resumable) throw new Error(offer.blockedReason);
  const saved = readProgram(PROGRAM_STATE_PATH);
  if (!saved) throw new Error("No locally saved carve is available");
  const completedLine = Number(payload.completedLine ?? (activeRunCheckpoint?.programCapturedAt === saved.capturedAt ? activeRunCheckpoint.lastCompletedLine : NaN));
  const traced = programPositionAtLine(saved.gcode, completedLine, { spindleMode: "manual" });
  const status = await assertIdle(), machine = coordinates(status);
  const work = { X: machine.X - Number(setup.xyOriginMPos?.X), Y: machine.Y - Number(setup.xyOriginMPos?.Y), Z: machine.Z - Number(setup.zOriginMPos) };
  const exactPosition = ["X", "Y", "Z"].every((axis) => Number.isFinite(work[axis]) && Math.abs(work[axis] - traced.position[axis]) <= 0.05);
  if (!exactPosition && activeRunCheckpoint?.state !== "interrupted") {
    const axis = ["X", "Y", "Z"].find((name) => !Number.isFinite(work[name]) || Math.abs(work[name] - traced.position[name]) > 0.05);
    throw new Error(`Resume position mismatch on ${axis}: controller ${work[axis]?.toFixed?.(3)}, program ${traced.position[axis].toFixed(3)}`);
  }
  let resumed;
  if (exactPosition) resumed = buildResumeProgram(saved.gcode, completedLine, { spindleMode: "manual" });
  else if (activeRunCheckpoint?.state === "interrupted" && payload.allowReposition === true) resumed = buildCheckpointReplayResume(saved.gcode, completedLine, { spindleMode: "manual" });
  else resumed = buildBufferedStopResume(saved.gcode, completedLine, work, { spindleMode: "manual" });
  if (payload.dryRun === true) return { ok: true, dryRun: true, controller: status, workPosition: work, expectedPosition: traced.position, resume: { ...resumed, gcode: undefined } };
  const result = await startProgram({ jobId: `${saved.jobId}-resume-${completedLine}`, gcode: resumed.gcode, ...saved.context });
  return { ...result, resume: resumed };
};
const restoreStoppedControllerState = async ({ discardBufferedProgram = false } = {}) => {
  assertFrameValid(frameIncident);
  await controller.resetConnection();
  if (discardBufferedProgram) {
    const beforeDiscard = parseStatus(await controller.status({ attempts: 5 }));
    if (new Set(["Run", "Hold", "Door"]).has(beforeDiscard.state.split(":")[0])) {
      // Never release a feed hold that belongs to an interrupted program: "~"
      // would execute already-buffered motion. Abort/reset the planner, reconnect,
      // and then accept only Idle or a no-motion Alarm unlock.
      await controller.emergencyStop("DISCARD_BUFFERED_PROGRAM_AFTER_PROJECT_STOP");
      await controller.resetConnection();
    }
  }
  const result = await controller.recoverStoppedController({ allowHeldResume: !discardBufferedProgram });
  lastControllerStatus = result.after;
  await restoreHardLimitsOnStartup(result.after);
  const workOffset = parseWorkOffset(await controller.query("$#"));
  lastWorkOffset = workOffset;
  restoreVerifiedCalibration(result.after, workOffset);
  incident = undefined;
  return { result, workOffset };
};
const stopProgram = async () => {
  await controller.stopProgramNow();
  const deadline = Date.now() + 5_000;
  while (moving && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  if (moving) throw new Error("PROGRAM_STOP_DID_NOT_SETTLE");
  persistRunProgress({ state: "interrupted", message: "Stopped by Project" });
  // Stop cancels host streaming. Only confirmed Idle enables manual positioning;
  // a held controller buffer is never released with cycle-start.
  // A latched cutting frame must not block this read-only recovery path.
  const recovery = await reconnectAndVerifyFrame();
  Object.assign(job, { state: "stopped", message: "Stopped", updatedAt: new Date().toISOString() });
  captureInterruptedPosition(lastControllerStatus, "project_stop", { initial: true });
  recordEvent("program.stopped", { jobId: job.jobId, lastCompletedLine: activeRunCheckpoint?.lastCompletedLine });
  return { ok: true, job: { ...job }, resume: resumeSnapshot(), recovery };
};
const recoverStoppedController = async (payload) => {
  assertSetupFrame();
  if (payload.confirm !== true) throw new Error("Explicit stopped-controller recovery confirmation is required");
  if (hazardousOperationActive()) throw new Error("A CNC operation is already active");
  if (frameIncident?.latched) {
    const before = await readStatus();
    if (before.state !== "Alarm" || before.Pn) throw new Error("Only an alarm with cleared inputs may be unlocked here; a held program must be discarded by an explicit controller power cycle");
    setMoving(true, "controller recovery");
    try { await controller.recoverStoppedController({ allowHeldResume: false }); }
    finally { setMoving(false); }
    return reconnectAndVerifyFrame();
  }
  const recovered = await restoreStoppedControllerState({ discardBufferedProgram: activeRunCheckpoint?.state === "interrupted" });
  captureInterruptedPosition(lastControllerStatus, "stopped_controller_recovery");
  return { ok: true, ...recovered, setup: { ...setup }, workspace: workspace.snapshot() };
};
const recoverRearYLimit = async (payload) => {
  assertSetupFrame();
  if (payload.confirm !== true) throw new Error("Explicit rear-Y limit recovery confirmation is required");
  if (hazardousOperationActive()) throw new Error("A CNC operation is already active");
  setMoving(true, "rear-limit recovery"); incident = undefined;
  try {
    const result = await controller.recoverRearYLimit({ retractMm: 5, feed: 100 });
    lastControllerStatus = result.after;
    const workOffset = parseWorkOffset(await controller.query("$#"));
    lastWorkOffset = workOffset;
    restoreVerifiedCalibration(result.before, workOffset);
    persistLockedXy(result.after);
    persistLockedProbe(result.after);
    captureInterruptedPosition(result.after, "rear_y_limit_recovery", { moved: true });
    recordEvent("controller.rear_y_limit_recovered", { deltaMm: result.deltaMm, status: result.after.raw });
    return { ok: true, result, setup: { ...setup }, workspace: workspace.snapshot() };
  } catch (error) {
    incident = error?.message || "REAR_Y_LIMIT_RECOVERY_FAILED";
    throw error;
  } finally { setMoving(false); }
};
const bodyJson = async (req, maxBytes = MAX_BODY_BYTES) => { let body = "", size = 0; for await (const chunk of req) { size += chunk.length; if (size > maxBytes) throw new Error("Request too large"); body += chunk; } return body ? JSON.parse(body) : {}; };

const localUi = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Project CNC · Local</title><style>body{font:16px system-ui;background:#111827;color:#eef2ff;max-width:820px;margin:30px auto;padding:16px}button{font:inherit;padding:12px 16px;margin:5px;border-radius:8px;border:1px solid #64748b;background:#1e293b;color:white}button.danger{background:#991b1b}pre{white-space:pre-wrap;background:#0b1220;padding:14px;border-radius:8px}</style><h1>Project CNC · Local recovery</h1><p>This console uses Project's local daemon and safety guards without the cloud queue.</p><div><button onclick="recover()">Enable positioning</button><button onclick="start()">Start saved carve</button><button onclick="cmd('/job/pause')">Pause</button><button onclick="cmd('/job/resume')">Resume</button><button class="danger" onclick="cmd('/job/stop')">Stop</button><button onclick="refresh()">Refresh</button></div><pre id="s">Loading…</pre><script>async function req(path,body){let r=await fetch(path,{method:body?'POST':'GET',headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined}),j=await r.json();if(!r.ok)throw Error(j.error||r.status);return j}async function refresh(){try{let h=await req('/health'),p=await req('/job/last');s.textContent=JSON.stringify({controller:h.lastControllerStatus,connected:h.connected,moving:h.moving,incident:h.incident,workspace:h.workspace,setup:h.setup,job:h.job,savedProgram:p.program},null,2)}catch(e){s.textContent='ERROR: '+e.message}}async function cmd(p,b={}){try{await req(p,b);await refresh()}catch(e){alert(e.message);await refresh()}}async function recover(){if(confirm('Enable positioning from a safe Hold:0/Door:0 state? The external router need not be installed and no axis moves during this step.'))await cmd('/controller/recover-stopped',{confirm:true})}async function start(){if(confirm('Start the locally saved carve from line 1 through Project guards?'))await cmd('/job/start-saved',{})}refresh();setInterval(refresh,2000)</script>`;
const requestHandler = async (req, res) => {
  try {
    if (req.method === "GET" && (req.url === "/" || req.url === "/ui")) { res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); return res.end(localUi); }
    if (req.method === "OPTIONS" && req.url === "/job/import") { const origin=String(req.headers.origin||""); if(origin!=="https://project-jvyw3.vercel.app") return json(res,403,{ok:false,error:"Origin denied"}); res.writeHead(204,{"access-control-allow-origin":origin,"access-control-allow-methods":"POST,OPTIONS","access-control-allow-headers":"content-type","access-control-allow-private-network":"true"}); return res.end(); }
    if (req.method === "POST" && req.url === "/job/import") { const origin=String(req.headers.origin||""); if(origin!=="https://project-jvyw3.vercel.app") return json(res,403,{ok:false,error:"Origin denied"}); const saved=saveProgram(PROGRAM_STATE_PATH,{version:1,...await bodyJson(req, MAX_PROGRAM_BODY_BYTES),capturedAt:new Date().toISOString(),state:"imported"}); res.writeHead(200,{"content-type":"application/json","cache-control":"no-store","access-control-allow-origin":origin}); return res.end(JSON.stringify({ok:true,program:{...saved,gcode:undefined}})); }
    if (req.method === "GET" && req.url === "/health") return json(res, 200, await health());
    if (req.method === "GET" && req.url === "/job/last") { const saved = readProgram(PROGRAM_STATE_PATH); return json(res, 200, { ok: true, program: saved ? { ...saved, gcode: undefined } : null }); }
    if (req.method === "POST" && req.url === "/job/start-saved") { const saved=readProgram(PROGRAM_STATE_PATH); if(!saved) throw new Error("No locally saved carve is available"); return json(res,200,await startProgram({jobId:saved.jobId,gcode:saved.gcode,...saved.context})); }
    if (req.method === "POST" && req.url === "/job/resume-saved") return json(res, 200, await resumeSavedProgram(await bodyJson(req)));
    if (req.method === "POST" && req.url === "/observe") return json(res, 200, await observe());
    if (req.method === "POST" && req.url === "/query") { const { command } = await bodyJson(req); return json(res, 200, { command, lines: await controller.query(command) }); }
    if (req.method === "POST" && /^\/jog\/[xyz]$/.test(req.url)) return json(res, 200, await jog(req.url.at(-1).toUpperCase(), await bodyJson(req)));
    if (req.method === "POST" && req.url === "/workspace/set") { assertFrameValid(frameIncident); removeXyLock(XY_STATE_PATH); setup.xyReady = false; setup.xyLockStatus = "unlocked"; setup.xyLockedAt = null; setup.xyOriginMPos = null; setup.updatedAt = new Date().toISOString(); return json(res, 200, workspace.setBounds(await bodyJson(req))); }
    if (req.method === "POST" && req.url === "/zero/xy") return json(res, 200, await setXyZero(await bodyJson(req)));
    if (req.method === "POST" && req.url === "/zero/xy/restore-after-power-cycle") return json(res, 200, await restoreXyAfterPowerCycle(await bodyJson(req)));
    if (req.method === "POST" && req.url === "/probe/restore-after-xy-zero") return json(res, 200, await restoreProbeAfterXyOnlyReset(await bodyJson(req)));
    if (req.method === "POST" && req.url === "/zero/z") return json(res, 200, await setStockZZero(await bodyJson(req)));
    if (req.method === "POST" && req.url === "/probe/bed") return json(res, 200, await probeSurface("bed", await bodyJson(req)));
    if (req.method === "POST" && req.url === "/probe/stock") return json(res, 200, await probeSurface("stock", await bodyJson(req)));
    if (req.method === "POST" && req.url === "/probe/tool") return json(res, 200, await probeSurface("tool", await bodyJson(req)));
    if (req.method === "POST" && req.url === "/probe/verify-surface") return json(res, 200, await verifySurfaceContact(await bodyJson(req)));
    if (req.method === "POST" && req.url === "/probe/plate") return json(res, 200, await setPlateThickness(await bodyJson(req)));
    if (req.method === "POST" && req.url === "/probe/lock") return json(res, 200, await lockProbeCalibration());
    if (req.method === "POST" && req.url === "/probe/unlock") return json(res, 200, await unlockProbeCalibration(await bodyJson(req)));
    if (req.method === "POST" && req.url === "/probe/recover") return json(res, 200, await controller.recoverProbeContact(await bodyJson(req)));
    if (req.method === "POST" && req.url === "/job/start") return json(res, 200, await startProgram(await bodyJson(req, MAX_PROGRAM_BODY_BYTES)));
    if (req.method === "POST" && req.url === "/job/pause") { controller.pauseProgramNow(); Object.assign(job, { state: "paused", message: "Paused", updatedAt: new Date().toISOString() }); return json(res, 200, { ok: true, job: { ...job } }); }
    if (req.method === "POST" && req.url === "/job/resume") { assertFrameValid(frameIncident); if (!controller.programRunning || job.state !== "paused") throw new Error("No live paused program is available to resume"); controller.resumeProgramNow(); Object.assign(job, { state: "running", message: "Running", updatedAt: new Date().toISOString() }); return json(res, 200, { ok: true, job: { ...job } }); }
    if (req.method === "POST" && req.url === "/job/stop") return json(res, 200, await stopProgram());
    if (req.method === "POST" && req.url === "/spindle/test") return json(res, 200, await spindleTest());
    if (req.method === "POST" && req.url === "/spindle/stop") { const lines = await controller.spindleOff(); lastControllerStatus = await readStatus(); return json(res, 200, { lines, status: lastControllerStatus }); }
    if (req.method === "POST" && req.url === "/controller/acknowledge-power-on") {
      assertFrameValid(frameIncident);
      const payload = await bodyJson(req);
      if (payload.powerCycleConfirmed !== true) throw new Error("Power-cycle confirmation is required");
      if (hazardousOperationActive()) throw new Error("A CNC operation is already active");
      const result = await controller.acknowledgePowerOnDoor();
      lastControllerStatus = result.after;
      await restoreHardLimitsOnStartup(result.after);
      incident = undefined;
      return json(res, 200, result);
    }
    if (req.method === "POST" && req.url === "/controller/recover-stopped") return json(res,200,await recoverStoppedController(await bodyJson(req)));
    if (req.method === "POST" && req.url === "/controller/reconnect-verify") return json(res,200,await reconnectAndVerifyFrame());
    if (req.method === "POST" && req.url === "/controller/recover-rear-y-limit") return json(res,200,await recoverRearYLimit(await bodyJson(req)));
    return json(res, 404, { ok: false, error: "Not found" });
  } catch (error) { return json(res, 500, { ok: false, error: error?.message || "Error" }); }
};
const server = http.createServer(requestHandler);
const uiServer = http.createServer(requestHandler);

const restoreHardLimitsOnStartup = async (knownStatus) => {
  try {
    const state = knownStatus?.state || (await readStatus()).state;
    if (new Set(["Door", "Hold"]).has(String(state).split(":")[0])) return { skipped: true, state };
    const lines = await controller.query("$$");
    if (lines.some((line) => /^\$21=0(?:\s|$)/.test(line))) await controller.setBooleanSetting(21, true);
    // $20, $130-$132 and $100-$102 were read but never validated. The steps/mm
    // settings are the conversion between commanded steps and physical travel, so
    // a change there rescales every stored measurement at once -- the probed
    // surface, the protected floor, the maximum cut depth, the clearance height --
    // while leaving them all consistent with each other. Pin them and refuse on
    // drift rather than cutting to a silently different depth.
    const settingsVerdict = verifyControllerSettings(parseGrblSettings(lines));
    return { skipped: false, state, settings: settingsVerdict };
  } catch (error) {
    incident = `STARTUP_SAFETY_CHECK_FAILED:${error?.message || "unknown"}`;
  }
};

// The travel this software actually intends to command, so $130-$132 can be
// checked against it. Only what is genuinely known is returned: the validator
// skips any axis it is not given, which is correct -- inventing an envelope would
// produce either a false alarm or a false reassurance.
const machineEnvelopeMm = () => {
  const envelope = {};
  let saved; try { saved = readProgram(PROGRAM_STATE_PATH); } catch { /* no accepted program yet */ }
  const width = Number(saved?.context?.stockWidthMm), height = Number(saved?.context?.stockHeightMm);
  if (width > 0) envelope.X = width + POSITIONING_OUTSIDE_STOCK_MM;
  if (height > 0) envelope.Y = height + POSITIONING_OUTSIDE_STOCK_MM;
  return envelope;
};

const verifyControllerSettings = (settings) => {
  const baseline = readSettingsBaseline(CONTROLLER_SETTINGS_PATH);
  const verdict = validateControllerSettings(settings, { expectedEnvelope: machineEnvelopeMm(), baseline });
  if (verdict.frameInvalid) {
    // ONLY a drifted steps/mm reaches here. The scale between commanded and
    // physical distance changed, so every saved measurement now means a different
    // physical position and the frame the calibration lives in really is invalid.
    latchFrameIncident(`CONTROLLER_SETTINGS_REJECTED:${verdict.frameProblems[0]}`, false);
    recordEvent("controller.settings_rejected", { problems: verdict.frameProblems, stepsPerMm: verdict.stepsPerMm, softLimits: verdict.softLimits });
    return verdict;
  }
  if (!verdict.ok) {
    // Unreadable, implausible, soft limits on, or declared travel smaller than
    // intended. Surfaced, never silent -- but NOT latched. An unreadable `$$` is a
    // communications problem, not evidence that the machine moved, and latching a
    // hard interlock on a dropped read would brick the setup the way the stuck
    // motion flag and the invisible Lock button did.
    incident = `CONTROLLER_SETTINGS_UNVERIFIED:${verdict.problems[0]}`;
    recordEvent("controller.settings_unverified", { problems: verdict.problems, stepsPerMm: verdict.stepsPerMm, softLimits: verdict.softLimits });
    return verdict;
  }
  // First clean sight of this controller becomes the baseline every later start
  // is judged against.
  if (!baseline) {
    try {
      writeSettingsBaseline(CONTROLLER_SETTINGS_PATH, { stepsPerMm: verdict.stepsPerMm, capturedAt: verdict.validatedAt, source: "First verified controller connection" });
      recordEvent("controller.settings_baselined", { stepsPerMm: verdict.stepsPerMm });
    } catch (error) { recordEvent("controller.settings_baseline_failed", { message: error?.message || "unknown" }); }
  }
  return verdict;
};

const keepalive = setInterval(async () => { if (moving || keepaliveBusy || !controller.connected) return; keepaliveBusy = true; try { await readStatus(); } catch (error) { incident = `KEEPALIVE_FAILED:${error?.message || "unknown"}`; logConnectionEvent(incident, `[cnc] ${incident}`); } finally { keepaliveBusy = false; } }, 1500);
keepalive.unref();
if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH);
server.listen(SOCKET_PATH, () => { chmodSync(SOCKET_PATH, 0o600); process.stdout.write(JSON.stringify({ event: "CNC_DAEMON_READY", socket: SOCKET_PATH, host: HOST, port: PORT }) + "\n"); });
uiServer.listen(LOCAL_UI_PORT, "127.0.0.1");
if (frameIncident?.latched) autoVerifyStoppedFrame();
else void recoverIdleConnection();
const shutdown = async () => { clearInterval(keepalive); workspace.clear(); clearSetup(); if (moving) await controller.emergencyStop("DAEMON_SHUTDOWN_DURING_MOTION").catch(() => {}); await controller.close(); uiServer.close(); server.close(() => { try { if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH); } catch {} process.exit(0); }); };
process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);
