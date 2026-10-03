// Walks the REAL operator Start gate offline, with the camera absent.
//
// Gavin's acceptance test (2026-10-01): with the controller powered on and the
// S350 camera entirely off the network, pressing Start runs the job. These tests
// drive the actual cncRenderAgent gate from index.html against simulated daemon
// payloads, so "Start is enabled" is proven rather than asserted by grep.
//
// They also pin the two things that must NOT change:
//   - no health field named "camera" participates in the gate, and
//   - every setup gate still has to be green before Start enables.
import assert from "node:assert/strict";
import test from "node:test";
import { loadBrowserScript } from "./cnc-browser-harness.mjs";

const indexPath = new URL("../index.html", import.meta.url).pathname;

// Deliberately NOT metal and NOT the held library, so this measures the setup
// gate itself. The audit hold and the metal-only measured-proof rule are
// covered separately below and in test-cnc-program-holds.mjs.
const readyJob = {
  id: "start-gate-test",
  sizeMM: 114,
  pieceH: 88,
  material: "Hard maple",
  reliefDepth: 0.8,
  originOffsetXMm: 8,
  originOffsetYMm: 21,
  hasGcode: true,
  hasCreative: false,
  agentState: "idle",
  cutAuditHold: "",
};

const config = { machX: 300, machY: 200, machZ: 40, machMargin: 5 };

// A daemon payload with every gate satisfied. No camera key anywhere.
const readyHealth = () => ({
  ok: true,
  connected: true,
  reconnecting: false,
  moving: false,
  frameValid: true,
  frameIncident: null,
  frameRecovery: { active: false, message: "" },
  // Z sits 2.5 mm above the probed stock surface: cncStartFrameCheck requires at
  // least 2.400 mm of work-Z clearance, so a bit resting ON the stock correctly
  // refuses to start. Retracting Z is a real operator step before Start.
  lastControllerStatus: { state: "Idle", raw: "<Idle|MPos:-92.000,-145.000,-12.359,0.000|FS:0,0>", MPos: "-92.000,-145.000,-12.359,0.000", FS: "0,0" },
  workspace: { calibrated: true, bounds: { X: { min: -92, max: 208 }, Y: { min: -145, max: 55 }, Z: { min: -17.973, max: null } } },
  setup: {
    xyReady: true, xyLockStatus: "locked",
    bedProbeReady: true, stockProbeReady: true, probeReady: true,
    probeLocked: true, probeLockStatus: "locked",
    probeThickness: 14.19,
    bedSurfaceMPos: -18.773, stockSurfaceMPos: -14.859,
    stockThicknessMm: 3.914, safetyFloorMm: 0.8, maxCutDepthMm: 3.114,
    materialReady: true, savedStockThicknessMm: 3.914, savedSafetyFloorMm: 0.8,
    xyOriginMPos: { X: -92, Y: -145 }, zOriginMPos: -14.859,
    probePhase: "idle",
  },
  plate: { thicknessMm: 14.19, confirmed: true, minMm: 5, maxMm: 30, source: "Operator measured" },
  surfaceProof: { ready: true, reason: "", toleranceMm: 0.08, proof: { method: "conductive-stock-touch", verified: true, deltaMm: 0.004, plateThicknessMm: 14.19 } },
  xyRecovery: { available: false },
  probeRecovery: { available: false },
  job: { state: "idle", jobId: null, progress: 0 },
  resume: null,
});

const gate = (mutate = () => {}, job = { ...readyJob }) => {
  const harness = loadBrowserScript(indexPath);
  const health = readyHealth();
  mutate(health, job);
  const els = harness.renderAgent(job, health, config);
  return { ...els, readinessHtml: String(els.readiness.innerHTML || "") };
};

const redChecks = (html) => (html.match(/×\s*([^<]+)</g) || []).map((m) => m.replace(/×\s*/, "").replace(/<$/, "").trim());

