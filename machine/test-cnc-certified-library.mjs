import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";
import { gunzipSync } from "node:zlib";

const require = createRequire(import.meta.url);
const { LIBRARY_ID, ORDER, MANIFEST, auditProgram, loadCertifiedLibrary } = require("../api/cnc-certified-library.cjs");

test("certified Rambo buckle library contains all five immutable stages", () => {
  const library = loadCertifiedLibrary(LIBRARY_ID);
  assert.deepEqual(ORDER, ["rough", "cleanup", "finish", "profile", "release"]);
  assert.deepEqual(library.manifest.order, ORDER);
  assert.equal(library.manifest.material, "C752 nickel silver");
  assert.deepEqual(library.manifest.design, { widthMm: 114, heightMm: 88, offsetXMm: 8, offsetYMm: 21, reliefDepthMm: 0.8 });
  for (const stage of ORDER) {
    const meta = MANIFEST.stages[stage], program = library.programs[stage];
    const raw = gunzipSync(Buffer.from(program.gzipBase64, "base64"));
    assert.equal(raw.length, meta.bytes, stage + " byte count");
    assert.equal(createHash("sha256").update(raw).digest("hex"), meta.sha256, stage + " SHA-256");
    assert.equal(program.certificate.sourceHash, meta.sha256);
    assert.equal(program.certificate.provider, "kiri-moto");
    assert.equal(program.certificate.certification, "verified");
    assert.match(program.certificate.auditHash, /^[a-f0-9]{64}$/);
    assert.equal(program.metrics.lines, meta.lines);
    assert.equal(program.metrics.rapidBelowSurface, 0);
    assert.equal(program.metrics.finalRetractMm, 4.99);
  }
});

test("certified library audit fails closed on motion or controller-command changes", () => {
  const library = loadCertifiedLibrary(LIBRARY_ID);
  const raw = gunzipSync(Buffer.from(library.programs.release.gzipBase64, "base64")).toString("utf8");
  assert.throws(() => auditProgram(raw.replace("G0 Z4.9900 F300", "G0 Z-0.0100 F300"), "release", MANIFEST.stages.release), /rapid move at or below/);
  assert.throws(() => auditProgram(raw.replace("M30", "G92 X0\nM30"), "release", MANIFEST.stages.release), /forbidden controller/);
});
