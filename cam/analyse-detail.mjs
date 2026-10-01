// Measure, and show, what this artwork becomes when the W01015 tapered ball
// nose is the smallest tool permitted to touch metal.
//
//   node cam/analyse-detail.mjs [output-dir]
//
// Produces a per-element verdict and two previews. The previews are the point:
// the project's binding rule is that the design we see must be the design that
// gets made, so before a wedding piece is committed somebody has to LOOK at what
// the tools can actually cut, not at the artwork.
//
// The measurement runs on the CERTIFIED RELIEF -- the surface reconstructed by
// sweeping the accepted Finish program's own tool -- not on a design PNG. See
// the header of achievable-detail.mjs for why no usable design height field
// exists for the current "The Rambo's" artwork.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TOOLS } from "./tool-library.mjs";
import { ReliefModel, offsetPolygon, pointInPolygon } from "./relief-model.mjs";
import {
  bottomingSignature,
  maxDepthForGrooveWidthMm,
  minGrooveWidthMm,
} from "./achievable-detail.mjs";
import { encodePng } from "./png.mjs";

// Named artwork elements, in machine millimetres on the relief bounds
// (X 8-122, Y 21-109), read off the reconstructed relief. Boxes are generous:
// an over-large box dilutes that element's figures, so it cannot manufacture a
// worse verdict than the artwork deserves. The region overlay preview exists so
// these can be checked by eye rather than trusted.
const REGIONS = [
  { id: "lettering", label: "\"The Rambo's\" lettering", box: [28.0, 84.0, 102.0, 102.0] },
  { id: "corn-left", label: "Left corn cob (kernels)", box: [21.0, 58.0, 31.0, 80.0] },
  { id: "corn-right", label: "Right corn cob (kernels)", box: [99.0, 58.0, 109.0, 80.0] },
  { id: "figures", label: "Couple (two figures)", box: [55.0, 40.0, 72.0, 65.0] },
  { id: "rays", label: "Radiating field / sun rays", box: [44.0, 39.0, 86.0, 62.0], exclude: ["figures"] },
  { id: "mountains", label: "Mountains", box: [44.0, 62.0, 86.0, 78.0] },
  { id: "rope-inner", label: "Inner rope ring", ring: [64.9, 61.0, 22.5, 26.0] },
  { id: "rope-outer", label: "Outer rope border", edgeBand: [0.5, 7.0] },
  { id: "scroll", label: "Scrollwork / acanthus", rest: true },
];

function buildMasks(relief, partEdge, insideMask) {
  const { cols, rows } = relief;
  const masks = new Map();
  for (const region of REGIONS) masks.set(region.id, new Uint8Array(cols * rows));
  const edgeInner = offsetPolygon(partEdge, -7.0);
  const edgeOuter = offsetPolygon(partEdge, -0.5);

  for (let r = 0; r < rows; r += 1) {
    const y = relief.yOf(r);
    for (let c = 0; c < cols; c += 1) {
      const index = r * cols + c;
      if (!insideMask[index]) continue;
      const x = relief.xOf(c);
      let claimed = false;
      for (const region of REGIONS) {
        if (region.rest) continue;
        let hit = false;
        if (region.box) {
          const [x0, y0, x1, y1] = region.box;
          hit = x >= x0 && x <= x1 && y >= y0 && y <= y1;
        } else if (region.ring) {
          const [cx, cy, r0, r1] = region.ring;
          const d = Math.hypot(x - cx, y - cy);
          hit = d >= r0 && d <= r1;
        } else if (region.edgeBand) {
          hit = pointInPolygon(edgeOuter, x, y) && !pointInPolygon(edgeInner, x, y);
        }
        if (hit && region.exclude) {
          for (const other of region.exclude) {
            const [x0, y0, x1, y1] = REGIONS.find((entry) => entry.id === other).box;
            if (x >= x0 && x <= x1 && y >= y0 && y <= y1) hit = false;
          }
        }
        if (hit) {
          masks.get(region.id)[index] = 1;
          claimed = true;
        }
      }
      if (!claimed) masks.get("scroll")[index] = 1;
    }
  }
  return masks;
}

// ---------------------------------------------------------------- rendering