test("Start is ENABLED with every gate green and no camera on the network", () => {
  const g = gate();
  assert.deepEqual(redChecks(g.readinessHtml), [], `unexpected red gates: ${g.readinessHtml}`);
  assert.equal(g.start.disabled, false, "Start must be enabled once setup is complete");
});

test("the gate reads no camera state at all, so camera absence cannot block Start", () => {
  // Removing every camera-shaped field, and adding a hostile one, must not move
  // the gate. This is the regression guard for re-introducing a camera interlock.
  const withCamera = gate((h) => {
    h.camera = { state: "offline", monitoring: false, lastFrameAt: null, frameAgeMs: null, fresh: false };
    h.cameraFresh = false;
  });
  assert.equal(withCamera.start.disabled, false, "an offline camera must not disable Start");

  const source = loadBrowserScript(indexPath);
  assert.ok(source, "harness loads");
  // The readiness list itself must not contain a camera gate.
  assert.doesNotMatch(withCamera.readinessHtml, /camera/i);
});

test("each setup gate independently keeps Start disabled", () => {
  const cases = [
    ["X/Y stock zero", (h) => { h.setup.xyReady = false; }],
    ["Bed probe", (h) => { h.setup.bedProbeReady = false; }],
    ["Stock probe", (h) => { h.setup.stockProbeReady = false; }],
    ["Probe lock", (h) => { h.setup.probeLocked = false; }],
    ["Surface contact proof", (h) => { h.surfaceProof.ready = false; }],
    ["Machine boundaries", (h) => { h.workspace.calibrated = false; }],
    ["Coordinate frame", (h) => { h.frameValid = false; }],
  ];
  for (const [label, mutate] of cases) {
    const g = gate(mutate);
    assert.equal(g.start.disabled, true, `${label} must gate Start`);
    assert.ok(redChecks(g.readinessHtml).includes(label), `${label} must be shown red, got ${redChecks(g.readinessHtml)}`);
  }
});

test("an unconfirmed plate thickness keeps Start disabled even when the proof says ready", () => {
  // The 2026-09-30 over-depth cut happened with every derived number agreeing.
  // The plate figure is the one input that cannot be validated from the others.
  const g = gate((h) => { h.plate.confirmed = false; });
  assert.equal(g.start.disabled, true);
  assert.ok(redChecks(g.readinessHtml).includes("Surface contact proof"));
});

test("metal requires the MEASURED surface proof; an operator attestation is not enough", () => {
  const metal = { ...readyJob, material: "C752 nickel silver" };
  const attested = gate((h) => { h.surfaceProof.proof.method = "operator-attested-feeler"; }, metal);
  assert.equal(attested.start.disabled, true, "metal must refuse an attested-only proof");

  const measured = gate(() => {}, metal);
  assert.equal(measured.start.disabled, false, "metal with a measured touch may start");
});

test("the cut audit hold disables Start on its own, with every other gate green", () => {
  const held = gate(() => {}, { ...readyJob, cutAuditHold: "This five-stage job is under depth/engagement audit after the measured 1.1 mm cut." });
  assert.deepEqual(redChecks(held.readinessHtml), [], "the hold is separate from readiness");
  assert.equal(held.start.disabled, true, "an audit hold must block Start");
  assert.match(String(held.auditHold.textContent || ""), /audit/i);
});

test("a latched frame incident blocks Start but an active recovery still allows setup", () => {
  const latched = gate((h) => {
    h.frameValid = false;
    h.frameIncident = { latched: true, reason: "SAVED_COORDINATE_CONTINUITY_UNVERIFIED" };
    h.frameRecovery = { active: true, message: "Saved X/Y cannot yet be verified." };
    h.setup.xyReady = false;
    h.setup.probeLocked = false;
  });
  assert.equal(latched.start.disabled, true, "cutting stays blocked while the frame is unverified");
  // The dead-end regression: recovery being active must not itself be treated as
  // a blanket motion block, otherwise the operator can never clear the latch.
  assert.ok(redChecks(latched.readinessHtml).includes("Coordinate frame"));
});

