import { analyzeProgram } from "./cnc-program.mjs";

const NUMBER = "[-+]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)";
// Same boundary rule as cnc-program.mjs: \b does not match between a digit and a
// letter, so `\bZ` misses the Z in "G0Z5", and a TRAILING `\b` after the number
// misses the trailing-dot form "Z5.". An address letter in G-code is never
// preceded by another letter, and the number ends where it ends.
const ADDRESS_START = "(?<![A-Z])";
const axisWord = (axis) => new RegExp(`${ADDRESS_START}${axis}(${NUMBER})`);
const RAPID = /^G0*0(?![\d.])/;
const FEED_MOVE = /^G0*[123](?![\d.])/;

// A rapid whose Z is at or above the work surface: a genuine safe retract.
const safeRetractZ = (line) => {
  if (!RAPID.test(line)) return null;
  const z = line.match(axisWord("Z"));
  return z && Number(z[1]) >= 0 ? Number(z[1]) : null;
};

// A resume that BEGINS on a combined rapid moves X, Y and Z simultaneously. If
// the cutter is still down in the stock at the stop point, that drags it
// sideways through the material while it lifts. Emit a pure vertical lift first;
// the original combined move then runs as the horizontal reposition at a safe
// height that it was always meant to be.
const liftBeforeCombinedRapid = (line) => {
  const z = safeRetractZ(line);
  if (z === null) return [];
  if (!axisWord("X").test(line) && !axisWord("Y").test(line)) return [];
  return ["; Project: vertical lift first, so the combined rapid below cannot drag X/Y through stock", `G0 Z${z}`];
};

// Cutting moves that a forward-scanning resume would skip over. Dropping these
// silently leaves uncut material and then reports the carve complete.
//
// "Cutting" must be decided from TRACED Z, not from the line text. Z is modal,
// so a move's depth is usually not written on its own line, and this project's
// generator deliberately emits positive-Z feed connectors that cross the work
// without touching it ("PROTECTED-SURFACE CONNECTOR"). Counting those as
// abandoned cutting moves would refuse perfectly good resumes. A move removes
// material only if either of its endpoints sits below the work surface.
const skippedCuttingMoves = (lines, from, to) => {
  let position = { X: 0, Y: 0, Z: 0 }, count = 0;
  for (let index = 0; index < to; index += 1) {
    const line = lines[index];
    const next = positionAfter(position, line);
    if (index >= from && FEED_MOVE.test(line) && Math.min(position.Z, next.Z) < 0) count += 1;
    position = next;
  }
  return count;
};

export function programPositionAtLine(source, completedLine, { spindleMode = "controller" } = {}) {
  const analysis = analyzeProgram(source, { spindleMode });
  const line = Number(completedLine);
  if (!Number.isInteger(line) || line < 0 || line > analysis.lines.length) throw new Error(`Completed line must be 0-${analysis.lines.length}`);
  const position = { X: 0, Y: 0, Z: 0 };
  for (let index = 0; index < line; index += 1) {
    const command = analysis.lines[index];
    for (const axis of ["X", "Y", "Z"]) {
      const match = command.match(axisWord(axis));
      if (match) position[axis] = Number(match[1]);
    }
  }
  return { analysis, position, completedLine: line };
}

export function buildResumeProgram(source, completedLine, { spindleMode = "controller" } = {}) {
  if (spindleMode !== "manual") throw new Error("Automatic resume is currently limited to manual-router stages");
  const { analysis } = programPositionAtLine(source, completedLine, { spindleMode });
  const firstUnfinishedIndex = Number(completedLine);
  let retractIndex = -1;
  for (let index = firstUnfinishedIndex; index < analysis.lines.length; index += 1) {
    if (safeRetractZ(analysis.lines[index]) !== null) { retractIndex = index; break; }
  }
  if (retractIndex < 0) throw new Error("No safe retract remains after the completed line");
  // THIS SCAN RUNS FORWARD, so everything between the stop point and that retract
  // is ABANDONED. Previously those lines were dropped silently and the job then
  // ran to "Carve complete" at 100% with a hole in the toolpath. Skipping pure
  // rapids is harmless; skipping cutting moves means uncut material, and a resume
  // is not allowed to quietly decide to leave some of the part uncarved.
  const abandoned = skippedCuttingMoves(analysis.lines, firstUnfinishedIndex, retractIndex);
  if (abandoned > 0) {
    throw new Error(`Resuming here would abandon ${abandoned} cutting move${abandoned === 1 ? "" : "s"} between line ${firstUnfinishedIndex + 1} and the next safe retract at line ${retractIndex + 1}, leaving that material uncut while reporting the carve complete. Restart the stage from line 1 instead.`);
  }
  const remaining = analysis.lines.slice(retractIndex);
  const gcode = [
    "; Project guarded resume of a manual-router stage",
    `; Original executable lines completed: ${completedLine} of ${analysis.lines.length}`,
    `; Resume begins at original executable line ${retractIndex + 1}`,
    "G21",
    "G90",
    "G17",
    ...liftBeforeCombinedRapid(remaining[0]),
    ...remaining,
  ].join("\n");
  return {
    gcode,
    completedLine: Number(completedLine),
    resumeAtLine: retractIndex + 1,
    skippedUnfinishedLines: retractIndex - firstUnfinishedIndex,
    originalExecutableLines: analysis.lines.length,
    remainingExecutableLines: analyzeProgram(gcode, { spindleMode }).executableLines,
  };
}