function hillshade(depth, cols, rows, gridMm, mask, maxDepth) {
  const rgb = Buffer.alloc(cols * rows * 3);
  const lx = -0.45;
  const ly = 0.45;
  const lz = 0.77;
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      // Image row 0 is the top of the picture, i.e. the HIGHEST machine Y.
      const mr = rows - 1 - r;
      const index = mr * cols + c;
      const out = (r * cols + c) * 3;
      if (mask && !mask[index]) {
        rgb[out] = 16;
        rgb[out + 1] = 18;
        rgb[out + 2] = 22;
        continue;
      }
      const at = (cc, rr) => -depth[Math.min(rows - 1, Math.max(0, rr)) * cols + Math.min(cols - 1, Math.max(0, cc))];
      const nx = (at(c - 1, mr) - at(c + 1, mr)) / (2 * gridMm);
      const ny = (at(c, mr + 1) - at(c, mr - 1)) / (2 * gridMm);
      const length = Math.hypot(nx, ny, 1);
      const diffuse = Math.max(0, (nx * lx + ny * ly + lz) / length);
      // Depth darkening stands in for ambient occlusion, which is how the eye
      // reads a real relief under shop light.
      const sink = 1 - 0.5 * (depth[index] / maxDepth);
      const value = Math.round(255 * Math.min(1, (0.16 + 0.84 * diffuse ** 1.5) * sink));
      rgb[out] = value;
      rgb[out + 1] = value;
      rgb[out + 2] = value;
    }
  }
  return rgb;
}

/** Paint the bottomed-out cells over a hillshade, so the limit is visible in place. */
function overlayLimited(base, limited, cols, rows) {
  const rgb = Buffer.from(base);
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const index = (rows - 1 - r) * cols + c;
      if (!limited[index]) continue;
      const out = (r * cols + c) * 3;
      rgb[out] = Math.min(255, Math.round(rgb[out] * 0.4 + 190));
      rgb[out + 1] = Math.round(rgb[out + 1] * 0.35);
      rgb[out + 2] = Math.round(rgb[out + 2] * 0.35 + 30);
    }
  }
  return rgb;
}

function tile(panels, cols, rows, gap = 14) {
  const width = panels.length * cols + (panels.length - 1) * gap;
  const out = Buffer.alloc(width * rows * 3, 0);
  panels.forEach((panel, p) => {
    const x0 = p * (cols + gap);
    for (let r = 0; r < rows; r += 1) {
      panel.copy(out, (r * width + x0) * 3, r * cols * 3, (r + 1) * cols * 3);
    }
  });
  return { buffer: out, width, height: rows };
}

function crop(rgb, cols, box, scale) {
  const [c0, r0, c1, r1] = box;
  const w = c1 - c0;
  const h = r1 - r0;
  const out = Buffer.alloc(w * scale * h * scale * 3);
  for (let r = 0; r < h * scale; r += 1) {
    for (let c = 0; c < w * scale; c += 1) {
      const src = ((r0 + Math.floor(r / scale)) * cols + c0 + Math.floor(c / scale)) * 3;
      const dst = (r * w * scale + c) * 3;
      out[dst] = rgb[src];
      out[dst + 1] = rgb[src + 1];
      out[dst + 2] = rgb[src + 2];
    }
  }
  return { buffer: out, width: w * scale, height: h * scale };
}

function stackRows(rowsOfPanels, gap = 14) {
  const width = Math.max(...rowsOfPanels.map((row) => row.width));
  const height = rowsOfPanels.reduce((sum, row) => sum + row.height, 0) + gap * (rowsOfPanels.length - 1);
  const out = Buffer.alloc(width * height * 3, 0);
  let y = 0;
  for (const row of rowsOfPanels) {
    for (let r = 0; r < row.height; r += 1) {
      row.buffer.copy(out, (y + r) * width * 3, r * row.width * 3, (r + 1) * row.width * 3);
    }
    y += row.height + gap;
  }
  return { buffer: out, width, height };
}

// -------------------------------------------------------------------- main

