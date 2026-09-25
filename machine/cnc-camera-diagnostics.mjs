export const createDiagnostics = () => ({
  black: false,
  validated: false,
  lastAnalyzedFrame: null,
  blackFrames: [],
  lastBlackAt: null,
  lastSceneChangeAt: null,
  lastSceneScore: null,
});

export const parseDiagnosticLine = (diagnostics, line, now = Date.now()) => {
  const text = String(line || "");
  const blackFrame = text.match(/\bframe:(\d+)\s+pblack:([0-9.]+)/);
  if (blackFrame) {
    const frame = Number(blackFrame[1]);
    diagnostics.blackFrames.push(frame);
    if (diagnostics.blackFrames.length > 256) diagnostics.blackFrames.splice(0, diagnostics.blackFrames.length - 256);
    diagnostics.lastBlackAt = now;
  }
  const analyzedFrame = text.match(/\bParsed_showinfo_[^\]]*\].*\bn:\s*(\d+)\b/);
  if (analyzedFrame) diagnostics.lastAnalyzedFrame = Number(analyzedFrame[1]);
  const scene = text.match(/lavfi\.scd\.score:\s*([0-9.]+)/);
  if (scene) {
    diagnostics.lastSceneChangeAt = now;
    diagnostics.lastSceneScore = Number(scene[1]);
  }
  return diagnostics;
};

export const consumeDiagnosticChunk = (diagnostics, remainder, chunk, now = Date.now()) => {
  const combined = `${remainder || ""}${String(chunk || "")}`;
  const lines = combined.split(/\r?\n/);
  const nextRemainder = lines.pop() || "";
  for (const line of lines) parseDiagnosticLine(diagnostics, line, now);
  return nextRemainder;
};

export const selectAnalyzedCandidate = (candidates, diagnostics) => {
  if (!Number.isFinite(diagnostics?.lastAnalyzedFrame)) return null;
  return candidates.find((entry) => entry.sequence === diagnostics.lastAnalyzedFrame) || null;
};

export const cameraFresh = ({ state, monitoring, lastFrameAt, frameAgeMs, diagnostics }, now = Date.now(), maxAgeMs = 3000) => {
  const age = typeof frameAgeMs === "number" && Number.isFinite(frameAgeMs) ? frameAgeMs : now - Number(lastFrameAt);
  return (
  state === "ready" &&
  monitoring === true &&
  Number.isFinite(Number(lastFrameAt)) && Number(lastFrameAt) > 0 &&
  age >= 0 && age <= maxAgeMs &&
  diagnostics?.validated === true &&
  diagnostics?.black !== true
  );
};

export const cameraBridgeFresh = (status, now = Date.now(), maxAgeMs = 3000) => {
  const age = typeof status?.frameAgeMs === "number" && Number.isFinite(status.frameAgeMs) ? status.frameAgeMs : now - Number(status?.lastFrameAt || 0);
  return status?.state === "ready" && status?.fresh === true && status?.monitoring === true && age >= 0 && age <= maxAgeMs;
};
