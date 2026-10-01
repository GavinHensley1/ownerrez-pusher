const NUMBER = "[-+]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)";

export function cleanProgramLine(raw) {
  return String(raw || "")
    .replace(/\([^)]*\)/g, " ")
    .replace(/;.*/, "")
    .trim()
    .toUpperCase();
}

const AXIS_WORD = (axis) => new RegExp(`\\b${axis}${NUMBER}`);
const FEED_WORD = new RegExp(`\\bF(${NUMBER})`);
// A vertical plunge is a feed move that changes Z with no X/Y component.
// The axis test MUST use the full number grammar: `\bZ[-+]?\d` silently misses the
// perfectly legal leading-dot forms `Z-.5` / `Z.5`, which would let an unlimited
// plunge straight through the limiter.
const isVerticalPlunge = (line) => /^G0*1\b/.test(line) && AXIS_WORD("Z").test(line) && !AXIS_WORD("X").test(line) && !AXIS_WORD("Y").test(line);

const assertPlungeLimit = (maxFeedMmMin) => {
  const limit = Number(maxFeedMmMin);
  if (!Number.isFinite(limit) || limit < 20 || limit > 300) throw new Error("Plunge feed limit must be 20-300 mm/min");
  return limit;
};

export function limitVerticalPlungeFeed(source, maxFeedMmMin = 60) {
  const limit = assertPlungeLimit(maxFeedMmMin);
  return String(source || "").split(/\r?\n/).map((raw) => {
    const line = cleanProgramLine(raw);
    if (!isVerticalPlunge(line)) return raw;
    const feed = line.match(FEED_WORD);
    if (!feed || Number(feed[1]) <= limit) return raw;
    return raw.replace(new RegExp(`\\bF(${NUMBER})`, "i"), `F${limit}`);
  }).join("\n");
}

// Feed is MODAL in G-code: a plunge with no F word inherits the last commanded feed,
// which limitVerticalPlungeFeed cannot see on that line and therefore cannot clamp.
// Rewriting such a line would also change the modal feed for every later move, so
// this fails CLOSED instead: it refuses the program and names the offending line.
// Verified against all five certified Rambo programs - their worst inherited plunge
// feed is 30 mm/min, so this rejects bad programs without blocking the real ones.
export function assertPlungeFeedWithinLimit(source, maxFeedMmMin = 60) {
  const limit = assertPlungeLimit(maxFeedMmMin);
  const lines = String(source || "").split(/\r?\n/);
  let modalFeed = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = cleanProgramLine(lines[index]);
    if (!line) continue;
    const feed = line.match(FEED_WORD);
    if (feed) modalFeed = Number(feed[1]);
    if (!isVerticalPlunge(line)) continue;
    const effective = feed ? Number(feed[1]) : modalFeed;
    if (effective === null || !Number.isFinite(effective)) {
      throw new Error(`Line ${index + 1} plunges in Z with no feed rate established: ${line}`);
    }
    if (effective > limit + 1e-9) {
      throw new Error(`Line ${index + 1} would plunge at ${effective} mm/min, above the ${limit} mm/min vertical limit${feed ? "" : " inherited from an earlier modal F"}: ${line}`);
    }
  }
  return { ok: true, limitMmPerMin: limit };
}