export function analyse({ modelDir = join(import.meta.dirname, "models") } = {}) {
  const relief = ReliefModel.decode(readFileSync(join(modelDir, "rambo-buckle-relief.bin")));
  const silhouette = JSON.parse(readFileSync(join(modelDir, "rambo-buckle-silhouette.json"), "utf8"));
  const partEdge = offsetPolygon(silhouette.points, -silhouette.profileToolRadiusMm);
  const { cols, rows, gridMm } = relief;

  const insideMask = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      if (pointInPolygon(partEdge, relief.xOf(c), relief.yOf(r))) insideMask[r * cols + c] = 1;
    }
  }

  const depth = new Float32Array(cols * rows);
  for (let i = 0; i < depth.length; i += 1) depth[i] = relief.depthUm[i] / 1000;
  const maxDepth = relief.stats().maxDepthMm;

  const tool = TOOLS["spetool-w01015-spe-x"];

  // Where did this tool bottom out? Measured from the surface it left, with no
  // design file involved. See bottomingSignature() for why an arc of the tool's
  // own tip radius proves the tool, not the artwork, set that floor.
  const signature = bottomingSignature(depth, cols, rows, gridMm, tool.tipRadiusMm);
  const RECESSED_MM = 0.08;
  const limited = new Uint8Array(cols * rows);
  for (let i = 0; i < depth.length; i += 1) {
    if (insideMask[i] && depth[i] >= RECESSED_MM && signature.bottomed[i]) limited[i] = 1;
  }

  const masks = buildMasks(relief, partEdge, insideMask);
  const scoreRegion = (mask) => {
    const cell = gridMm * gridMm;
    let area = 0;
    const depths = [];
    let bottomedCells = 0;
    for (let i = 0; i < depth.length; i += 1) {
      if (!mask[i]) continue;
      area += 1;
      if (depth[i] < RECESSED_MM) continue;
      depths.push(depth[i]);
      if (limited[i]) bottomedCells += 1;
    }
    depths.sort((a, b) => a - b);
    const at = (q) => (depths.length ? depths[Math.min(depths.length - 1, Math.floor(q * depths.length))] : 0);
    const mean = depths.length ? depths.reduce((a, b) => a + b, 0) / depths.length : 0;
    return {
      areaMm2: area * cell,
      recessedAreaMm2: depths.length * cell,
      meanDepthMm: mean,
      medianDepthMm: at(0.5),
      p90DepthMm: at(0.9),
      maxDepthMm: depths.length ? depths[depths.length - 1] : 0,
      bottomedFraction: depths.length ? bottomedCells / depths.length : 0,
      // How much of the part's full relief range this element actually uses.
      reliefUsedFraction: maxDepth === 0 ? 0 : mean / maxDepth,
    };
  };

  const regions = REGIONS.map((region) => ({
    id: region.id,
    label: region.label,
    ...scoreRegion(masks.get(region.id)),
  }));
  const overall = scoreRegion(insideMask);

  const buckets = [0.1, 0.2, 0.3, 0.45, 0.6, 0.8];
  const census = buckets.map((upper, index) => ({
    upperMm: upper,
    lowerMm: index === 0 ? 0 : buckets[index - 1],
    grooveWidthNeededMm: minGrooveWidthMm(tool, upper),
    cells: 0,
    areaMm2: 0,
  }));
  let recessedCells = 0;
  for (let i = 0; i < depth.length; i += 1) {
    if (!insideMask[i] || depth[i] < RECESSED_MM) continue;
    recessedCells += 1;
    (census.find((entry) => depth[i] <= entry.upperMm) || census[census.length - 1]).cells += 1;
  }
  for (const entry of census) entry.areaMm2 = entry.cells * gridMm * gridMm;

  return {
    relief,
    partEdge,
    insideMask,
    depth,
    maxDepth,
    limited,
    signature,
    masks,
    regions,
    overall,
    census,
    recessedCells,
    tool,
    geometry: {
      tool: tool.name,
      tipDiameterMm: tool.diameterMm,
      tipRadiusMm: tool.tipRadiusMm,
      taperHalfAngleDeg: tool.taperHalfAngleDeg,
      grooveWidthAtDepth: [0.1, 0.2, 0.28, 0.4, 0.5, 0.62, 0.79, maxDepth].map((d) => ({
        depthMm: d,
        widthMm: minGrooveWidthMm(tool, d),
      })),
      depthReachableInGroove: [0.3, 0.4, 0.6, 0.8, 1.0, 1.2, 1.4, 1.5875].map((w) => ({
        widthMm: w,
        depthMm: maxDepthForGrooveWidthMm(tool, w),
      })),
      fullDepthGrooveWidthMm: minGrooveWidthMm(tool, maxDepth),
    },
  };
}

