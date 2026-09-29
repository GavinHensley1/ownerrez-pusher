export const POSITIONING_OUTSIDE_STOCK_MM = 20;
export const POSITIONING_NEGATIVE_MARGIN_MM = 60;

const finitePositive = (value) => Number.isFinite(Number(value)) && Number(value) > 0;

export function positioningBoundsFromStock(origin, { stockWidthMm, stockHeightMm } = {}) {
  const x = Number(origin?.X), y = Number(origin?.Y);
  if (![x, y].every(Number.isFinite)) throw new Error("Positioning envelope requires a valid X/Y origin");
  if (!finitePositive(stockWidthMm) || !finitePositive(stockHeightMm)) throw new Error("Positioning envelope requires the entered stock X/Y dimensions");
  return {
    X: { min: x, max: x + Number(stockWidthMm) + POSITIONING_OUTSIDE_STOCK_MM },
    Y: { min: y, max: y + Number(stockHeightMm) + POSITIONING_OUTSIDE_STOCK_MM },
  };
}

export function assertWorkJogWithinStock({ workPosition, axis, distanceMm, stockWidthMm, stockHeightMm }) {
  const normalizedAxis = String(axis || "").toUpperCase();
  if (!new Set(["X", "Y"]).has(normalizedAxis)) return null;
  const current = Number(workPosition?.[normalizedAxis]), distance = Number(distanceMm);
  const stock = normalizedAxis === "X" ? Number(stockWidthMm) : Number(stockHeightMm);
  if (!Number.isFinite(current) || !Number.isFinite(distance)) throw new Error(`Current work ${normalizedAxis} position is unavailable`);
  if (!finitePositive(stock)) throw new Error("Enter the actual stock X/Y dimensions before positioning");
  const min = -POSITIONING_NEGATIVE_MARGIN_MM, max = stock + POSITIONING_OUTSIDE_STOCK_MM, target = current + distance;
  const returningFromLow = current < min - 0.001 && distance > 0 && target > current;
  const returningFromHigh = current > max + 0.001 && distance < 0 && target < current;
  if ((current < min - 0.001 && distance <= 0) || (current > max + 0.001 && distance >= 0)) {
    throw new Error(`${normalizedAxis} is already outside the safe positioning envelope; move only toward the stock`);
  }
  if (!returningFromLow && !returningFromHigh && (target < min - 0.001 || target > max + 0.001)) {
    throw new Error(`${normalizedAxis} move would reach ${target.toFixed(3)} mm; Project allows ${min.toFixed(3)}..${max.toFixed(3)} mm around this stock`);
  }
  return { axis: normalizedAxis, current, target, min, max, returningToEnvelope: returningFromLow || returningFromHigh };
}