// The generated Finish stage intentionally uses hundreds of thousands of
// short, bounded moves to preserve relief detail. Transport and parsing remain
// byte/line bounded, but the defaults must cover the generator's 700k budget.
export function analyzeProgram(source, { maxBytes = 10_000_000, maxLines = 750_000, maxSpindleRpm = 9_000, spindleMode = "controller" } = {}) {
  const text = String(source || "");
  if (!text.trim()) throw new Error("G-code is empty");
  if (Buffer.byteLength(text, "utf8") > maxBytes) throw new Error(`G-code exceeds ${maxBytes} bytes`);
  if (text.includes("\0")) throw new Error("G-code contains a null byte");

  const lines = [];
  const bounds = { X: { min: Infinity, max: -Infinity }, Y: { min: Infinity, max: -Infinity }, Z: { min: Infinity, max: -Infinity } };
  let metric = false, absolute = false, spindleStart = false, spindleStop = false, maxS = 0, motion, feed;
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
    const words = [...line.matchAll(new RegExp(`([GMXYZFSP])(${NUMBER})`, "g"))].map((match) => ({ letter: match[1], value: Number(match[2]) }));
    // Downstream envelope/resume parsers consume spaced words. Reject compact
    // input instead of allowing different components to interpret different paths.
    if (line.split(/\s+/).length !== words.length) throw new Error("G-code words must be separated by whitespace");
    for (const letter of ["X", "Y", "Z", "F", "S", "P"]) {
      if (words.filter(word => word.letter === letter).length > 1) throw new Error(`Duplicate ${letter} word: ${line}`);
    }
    const gCodes = words.filter(word => word.letter === "G").map(word => word.value);
    if (gCodes.filter(code => code === 0 || code === 1).length > 1) throw new Error(`Conflicting motion modes: ${line}`);
    for (const code of gCodes) {
      if ([10, 28, 30, 38.2, 38.3, 53, 92].includes(code)) throw new Error(`Unsafe coordinate/probe command is not allowed: ${line}`);
      if (code === 91) throw new Error("Relative motion is not allowed in a carve file");
      if (code === 0 || code === 1) motion = code;
      if (![0, 1, 4, 17, 21, 90].includes(code)) throw new Error(`Unsupported G-code G${code}`);
      if (code === 21) metric = true;
      if (code === 90) absolute = true;
    }
    const feedWord = words.find(word => word.letter === "F");
    if (feedWord) {
      if (!(Number.isFinite(feedWord.value) && feedWord.value > 0)) throw new Error("Program feed must be finite and positive");
      feed = feedWord.value;
    }
    const hasAxes = words.some(word => ["X", "Y", "Z"].includes(word.letter));
    if (hasAxes && (!metric || !absolute)) throw new Error("G21 and G90 must be established before the first axis command");
    if (hasAxes && motion === undefined) throw new Error("Program must establish G0/G1 before axis motion");
    if (hasAxes && motion === 1 && feed === undefined) throw new Error("G1 motion requires an explicit positive feed before cutting");
    if (hasAxes && gCodes.includes(4)) throw new Error("Dwell blocks must not contain axes");
    const mCodes = words.filter(word => word.letter === "M").map(word => word.value);
    for (const code of mCodes) {
      if (![2, 3, 5, 30].includes(code)) throw new Error(`Unsupported M-code M${code}`);
      if (code === 3) spindleStart = true;
      if (code === 5) spindleStop = true;
    }
    for (const axis of ["X", "Y", "Z"]) {
      const word = words.find(word => word.letter === axis);
      if (!word) continue;
      const value = word.value;
      if (!Number.isFinite(value)) throw new Error(`Invalid ${axis} coordinate`);
      bounds[axis].min = Math.min(bounds[axis].min, value);
      bounds[axis].max = Math.max(bounds[axis].max, value);
    }
    const s = words.find(word => word.letter === "S");
    if (s) {
      const rpm = s.value;
      if (!Number.isFinite(rpm) || rpm < 0 || rpm > maxSpindleRpm) throw new Error(`Spindle speed must be 0-${maxSpindleRpm} RPM`);
      maxS = Math.max(maxS, rpm);
    }
    lines.push(line);
  }
  if (!metric) throw new Error("G-code must declare metric mode with G21");
  if (!absolute) throw new Error("G-code must declare absolute mode with G90");
  if (spindleMode === "manual") {
    if (spindleStart || spindleStop || maxS > 0) throw new Error("Manual-router G-code must not contain M3, M5, or spindle-speed commands");
    // M2/M30 can make inexpensive GRBL bridges close or stop answering before
    // their final acknowledgement. The external router is already controlled
    // manually, so omit only terminal program-end commands after validating the
    // complete file. An embedded M2/M30 is still unsafe and rejected.
    while (/^M0*(?:2|30)$/.test(lines.at(-1) || "")) lines.pop();
    if (lines.some((line) => /\bM0*(?:2|30)\b/.test(line))) throw new Error("Manual-router M2/M30 is allowed only as the terminal command");
  } else if (spindleMode === "controller") {
    if (!spindleStart || !spindleStop) throw new Error("Controller-spindle G-code must contain both M3 and M5");
  } else {
    throw new Error("Spindle mode must be controller or manual");
  }
  for (const axis of ["X", "Y", "Z"]) {
    if (!Number.isFinite(bounds[axis].min)) bounds[axis] = { min: 0, max: 0 };
  }
  if (bounds.X.min < -10.001 || bounds.Y.min < -10.001) throw new Error("Carve X/Y coordinates may extend at most 10 mm behind work zero");
  return { lines, bounds, maxSpindleRpm: maxS, spindleMode, executableLines: lines.length };
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