function main() {
  const outputDir = process.argv[2] || join(import.meta.dirname, "out");
  mkdirSync(outputDir, { recursive: true });
  const result = analyse();
  const { relief, depth, maxDepth, insideMask, limited, regions, overall, census, geometry } = result;
  const { cols, rows, gridMm } = relief;

  const achievedRgb = hillshade(depth, cols, rows, gridMm, insideMask, maxDepth);
  const flaggedRgb = overlayLimited(achievedRgb, limited, cols, rows);
  const pair = tile([achievedRgb, flaggedRgb], cols, rows);
  writeFileSync(join(outputDir, "metal-preview-and-tool-limit.png"), encodePng(pair.width, pair.height, pair.buffer));

  const toCell = (x, y) => [relief.colOf(x), relief.rowOf(y)];
  const zooms = [
    { id: "corn-left", box: [...toCell(20.0, 56.0), ...toCell(33.0, 82.0)] },
    { id: "lettering", box: [...toCell(28.0, 83.0), ...toCell(66.0, 103.0)] },
    { id: "rope-scroll", box: [...toCell(86.0, 64.0), ...toCell(110.0, 90.0)] },
  ];
  const zoomRows = [];
  for (const zoom of zooms) {
    const [a0, b0, a1, b1] = zoom.box;
    // Hillshade flips Y, so convert machine rows to image rows before cropping.
    const box = [
      Math.min(a0, a1),
      Math.min(rows - 1 - b0, rows - 1 - b1),
      Math.max(a0, a1),
      Math.max(rows - 1 - b0, rows - 1 - b1),
    ];
    const scale = Math.max(1, Math.round(760 / (box[2] - box[0])));
    const left = crop(achievedRgb, cols, box, scale);
    const right = crop(flaggedRgb, cols, box, scale);
    zoomRows.push(tile([left.buffer, right.buffer], left.width, left.height));
  }
  const sheet = stackRows(zoomRows);
  writeFileSync(join(outputDir, "metal-detail-zooms.png"), encodePng(sheet.width, sheet.height, sheet.buffer));

  const report = {
    generatedAt: new Date().toISOString(),
    question: "With the W01015 as the smallest tool allowed on metal, what artwork detail is reachable?",
    measuredOn: "cam/models/rambo-buckle-relief.bin (sweep of the accepted Finish program)",
    tool: geometry,
    maxReliefDepthMm: maxDepth,
    overall,
    regions,
    achievedDepthCensus: census,
    previews: ["metal-preview-and-tool-limit.png", "metal-detail-zooms.png"],
  };
  writeFileSync(join(outputDir, "achievable-detail.json"), `${JSON.stringify(report, null, 2)}\n`);

  const lines = [];
  lines.push("ACHIEVABLE METAL DETAIL -- W01015 as the smallest permitted tool");
  lines.push("");
  lines.push(`measured on        ${report.measuredOn}`);
  lines.push(`tool               ${geometry.tool}`);
  lines.push(`                   ball tip ${geometry.tipDiameterMm} mm dia / ${geometry.tipRadiusMm} mm radius, ${geometry.taperHalfAngleDeg} deg taper`);
  lines.push(`deepest relief     ${maxDepth.toFixed(3)} mm`);
  lines.push("");
  lines.push("HARD GEOMETRIC FLOOR -- no feed, stepover or raster density changes these");
  lines.push("  narrowest groove the tool can cut, by depth:");
  for (const entry of geometry.grooveWidthAtDepth) {
    lines.push(`    ${entry.depthMm.toFixed(2)} mm deep   ->  ${entry.widthMm.toFixed(3)} mm wide`);
  }
  lines.push("  deepest the tool can get into a valley, by width:");
  for (const entry of geometry.depthReachableInGroove) {
    lines.push(`    ${entry.widthMm.toFixed(3)} mm wide  ->  ${entry.depthMm.toFixed(3)} mm deep`);
  }
  lines.push("");
  lines.push("PER-ELEMENT RESULT, measured on the surface the accepted program leaves");
  lines.push("element                        area mm2  recessed   mean    median     p90     max   bottomed");
  const row = (label, s) =>
    [
      label.slice(0, 29).padEnd(30),
      s.areaMm2.toFixed(0).padStart(7),
      s.recessedAreaMm2.toFixed(0).padStart(9),
      s.meanDepthMm.toFixed(3).padStart(7),
      s.medianDepthMm.toFixed(3).padStart(8),
      s.p90DepthMm.toFixed(3).padStart(7),
      s.maxDepthMm.toFixed(3).padStart(7),
      `${(s.bottomedFraction * 100).toFixed(0)}%`.padStart(9),
    ].join(" ");
  for (const region of regions) lines.push(row(region.label, region));
  lines.push(row("WHOLE PART", overall));
  lines.push("");
  lines.push("  'bottomed' = share of that element's recessed area where the finished floor");
  lines.push("  is an arc of the tool's own 0.794 mm tip radius, i.e. the tool set the floor,");
  lines.push("  not the artwork. Those features cannot be made deeper or sharper with this tool.");
  lines.push("");
  lines.push(`ACHIEVED DEPTH CENSUS of recessed artwork (${result.recessedCells} cells)`);
  for (const entry of census) {
    const share = (entry.cells / result.recessedCells) * 100;
    lines.push(
      `  ${entry.lowerMm.toFixed(2)}-${entry.upperMm.toFixed(2)} mm deep  ${entry.areaMm2.toFixed(0).padStart(6)} mm2  ${share.toFixed(1).padStart(5)}%  needs a ${entry.grooveWidthNeededMm.toFixed(3)} mm wide valley`,
    );
  }
  lines.push("");
  lines.push(`previews -> ${outputDir}`);
  lines.push("");
  process.stdout.write(lines.join("\n"));
}

if (process.argv[1] && process.argv[1].endsWith("analyse-detail.mjs")) main();
