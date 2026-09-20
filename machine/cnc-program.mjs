const NUMBER = "[-+]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)";

export function cleanProgramLine(raw) {
  return String(raw || "")
    .replace(/\([^)]*\)/g, " ")
    .replace(/;.*/, "")
    .trim()
    .toUpperCase();
}

export function analyzeProgram(source, { maxBytes = 800_000, maxLines = 120_000, maxSpindleRpm = 9_000 } = {}) {
  const text = String(source || "");
  if (!text.trim()) throw new Error("G-code is empty");
  if (Buffer.byteLength(text, "utf8") > maxBytes) throw new Error(`G-code exceeds ${maxBytes} bytes`);
  if (text.includes("\0")) throw new Error("G-code contains a null byte");

  const lines = [];
  const bounds = { X: { min: Infinity, max: -Infinity }, Y: { min: Infinity, max: -Infinity }, Z: { min: Infinity, max: -Infinity } };
  let metric = false, absolute = false, spindleStart = false, spindleStop = false, maxS = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = cleanProgramLine(raw);
    if (!line) continue;
    if (line.length > 256) throw new Error("G-code line exceeds 256 characters");
    const unsupportedWords = line.replace(new RegExp(`(?:G|M|X|Y|Z|F|S|P)${NUMBER}`, "g"), "").replace(/\s+/g, "");
    if (unsupportedWords) throw new Error(`Unsupported G-code word(s): ${line}`);
    if (lines.length >= maxLines) throw new Error(`G-code exceeds ${maxLines} executable lines`);
    if (line.includes("$")) throw new Error("GRBL settings/system commands are not allowed in a carve file");
    if (/\bG(?:10|28|30|38(?:\.\d+)?|53|92)\b/.test(line)) throw new Error(`Unsafe coordinate/probe command is not allowed: ${line}`);
    if (/\bG91(?:\.\d+)?\b/.test(line)) throw new Error("Relative motion is not allowed in a carve file");
    const gCodes = [...line.matchAll(/\bG0*(\d+(?:\.\d+)?)\b/g)].map((match) => Number(match[1]));
    for (const code of gCodes) {
      if (![0, 1, 4, 17, 21, 90].includes(code)) throw new Error(`Unsupported G-code G${code}`);
      if (code === 21) metric = true;
      if (code === 90) absolute = true;
    }
    const mCodes = [...line.matchAll(/\bM0*(\d+)\b/g)].map((match) => Number(match[1]));
    for (const code of mCodes) {
      if (![2, 3, 5].includes(code)) throw new Error(`Unsupported M-code M${code}`);
      if (code === 3) spindleStart = true;
      if (code === 5) spindleStop = true;
    }
    for (const axis of ["X", "Y", "Z"]) {
      const match = line.match(new RegExp(`\\b${axis}(${NUMBER})\\b`));
      if (!match) continue;
      const value = Number(match[1]);
      if (!Number.isFinite(value)) throw new Error(`Invalid ${axis} coordinate`);
      bounds[axis].min = Math.min(bounds[axis].min, value);
      bounds[axis].max = Math.max(bounds[axis].max, value);
    }
    const s = line.match(new RegExp(`\\bS(${NUMBER})\\b`));
    if (s) {
      const rpm = Number(s[1]);
      if (!Number.isFinite(rpm) || rpm < 0 || rpm > maxSpindleRpm) throw new Error(`Spindle speed must be 0-${maxSpindleRpm} RPM`);
      maxS = Math.max(maxS, rpm);
    }
    lines.push(line);
  }
  if (!metric) throw new Error("G-code must declare metric mode with G21");
  if (!absolute) throw new Error("G-code must declare absolute mode with G90");
  if (!spindleStart || !spindleStop) throw new Error("G-code must contain both M3 and M5");
  for (const axis of ["X", "Y", "Z"]) {
    if (!Number.isFinite(bounds[axis].min)) bounds[axis] = { min: 0, max: 0 };
  }
  if (bounds.X.min < -10.001 || bounds.Y.min < -10.001) throw new Error("Carve X/Y coordinates may extend at most 10 mm behind work zero");
  return { lines, bounds, maxSpindleRpm: maxS, executableLines: lines.length };
}

export function validateProgramEnvelope(analysis, { widthMm = 360, heightMm = 360, maxDepthMm = 68, maxSafeZMm = 5 } = {}) {
  if (!analysis?.bounds) throw new Error("Program analysis is required");
  const { X, Y, Z } = analysis.bounds;
  if (X.max - X.min > Number(widthMm) + 0.001) throw new Error(`Program X span ${X.max - X.min} mm exceeds ${widthMm} mm envelope`);
  if (Y.max - Y.min > Number(heightMm) + 0.001) throw new Error(`Program Y span ${Y.max - Y.min} mm exceeds ${heightMm} mm envelope`);
  if (Z.min < -Math.abs(Number(maxDepthMm)) - 0.001) throw new Error(`Program Z ${Z.min} mm exceeds ${maxDepthMm} mm depth envelope`);
  if (Z.max > Number(maxSafeZMm) + 0.001) throw new Error(`Program safe Z ${Z.max} mm exceeds ${maxSafeZMm} mm envelope`);
  return true;
}