export function buildCheckpointReplayResume(source, completedLine, { spindleMode = "controller", maxReplayLines = 5_000 } = {}) {
  if (spindleMode !== "manual") throw new Error("Automatic resume is currently limited to manual-router stages");
  const { analysis } = programPositionAtLine(source, completedLine, { spindleMode });
  const completed = Number(completedLine);
  let rewindIndex = -1;
  for (let index = Math.min(completed - 1, analysis.lines.length - 1); index >= 0; index -= 1) {
    if (safeRetractZ(analysis.lines[index]) !== null) { rewindIndex = index; break; }
  }
  if (rewindIndex < 0) throw new Error("No safe retract boundary exists before the saved checkpoint");
  const replayedLines = completed - rewindIndex;
  if (replayedLines > maxReplayLines) throw new Error(`Saved checkpoint requires replaying ${replayedLines} lines; guarded limit is ${maxReplayLines}`);
  const remaining = analysis.lines.slice(rewindIndex);
  const gcode = [
    "; Project guarded checkpoint replay after post-stop positioning",
    `; Original executable lines completed: ${completed} of ${analysis.lines.length}`,
    `; Safe replay begins at original executable line ${rewindIndex + 1}`,
    "G21",
    "G90",
    "G17",
    ...liftBeforeCombinedRapid(remaining[0]),
    ...remaining,
  ].join("\n");
  return {
    gcode,
    completedLine: completed,
    resumeAtLine: rewindIndex + 1,
    replayedLines,
    positionMatchMode: "checkpoint-reposition",
    originalExecutableLines: analysis.lines.length,
    remainingExecutableLines: analyzeProgram(gcode, { spindleMode }).executableLines,
  };
}

const positionAfter = (position, command) => {
  const next = { ...position };
  for (const axis of ["X", "Y", "Z"]) {
    const match = command.match(axisWord(axis));
    if (match) next[axis] = Number(match[1]);
  }
  return next;
};

const distanceToSegment = (point, start, end) => {
  const delta = { X: end.X - start.X, Y: end.Y - start.Y, Z: end.Z - start.Z };
  const lengthSquared = delta.X ** 2 + delta.Y ** 2 + delta.Z ** 2;
  if (lengthSquared === 0) return { distance: Infinity, progress: 0 };
  const relative = { X: point.X - start.X, Y: point.Y - start.Y, Z: point.Z - start.Z };
  const progress = (relative.X * delta.X + relative.Y * delta.Y + relative.Z * delta.Z) / lengthSquared;
  const clamped = Math.max(0, Math.min(1, progress));
  const nearest = {
    X: start.X + clamped * delta.X,
    Y: start.Y + clamped * delta.Y,
    Z: start.Z + clamped * delta.Z,
  };
  return { distance: Math.hypot(point.X - nearest.X, point.Y - nearest.Y, point.Z - nearest.Z), progress };
};

const distanceToXySegment = (point, start, end) => {
  const delta = { X: end.X - start.X, Y: end.Y - start.Y };
  const lengthSquared = delta.X ** 2 + delta.Y ** 2;
  if (lengthSquared === 0) return { distance: Infinity, progress: 0 };
  const relative = { X: point.X - start.X, Y: point.Y - start.Y };
  const progress = (relative.X * delta.X + relative.Y * delta.Y) / lengthSquared;
  const clamped = Math.max(0, Math.min(1, progress));
  const nearest = {
    X: start.X + clamped * delta.X,
    Y: start.Y + clamped * delta.Y,
  };
  return { distance: Math.hypot(point.X - nearest.X, point.Y - nearest.Y), progress };
};

