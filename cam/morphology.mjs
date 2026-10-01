// Greyscale morphology on the depth field, used to answer the one question
// that decides whether a roughing stage is worth running: how much of the
// relief can a flat cutter of a given diameter actually reach?
//
// A flat tool at (x, y) can only descend to the SHALLOWEST point under its
// footprint, so the reachable depth field is the erosion of the depth field by
// the tool disc; sweeping the tool over the part then dilates that back. The
// opening (erode then dilate) is exactly the surface a perfect flat-tool
// roughing pass leaves behind. The leftover, depth minus opening, is what the
// finish tool must still remove, and it is what decides whether a separate
// cleanup stage is genuinely required or merely traditional.
//
// Outside the modelled region there is untouched stock at Z0, i.e. depth 0. For
// erosion that is a hard constraint (a tool overhanging the edge cannot
// descend); for dilation it contributes nothing.

/** Per-row half-widths of a disc of the given radius, in cells. */
export function discSpans(radiusCells) {
  const spans = [];
  for (let j = -radiusCells; j <= radiusCells; j += 1) {
    spans.push({ j, half: Math.floor(Math.sqrt(Math.max(0, radiusCells * radiusCells - j * j))) });
  }
  return spans;
}

/**
 * Sliding-window extreme over one row, O(cols) via a monotonic deque.
 * `outside` is the value assumed beyond both ends of the row.
 */
export function rowWindowExtreme(source, cols, half, takeMax, outside, destination) {
  const span = 2 * half + 1;
  const index = new Int32Array(span + 1);
  const value = new Float64Array(span + 1);
  let head = 0;
  let tail = 0;
  const outranks = takeMax ? (a, b) => a >= b : (a, b) => a <= b;

  const push = (i, v) => {
    while (tail > head && outranks(v, value[(tail - 1) % index.length])) tail -= 1;
    index[tail % index.length] = i;
    value[tail % index.length] = v;
    tail += 1;
  };
  const at = (i) => (i < 0 || i >= cols ? outside : source[i]);

  for (let i = -half; i < half; i += 1) push(i, at(i));
  for (let out = 0; out < cols; out += 1) {
    push(out + half, at(out + half));
    while (index[head % index.length] < out - half) head += 1;
    destination[out] = value[head % index.length];
  }
  return destination;
}

function transform(field, cols, rows, radiusCells, takeMax) {
  const spans = discSpans(radiusCells);
  const outside = takeMax ? Number.NEGATIVE_INFINITY : 0;
  const output = new Float32Array(cols * rows);
  const rowIn = new Float64Array(cols);
  const rowOut = new Float64Array(cols);
  const accumulator = new Float64Array(cols);

  for (let r = 0; r < rows; r += 1) {
    accumulator.fill(takeMax ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY);
    for (const { j, half } of spans) {
      const rr = r + j;
      if (rr < 0 || rr >= rows) {
        if (!takeMax) accumulator.fill(0); // overhanging the edge: cannot descend
        continue;
      }
      const base = rr * cols;
      for (let c = 0; c < cols; c += 1) rowIn[c] = field[base + c];
      rowWindowExtreme(rowIn, cols, half, takeMax, outside, rowOut);
      for (let c = 0; c < cols; c += 1) {
        const v = rowOut[c];
        if (takeMax ? v > accumulator[c] : v < accumulator[c]) accumulator[c] = v;
      }
    }
    const base = r * cols;
    for (let c = 0; c < cols; c += 1) {
      const v = accumulator[c];
      output[base + c] = Number.isFinite(v) ? v : 0;
    }
  }
  return output;
}

export function discErode(field, cols, rows, radiusCells) {
  return transform(field, cols, rows, radiusCells, false);
}

export function discDilate(field, cols, rows, radiusCells) {
  return transform(field, cols, rows, radiusCells, true);
}

export function depthField(model) {
  const depth = new Float32Array(model.cols * model.rows);
  for (let i = 0; i < depth.length; i += 1) depth[i] = model.depthUm[i] / 1000;
  return depth;
}

/**
 * Depth a flat cutter of the given radius can reach with its CENTRE at each
 * cell: the erosion of the depth field.
 */
export function flatToolCentreDepth(model, toolRadiusMm) {
  return discErode(depthField(model), model.cols, model.rows, Math.round(toolRadiusMm / model.gridMm));
}

/**
 * Surface a complete flat-tool roughing pass leaves behind: the opening.
 */
export function flatToolReachableDepth(model, toolRadiusMm) {
  const radiusCells = Math.round(toolRadiusMm / model.gridMm);
  const eroded = discErode(depthField(model), model.cols, model.rows, radiusCells);
  return discDilate(eroded, model.cols, model.rows, radiusCells);
}
