export function splitJogDistance(axis, distanceMm) {
  const normalizedAxis = String(axis || "").toUpperCase();
  if (!new Set(["X", "Y", "Z"]).has(normalizedAxis)) throw new Error("Jog axis must be X, Y, or Z");
  const distance = Number(distanceMm);
  if (!Number.isFinite(distance) || distance === 0 || Math.abs(distance) > 100) throw new Error("Jog distance must be non-zero and no more than 100 mm");
  const maxSegment = normalizedAxis === "Z" ? 5 : 10;
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
