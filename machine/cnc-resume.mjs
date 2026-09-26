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