export function validateProgramStockEnvelope(analysis, { widthMm, heightMm, reserveMm = 0 } = {}) {
  if (!analysis?.bounds) throw new Error("Program analysis is required");
  const width = Number(widthMm), height = Number(heightMm), reserve = Math.max(0, Number(reserveMm) || 0);
  if (!(width > 0 && height > 0)) throw new Error("Actual stock X/Y dimensions are required");
  const { X, Y } = analysis.bounds;
  if (X.min < -0.001 || Y.min < -0.001) throw new Error(`Program begins outside the stock-corner zero: X ${X.min} mm, Y ${Y.min} mm`);
  if (X.max > width - reserve + 0.001) throw new Error(`Program X maximum ${X.max} mm exceeds usable stock ${width - reserve} mm`);
  if (Y.max > height - reserve + 0.001) throw new Error(`Program Y maximum ${Y.max} mm exceeds usable stock ${height - reserve} mm`);
  return true;
}

export function approvedProgramDepth(setup = {}, context = {}) {
  const protectedDepth = Number(setup.maxCutDepthMm);
  if (!(protectedDepth > 0)) throw new Error("Measured stock depth is unavailable");
  if (!["profile", "release"].includes(context.operation) || context.allowSacrificialCutThrough !== true) return protectedDepth;
  if (context.sacrificialBackingConfirmed !== true) throw new Error("Sacrificial backing confirmation is required for profile cut-through");
  const stockThickness = Number(setup.stockThicknessMm), targetDepth = Number(context.profileDepthMm);
  if (!(stockThickness > 0) || !(targetDepth > 0)) throw new Error("Measured stock thickness and profile depth are required");
  const allowance = targetDepth - stockThickness;
  if (allowance < -0.001 || allowance > 0.201) throw new Error(`Profile cut-through allowance ${allowance.toFixed(3)} mm is outside the approved 0-0.200 mm range`);
  return targetDepth;
}

export function measuredStockProtection(bedSurfaceMPos, stockSurfaceMPos) {
  const bed = Number(bedSurfaceMPos), stock = Number(stockSurfaceMPos), thickness = stock - bed;
  if (!Number.isFinite(thickness) || thickness < 1 || thickness > 70) throw new Error(`Measured stock thickness ${Number.isFinite(thickness) ? thickness.toFixed(3) : "invalid"} mm is outside the safe 1-70 mm range`);
  const safetyFloorMm = Math.max(0.8, thickness * 0.05);
  return {
    stockThicknessMm: Number(thickness.toFixed(3)),
    safetyFloorMm: Number(safetyFloorMm.toFixed(3)),
    maxCutDepthMm: Number((thickness - safetyFloorMm).toFixed(3)),
  };
}
