// Runs the inline browser script from index.html under Node so the real
// rendering functions can be tested instead of grepped. Grep-only contract
// tests cannot tell that a drawn cell collapsed to one pixel; this can.
import { readFileSync } from "node:fs";

const BACKGROUND = [11, 18, 32]; // #0b1220, the preview canvas background

function parseColor(value) {
  const text = String(value);
  const hex = /^#([0-9a-f]{6})$/i.exec(text);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255];
  }
  const rgb = /rgba?\(([^)]+)\)/i.exec(text);
  if (rgb) {
    const parts = rgb[1].split(",").map(Number);
    return [parts[0] | 0, parts[1] | 0, parts[2] | 0, parts.length > 3 ? Math.round(parts[3] * 255) : 255];
  }
  return [255, 255, 255, 255];
}

// Pixel-backed 2D context. Only the operations the preview actually uses are
// implemented; anything else is a no-op so an unrelated draw cannot fail a test.
function makeContext(width, height) {
  const data = new Uint8ClampedArray(width * height * 4);
  return {
    canvas: { width, height },
    fillStyle: "#000", strokeStyle: "#000", lineWidth: 1, lineJoin: "", lineCap: "", font: "",
    __data: data, __width: width, __height: height,
    fillRect(x, y, w, h) {
      const color = parseColor(this.fillStyle);
      const x0 = Math.max(0, Math.round(x)), y0 = Math.max(0, Math.round(y));
      const x1 = Math.min(width, Math.round(x + w)), y1 = Math.min(height, Math.round(y + h));
      for (let yy = y0; yy < y1; yy += 1) {
        for (let xx = x0; xx < x1; xx += 1) {
          const i = (yy * width + xx) * 4;
          data[i] = color[0]; data[i + 1] = color[1]; data[i + 2] = color[2]; data[i + 3] = color[3];
        }
      }
    },
    getImageData() { return { width, height, data: new Uint8ClampedArray(data) }; },
    putImageData(image) { data.set(image.data); },
    beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, strokeRect() {},
    arc() {}, fill() {}, fillText() {}, setLineDash() {},
    toDataURL() { return "data:image/png;base64,HARNESS"; },
  };
}

function makeElement() {
  return {
    style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    className: "", textContent: "", innerHTML: "", value: "", checked: false,
    disabled: false, files: [], options: [], children: [],
    appendChild() {}, insertBefore() {}, remove() {}, setAttribute() {}, removeAttribute() {},
    addEventListener() {}, removeEventListener() {}, focus() {}, click() {},
    querySelector() { return null; }, querySelectorAll() { return []; }, closest() { return null; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0 }; },
  };
}

export function loadBrowserScript(indexPath) {
  const html = readFileSync(indexPath, "utf8");
  const match = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (!match) throw new Error("index.html has no inline script block");
  const source = match[1];

  const canvases = [];
  const elements = {};
  const document = {
    __elements: elements,
    body: makeElement(), head: makeElement(), documentElement: makeElement(),
    getElementById(id) { elements[id] = elements[id] || makeElement(); return elements[id]; },
    createElement(tag) {
      if (tag !== "canvas") return makeElement();
      const canvas = {
        width: 0, height: 0, style: {}, setAttribute() {},
        getContext() { this.__context = this.__context || makeContext(this.width, this.height); return this.__context; },
        toDataURL() { return "data:image/png;base64,HARNESS"; },
      };
      canvases.push(canvas);
      return canvas;
    },
    createTextNode() { return makeElement(); },
    addEventListener() {}, removeEventListener() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
  };

  const globals = {
    document,
    Image: class { set src(value) { /* no decoding in the harness */ } },
    URL: { createObjectURL() { return ""; }, revokeObjectURL() {} },
    alert() {}, confirm() { return false; },
    fetch() { throw new Error("the harness makes no network calls"); },
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    setInterval() { return 0; }, clearInterval() {}, setTimeout() { return 0; },
    requestAnimationFrame() { return 0; },
    navigator: { userAgent: "cnc-harness" },
  };
  globals.window = globals;

  // index.html runs at browser top level, which is sloppy mode and tolerates a
  // duplicate function declaration (the last one wins). A `with` block would
  // make the same source a SyntaxError, so the globals are passed as named
  // parameters instead.
  const names = Object.keys(globals);
  const factory = new Function(...names, `${source}\n; return { cncRenderToolpath, cncToolFootprint, cncStageToolName, cncBitRadius, cncBitStepover, cncDepthBand,
    setJob(job) { CNC = { jobs: [job], config: {} }; CNC_CUR = job.id; },
    // Exposes the REAL Start/Resume gate so the operator path can be walked
    // offline instead of grepped. cncRenderAgent reads CNC.agent.health, so the
    // simulated daemon payload is installed alongside the job.
    renderAgent(job, health, config) {
      CNC = { jobs: [job], config: config || {}, agent: { health: health } };
      CNC_CUR = job.id;
      CNC_COMMAND_IN_FLIGHT = false;
      cncRenderAgent(job);
      return {
        start: document.getElementById('cncStartBtn'),
        resume: document.getElementById('cncResumeBtn'),
        readiness: document.getElementById('cncReadiness'),
        auditHold: document.getElementById('cncCutAuditHold'),
        thicknessHold: document.getElementById('cncStockThicknessHold'),
      };
    },
  };`);
  const api = factory(...names.map((name) => globals[name]));
  return { ...api, canvases, elements, background: BACKGROUND };
}

// Coverage statistics for a rendered preview canvas.
export function canvasCoverage(canvas) {
  const context = canvas.getContext();
  const { __data: data, __width: width, __height: height } = context;
  const isBackground = (i) => data[i] === BACKGROUND[0] && data[i + 1] === BACKGROUND[1] && data[i + 2] === BACKGROUND[2];
  let painted = 0, worstRun = 0;
  for (let y = 0; y < height; y += 1) {
    let run = 0, sawPaint = false;
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      if (isBackground(i)) { if (sawPaint) run += 1; continue; }
      painted += 1; sawPaint = true;
      if (run > worstRun) worstRun = run;
      run = 0;
    }
  }
  return { width, height, painted, paintedFraction: painted / (width * height), worstInteriorGapPx: worstRun };
}
