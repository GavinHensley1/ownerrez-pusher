export function splitJogDistance(axis, distanceMm) {
  const normalizedAxis = String(axis || "").toUpperCase();
  if (!new Set(["X", "Y", "Z"]).has(normalizedAxis)) throw new Error("Jog axis must be X, Y, or Z");
  const distance = Number(distanceMm);
  if (!Number.isFinite(distance) || distance === 0 || Math.abs(distance) > 100) throw new Error("Jog distance must be non-zero and no more than 100 mm");
  // The operator chooses the whole move; each controller request retains the
  // existing recovery/Z limit without requiring repeated operator clicks.
  const maxSegment = 5;
  const sign = Math.sign(distance);
  let remaining = Math.abs(distance);
  const segments = [];
  while (remaining > 0.0005) {
    const magnitude = Math.min(maxSegment, remaining);
    segments.push(Number((sign * magnitude).toFixed(3)));
    remaining = Number((remaining - magnitude).toFixed(6));
  }
  return segments;
}

export async function runJogSegments(axis, distance, { move, cancelled = () => false }) {
  const segments = splitJogDistance(axis, distance);
  let result;
  for (let index = 0; index < segments.length; index++) {
    if (cancelled()) throw new Error("Manual move cancelled; remaining distance discarded");
    result = await move(segments[index], index, segments.length);
  }
  if (cancelled()) throw new Error("Manual move cancelled; remaining distance discarded");
  return { ...result, requestedDistanceMm: Number(distance), completedSegments: segments.length };
}
