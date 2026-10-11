// A wood proof reuses certified source bytes; placement is a separate G55 frame.
// G54 remains the operator's stock-corner frame. No CAM regeneration or scaling.
const { createHash } = require('crypto');
const cam = require('./cnc-certified-library.cjs');
const LIBRARY_ID = 'rambo-buckle-c752-v2';
const STAGES = ['rough', 'finish'];
// Finish uses the full 1/4-inch shank radius as a conservative XY envelope,
// rather than pretending the tapered cutter is only its 1/32-inch tip radius.
const TOOL_RADII = { rough: 1.5875, finish: 3.175 };
const number = (value, name) => {
  if (value === null || value === undefined || value === '' || !Number.isFinite(Number(value))) throw Error(`Wood proof ${name} is required`);
  return Number(value);
};
const rounded = value => Number(value.toFixed(4));
function sourceEnvelope() {
  const stages = cam.LIBRARIES[LIBRARY_ID].stages;
  return { minX: Math.min(...STAGES.map(s => stages[s].bounds.minX - TOOL_RADII[s])),
    maxX: Math.max(...STAGES.map(s => stages[s].bounds.maxX + TOOL_RADII[s])),
    minY: Math.min(...STAGES.map(s => stages[s].bounds.minY - TOOL_RADII[s])),
    maxY: Math.max(...STAGES.map(s => stages[s].bounds.maxY + TOOL_RADII[s])) };
}
function placement(input = {}) {
  const width = number(input.stockWidthMm, 'stock X'), height = number(input.stockHeightMm, 'stock Y');
  const reserve = number(input.stockReserveMm, 'edge reserve'), left = number(input.leftInsetMm, 'left inset'), front = number(input.frontInsetMm, 'front inset');
  if (!(width > 0 && height > 0 && width <= 400 && height <= 400 && reserve >= 0 && left >= 0 && front >= 0)) throw Error('Wood proof dimensions/insets are outside the supported stock envelope');
  const raw = sourceEnvelope(), x = rounded(left - raw.minX), y = rounded(front - raw.minY);
  const bounds = { minX: rounded(raw.minX + x), maxX: rounded(raw.maxX + x), minY: rounded(raw.minY + y), maxY: rounded(raw.maxY + y) };
  if (bounds.maxX > width - reserve + 0.001 || bounds.maxY > height - reserve + 0.001) throw Error(`Wood proof including the cutter needs ${(raw.maxX - raw.minX).toFixed(2)} × ${(raw.maxY - raw.minY).toFixed(2)} mm plus the chosen insets/reserve; it does not fit this ${width} × ${height} mm board`);
  return { version: 1, sourceLibraryId: LIBRARY_ID, stockWidthMm: width, stockHeightMm: height, stockReserveMm: reserve,
    leftInsetMm: left, frontInsetMm: front, offsetXMm: x, offsetYMm: y, bounds };
}
function validatePlacement(proof, stock = {}) {
  if (!proof || proof.version !== 1 || proof.sourceLibraryId !== LIBRARY_ID) throw Error('Wood proof placement is missing or unsupported');
  const checked = placement(proof);
  for (const field of ['stockWidthMm', 'stockHeightMm', 'stockReserveMm']) {
    if (Math.abs(number(stock[field], field) - checked[field]) > 0.001) throw Error('Stock dimensions changed. Review and save the wood-proof placement again');
  }
  for (const field of ['offsetXMm', 'offsetYMm']) if (Math.abs(number(proof[field], field) - checked[field]) > 0.0001) throw Error('Wood proof program translation is inconsistent');
  if (!Number.isFinite(Date.parse(proof.configuredAt || ''))) throw Error('Wood proof placement has no confirmation timestamp');
  return { ...checked, configuredAt: proof.configuredAt };
}
function assertStage(stage) { if (!STAGES.includes(stage)) throw Error('Wood proof permits Rough and Finish only; Profile and Release are unavailable'); }
// Translate analysis, not the source program. Bounds are checked in the physical
// stock frame while the unchanged program is streamed in its temporary G55 frame.
function translatedAnalysis(analysis, proof, stage, includeCutter = false) {
  assertStage(stage);
  const radius = includeCutter ? TOOL_RADII[stage] : 0;
  const bounds = { ...analysis.bounds };
  for (const [axis, offset] of [['X', proof.offsetXMm], ['Y', proof.offsetYMm]]) bounds[axis] = {
    min: analysis.bounds[axis].min + offset - radius, max: analysis.bounds[axis].max + offset + radius,
  };
  return { ...analysis, bounds };
}
let verifiedLibrary;
function verifyProgram(gcode, context) {
  const stage = String(context.camStage || context.activeStage || '');
  assertStage(stage);
  if (context.certifiedLibraryId !== LIBRARY_ID || context.manualRouter !== true || (context.operation && context.operation !== stage)) throw Error('Wood proof requires the original v2 manual-router stage contract');
  verifiedLibrary ||= cam.loadCertifiedLibrary(LIBRARY_ID);
  const cert = verifiedLibrary.programs[stage].certificate;
  for (const [field, original] of Object.entries({ camProvider: cert.provider, camCertification: cert.certification, camSourceHash: cert.sourceHash, camAuditHash: cert.auditHash, camTool: cert.tool })) {
    if (context[field] !== original) throw Error(`Wood proof ${field} no longer matches the original certified source`);
  }
  if (createHash('sha256').update(String(gcode)).digest('hex') !== cert.sourceHash) throw Error('Wood proof G-code differs from the exact certified source bytes');
  // These sources are absolute metric and contain no WCS/coordinate mutations.
  // The independent program analyzer also rejects them before any motion.
  if (/(?:^|\s)G(?:5[3-9]|10|28|30|92)(?:\.|\s|$)/m.test(String(gcode))) throw Error('Wood proof source changes its coordinate frame');
  return cert;
}
function assertSurface(proof, woodProof) {
  if (!proof || proof.method !== 'operator-attested-feeler' || proof.verified !== true || !Number.isFinite(Date.parse(proof.at || '')) || Date.parse(proof.at) < Date.parse(woodProof.configuredAt || '')) throw Error('Verify the non-conductive wood surface by feel after choosing/saving this wood-proof placement');
}
function makeJob(source, id, proof, now) {
  if (source.certifiedLibraryId !== LIBRARY_ID || source.woodProof || source.planStatus !== 'approved') throw Error('Choose the loaded corrected v2 metal job before creating its wood proof');
  const certs = JSON.parse(source.camCertificates || '{}'), names = JSON.parse(source.gcodeNames || '{}');
  if (!STAGES.every(s => certs[s] && names[s])) throw Error('The loaded job must contain certified Rough and Finish');
  const rec = { ...source, id, project: `${source.project || "The Rambo's"} · wood proof`, material: 'Wood', metalMode: '',
    woodProof: { ...proof, configuredAt: now }, woodProofSourceJobId: source.id, hasCreative: false, hasDepth: false,
    gcodeStages: JSON.stringify(STAGES), camCertificates: JSON.stringify(Object.fromEntries(STAGES.map(s => [s, certs[s]]))),
    gcodeNames: JSON.stringify(Object.fromEntries(STAGES.map(s => [s, names[s]]))), activeStage: 'rough', camStage: 'rough', gcodeName: names.rough,
    stageCompletions: '{}', progress: 0, status: 'Relief', stageRequiresProbe: source.activeStage === 'rough' ? source.stageRequiresProbe : true,
    stageActivatedAt: source.activeStage === 'rough' ? source.stageActivatedAt : now, resumeInvalidatedAt: now,
    profileMode: 'none', sacrificialBackingConfirmed: 'false', cutAuditHold: '', stockThicknessHold: '', at: now, updatedAt: now };
  const stages = cam.LIBRARIES[LIBRARY_ID].stages;
  rec.planTools = JSON.stringify({ roughBit: certs.rough.tool, finishBit: certs.finish.tool, roughRpm: stages.rough.rpmNominal, finishRpm: stages.finish.rpmNominal, roughGear: stages.rough.gear, finishGear: stages.finish.gear });
  rec.bit = certs.rough.tool;
  rec.cutout = 'none';
  rec.certifiedThicknessSensitiveStages = '[]';
  rec.certifiedOmittedStages = JSON.stringify([{ stage: 'profile', reason: 'Wood proof is relief only; original cutout depth does not describe this board.' }, { stage: 'release', reason: 'No wood cutout or release is authorized by this proof.' }]);
  Object.assign(rec, { camProvider: certs.rough.provider, camCertification: certs.rough.certification, camSourceHash: certs.rough.sourceHash, camAuditHash: certs.rough.auditHash, camTool: certs.rough.tool, camAudit: certs.rough.audit });
  for (const key of Object.keys(rec)) if (/^agent|^startedAt$|^profileCompletedAt$/.test(key)) delete rec[key];
  return rec;
}
module.exports = { LIBRARY_ID, STAGES, TOOL_RADII, sourceEnvelope, placement, validatePlacement, assertStage, translatedAnalysis, verifyProgram, assertSurface, makeJob };
