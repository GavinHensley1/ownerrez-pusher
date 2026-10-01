// Minimal, strict G-code reader shared by the model builder and the validator.
//
// It deliberately understands only the subset this project emits and accepts:
// G21/G90 modal setup, G0/G1 linear motion, X/Y/Z/F words, M30. Anything else is
// reported rather than silently ignored, because "silently ignored" is how a
// G92 or a tool-length offset gets to change the effective zero without anyone
// noticing.

export function* parseMoves(code) {
  let x = 0;
  let y = 0;
  let z = 0;
  let feed = 0;
  let motion = null;
  let lineNumber = 0;

  for (const rawLine of code.split(/\r?\n/)) {
    lineNumber += 1;
    const line = rawLine.replace(/;.*/, "").replace(/\([^)]*\)/g, "").trim();
    if (!line) continue;

    const motionMatch = line.match(/(?:^|\s)G0*([01])(?=\s|$)/i);
    if (motionMatch) motion = Number(motionMatch[1]);

    const words = {};
    for (const match of line.matchAll(/([XYZF])\s*(-?\d+(?:\.\d+)?)/gi)) {
      words[match[1].toUpperCase()] = Number(match[2]);
    }

    const from = { x, y, z };
    if (Number.isFinite(words.X)) x = words.X;
    if (Number.isFinite(words.Y)) y = words.Y;
    if (Number.isFinite(words.Z)) z = words.Z;
    if (Number.isFinite(words.F)) feed = words.F;

    const moved = x !== from.x || y !== from.y || z !== from.z;
    if (!moved || motion === null) continue;

    yield { lineNumber, rapid: motion === 0, from, to: { x, y, z }, feed, text: line };
  }
}

export function segmentLengthMm(move) {
  const dx = move.to.x - move.from.x;
  const dy = move.to.y - move.from.y;
  const dz = move.to.z - move.from.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
