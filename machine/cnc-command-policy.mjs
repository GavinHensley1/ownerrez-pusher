const RUN_CONTROLS = new Set(["pause", "resume", "stop"]);

export function commandRejectionReason(command, {
  nowMs = Date.now(),
  agentStartedAtMs,
  maxAgeMs = 30_000,
  clockSkewMs = 5_000,
  activeProgram = false,
} = {}) {
  const action = String(command?.action || "");
  const createdAtMs = Date.parse(String(command?.createdAt || ""));
  if (!Number.isFinite(createdAtMs)) return "Command rejected before motion: createdAt is missing or invalid";
  if (createdAtMs > nowMs + clockSkewMs) return "Command rejected before motion: createdAt is in the future";
  if (Number.isFinite(agentStartedAtMs) && createdAtMs < agentStartedAtMs - clockSkewMs) {
    return "Command expired before motion: it was queued before this bridge process started";
  }
  if (nowMs - createdAtMs > maxAgeMs) return `Command expired before motion: it is older than ${Math.round(maxAgeMs / 1000)} seconds`;
  if (activeProgram && !RUN_CONTROLS.has(action)) return "Command rejected before motion: a carve is active; only Pause, Resume, or Stop is allowed";
  return "";
}