test("the ruined program offers no resume", () => {
  const g = gate((h) => {
    h.resume = { state: "interrupted", jobId: "cnc_mun692ol2mq", lastCompletedLine: 1676, resumable: false, blockedReason: "This interrupted checkpoint cannot be resumed." };
  });
  assert.equal(g.resume.disabled, true, "a non-resumable checkpoint must not offer Resume");
  assert.equal(g.start.textContent, "▶ Start carve", "Start must not advertise a resume");
});

// ---------------------------------------------------------------------------
// Blank-thickness hold (cam-v3 / rambo-buckle-c752-v2).
//
// The v2 Profile and Release programs cut through the sheet to 3.955 mm, derived
// from 3.855 mm probed on the PREVIOUS damaged blank. The certificate records
// stock.thicknessMeasuredOnThisBlank: false, and the API publishes a hold for
// the loaded stage computed from the certified through-depth and the thickness
// probed on the blank that is actually in the machine. These prove the hold
// reaches the Start button, and that it does so WITHOUT re-introducing a camera
// gate — Gavin's acceptance test still has to hold for the four-stage job.
// ---------------------------------------------------------------------------

const v2MetalJob = (over = {}) => ({
  ...readyJob,
  material: "C752 nickel silver",
  metalMode: "raised-surface",
  certifiedLibraryId: "rambo-buckle-c752-v2",
  certifiedStockThicknessMm: "3.855",
  certifiedStockMeasuredOnThisBlank: "false",
  profileDepthMm: "3.955",
  activeStage: "profile",
  camStage: "profile",
  stockThicknessHold: "",
  ...over,
});

test("the blank-thickness hold disables Start on its own, with every other gate green", () => {
  const hold = "The profile stage cuts to 3.955 mm but this blank probed 3.700 mm — this blank is thinner than the programs assume.";
  const held = gate(() => {}, v2MetalJob({ stockThicknessHold: hold }));
  assert.deepEqual(redChecks(held.readinessHtml), [], "the hold is separate from readiness");
  assert.equal(held.start.disabled, true, "a mismatched blank thickness must block Start");
  assert.match(String(held.thicknessHold.textContent || ""), /Blank thickness/);
  assert.match(String(held.thicknessHold.textContent || ""), /3\.700 mm/);
  assert.equal(held.thicknessHold.style.display, "");
  // The reason is on the button too, so a disabled Start is never unexplained.
  assert.match(String(held.start.title || ""), /3\.955 mm/);
});

test("clearing the blank-thickness hold re-enables Start, camera still absent", () => {
  const ok = gate((h) => {
    // A blank that agrees with the certified through-depth.
    h.setup.stockThicknessMm = 3.855;
    h.camera = { state: "offline", fresh: false };
  }, v2MetalJob({ stockThicknessHold: "" }));
  assert.deepEqual(redChecks(ok.readinessHtml), [], `unexpected red gates: ${ok.readinessHtml}`);
  assert.equal(ok.start.disabled, false, "an agreeing blank must not block Start");
  assert.equal(ok.thicknessHold.style.display, "none");
  assert.doesNotMatch(ok.readinessHtml, /camera/i);
});

test("the blank-thickness hold is independent of the audit hold", () => {
  // Either one alone blocks; neither masks the other's message.
  const both = gate(() => {}, v2MetalJob({
    cutAuditHold: "Cutting is held until you confirm the measured thickness of the Z-probe plate.",
    stockThicknessHold: "The release stage cuts to 3.955 mm but this blank probed 4.100 mm.",
  }));
  assert.equal(both.start.disabled, true);
  assert.match(String(both.auditHold.textContent || ""), /Z-probe plate/);
  assert.match(String(both.thicknessHold.textContent || ""), /4\.100 mm/);
});
