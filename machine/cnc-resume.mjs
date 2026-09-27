import { analyzeProgram } from "./cnc-program.mjs";

const NUMBER = "[-+]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)";

export function programPositionAtLine(source, completedLine, { spindleMode = "controller" } = {}) {
  const analysis = analyzeProgram(source, { spindleMode });
  const line = Number(completedLine);
  if (!Number.isInteger(line) || line < 0 || line > analysis.lines.length) throw new Error(`Completed line must be 0-${analysis.lines.length}`);
  const position = { X: 0, Y: 0, Z: 0 };
  for (let index = 0; index < line; index += 1) {
    const command = analysis.lines[index];
    for (const axis of ["X", "Y", "Z"]) {
      const match = command.match(new RegExp(`\\b${axis}(${NUMBER})\\b`));
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
    const line = analysis.lines[index];
    if (!/^G0*0\b/.test(line)) continue;
    const z = line.match(new RegExp(`\\bZ(${NUMBER})\\b`));
    if (z && Number(z[1]) >= 0) { retractIndex = index; break; }
  }
  if (retractIndex < 0) throw new Error("No safe retract remains after the completed line");
  const remaining = analysis.lines.slice(retractIndex);
  const gcode = [
    "; Project guarded resume of a manual-router stage",
    `; Original executable lines completed: ${completedLine} of ${analysis.lines.length}`,
    `; Resume begins at original executable line ${retractIndex + 1}`,
    "G21",
    "G90",
    "G17",
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

const positionAfter = (position, command) => {
  const next = { ...position };
  for (const axis of ["X", "Y", "Z"]) {
    const match = command.match(new RegExp(`\\b${axis}(${NUMBER})\\b`));
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

export function buildBufferedStopResume(source, acknowledgedLine, currentPosition, { spindleMode = "controller", toleranceMm = 0.05, searchWindow = 128 } = {}) {
  if (spindleMode !== "manual") throw new Error("Automatic resume is currently limited to manual-router stages");
  const analysis = analyzeProgram(source, { spindleMode });
  const acknowledged = Number(acknowledgedLine);
  if (!Number.isInteger(acknowledged) || acknowledged < 1 || acknowledged > analysis.lines.length) throw new Error(`Acknowledged line must be 1-${analysis.lines.length}`);
  for (const axis of ["X", "Y", "Z"]) if (!Number.isFinite(currentPosition?.[axis])) throw new Error(`Current ${axis} position is unavailable`);

  const segments = [];
  let position = { X: 0, Y: 0, Z: 0 };
  const firstCandidate = Math.max(0, acknowledged - searchWindow);
  for (let index = 0; index < acknowledged; index += 1) {
    const command = analysis.lines[index];
    const next = positionAfter(position, command);
    if (index >= firstCandidate && /^G0*[01]\b/.test(command)) {
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
    for (let index = 0; index < acknowledged; index += 1) {
      const command = analysis.lines[index];
      const next = positionAfter(position, command);
      if (index >= firstCandidate && /^G0*1\b/.test(command)) {
        const match = distanceToXySegment(currentPosition, position, next);
        if (match.progress >= -0.001 && match.progress <= 1.001 && match.distance <= toleranceMm) {
          segments.push({ index, command, start: { ...position }, end: { ...next }, ...match });
        }
      }
      position = next;
    }
    if (segments.length) matchMode = "xy-retracted";
  }
  if (!segments.length) throw new Error(`Stopped position does not match any of the last ${Math.min(searchWindow, acknowledged)} acknowledged motion lines`);
  segments.sort((a, b) => a.distance - b.distance || a.index - b.index);
  const interrupted = segments[0];

  let rewindIndex = -1;
  for (let index = interrupted.index; index >= 0; index -= 1) {
    const command = analysis.lines[index];
    if (!/^G0*0\b/.test(command)) continue;
    const z = command.match(new RegExp(`\\bZ(${NUMBER})\\b`));
    if (z && Number(z[1]) >= 0) { rewindIndex = index; break; }
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
    ...remaining,
  ].join("\n");
  return {
    gcode,
    acknowledgedLine: acknowledged,
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