export function buildBufferedStopResume(source, acknowledgedLine, currentPosition, { spindleMode = "controller", toleranceMm = 0.05, searchWindow = 128, forwardSearchWindow = 16 } = {}) {
  if (spindleMode !== "manual") throw new Error("Automatic resume is currently limited to manual-router stages");
  const analysis = analyzeProgram(source, { spindleMode });
  const acknowledged = Number(acknowledgedLine);
  if (!Number.isInteger(acknowledged) || acknowledged < 1 || acknowledged > analysis.lines.length) throw new Error(`Acknowledged line must be 1-${analysis.lines.length}`);
  for (const axis of ["X", "Y", "Z"]) if (!Number.isFinite(currentPosition?.[axis])) throw new Error(`Current ${axis} position is unavailable`);

  const segments = [];
  let position = { X: 0, Y: 0, Z: 0 };
  const firstCandidate = Math.max(0, acknowledged - searchWindow);
  // GRBL may physically finish a few commands that were already buffered after
  // the last progress checkpoint reached durable storage. Search a small,
  // explicit window beyond the acknowledged line as well as the historical
  // window behind it. The physical controller position still has to land on an
  // exact program segment within tolerance before any resume program is built.
  const lastCandidate = Math.min(analysis.lines.length, acknowledged + forwardSearchWindow);
  for (let index = 0; index < lastCandidate; index += 1) {
    const command = analysis.lines[index];
    const next = positionAfter(position, command);
    if (index >= firstCandidate && /^G0*[01](?![\d.])/.test(command)) {
      const match = distanceToSegment(currentPosition, position, next);
      if (match.progress >= -0.001 && match.progress <= 1.001 && match.distance <= toleranceMm) {
        segments.push({ index, command, start: { ...position }, end: { ...next }, ...match });
      }
    }
    position = next;
  }
  let matchMode = "xyz";
  if (!segments.length && currentPosition.Z >= analysis.bounds.Z.max - toleranceMm) {
    position = { X: 0, Y: 0, Z: 0 };
    for (let index = 0; index < lastCandidate; index += 1) {
      const command = analysis.lines[index];
      const next = positionAfter(position, command);
      if (index >= firstCandidate && FEED_MOVE.test(command)) {
        const match = distanceToXySegment(currentPosition, position, next);
        if (match.progress >= -0.001 && match.progress <= 1.001 && match.distance <= toleranceMm) {
          segments.push({ index, command, start: { ...position }, end: { ...next }, ...match });
        }
      }
      position = next;
    }
    if (segments.length) matchMode = "xy-retracted";
  }
  if (!segments.length) throw new Error(`Stopped position does not match the guarded checkpoint window (${Math.min(searchWindow, acknowledged)} lines behind, ${Math.min(forwardSearchWindow, analysis.lines.length - acknowledged)} ahead)`);
  segments.sort((a, b) => a.distance - b.distance || Math.abs(a.index - acknowledged) - Math.abs(b.index - acknowledged) || b.index - a.index);
  const interrupted = segments[0];

  let rewindIndex = -1;
  for (let index = interrupted.index; index >= 0; index -= 1) {
    if (safeRetractZ(analysis.lines[index]) !== null) { rewindIndex = index; break; }
  }
  if (rewindIndex < 0) throw new Error("No safe retract boundary exists before the interrupted motion");
  const remaining = analysis.lines.slice(rewindIndex);
  const gcode = [
    "; Project guarded buffered-stop resume of a manual-router stage",
    `; Last acknowledged original line: ${acknowledged} of ${analysis.lines.length}`,
    `; Physical stop occurred during original line ${interrupted.index + 1}`,
    `; Safe replay begins at original executable line ${rewindIndex + 1}`,
    "G21",
    "G90",
    "G17",
    ...liftBeforeCombinedRapid(remaining[0]),
    ...remaining,
  ].join("\n");
  return {
    gcode,
    acknowledgedLine: acknowledged,
    acknowledgedDeltaLines: interrupted.index + 1 - acknowledged,
    interruptedLine: interrupted.index + 1,
    interruptedCommand: interrupted.command,
    segmentProgress: interrupted.progress,
    positionErrorMm: interrupted.distance,
    positionMatchMode: matchMode,
    resumeAtLine: rewindIndex + 1,
    replayedLines: interrupted.index - rewindIndex,
    originalExecutableLines: analysis.lines.length,
    remainingExecutableLines: analyzeProgram(gcode, { spindleMode }).executableLines,
  };
}
