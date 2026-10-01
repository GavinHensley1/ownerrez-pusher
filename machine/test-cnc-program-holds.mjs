import test from "node:test";
import assert from "node:assert/strict";
import holds from "../api/cnc-program-holds.cjs";
import plateContract from "../api/cnc-plate-contract.cjs";
import library from "../api/cnc-certified-library.cjs";
import { readFileSync } from "node:fs";

const PLATE_MM = 14.19;
const METAL = { material: "C752 nickel silver", camSourceHash: "a".repeat(64) };
const WOOD = { material: "hard maple", camSourceHash: "b".repeat(64) };

// A machine snapshot in which the Z reference IS proven, from which each test
// removes exactly one condition. Shaped like the daemon's /health payload.
const proven = (over = {}) => ({
  plate: { thicknessMm: PLATE_MM, confirmed: true },
  setup: { probeLocked: true, probeThickness: PLATE_MM },
  surfaceProof: { ready: true, reason: "", proof: { method: "conductive-stock-touch", plateThicknessMm: PLATE_MM } },
  ...over,
});

test("a proven Z reference RELEASES the cut for both metal and wood", () => {
  // This is the regression that matters most: before 2026-10-01 the hold was an
  // unconditional hash/library blocklist, so Start could never succeed for the
  // only metal job in the system no matter what the operator did.
  assert.equal(holds.programAuditHold(METAL, proven()), "");
  assert.equal(holds.programAuditHold(WOOD, proven()), "");
  // Being one of the five audited Rambo-buckle programs is no longer, by itself,
  // a reason to hold. The programs were audited line-by-line and were not the
  // fault; the Z reference was.
  for (const meta of Object.values(library.MANIFEST.stages)) {
    assert.equal(holds.programAuditHold({ camSourceHash: meta.sha256, material: "C752 nickel silver" }, proven()), "");
  }
  assert.equal(holds.programAuditHold({ certifiedLibraryId: library.LIBRARY_ID }, proven()), "");
});

test("no machine evidence at all HOLDS, rather than reading as consent", () => {
  for (const absent of [undefined, null, "", 0, "ready"]) {
    const reason = holds.programAuditHold(METAL, absent);
    assert.match(reason, /held/i, `evidence ${JSON.stringify(absent)} must hold`);
    assert.match(reason, /bridge/i);
  }
});

test("an unconfirmed or unreadable plate thickness HOLDS", () => {
  assert.match(holds.programAuditHold(METAL, proven({ plate: { thicknessMm: PLATE_MM, confirmed: false } })), /confirm the measured thickness/i);
  assert.match(holds.programAuditHold(METAL, proven({ plate: null })), /confirm the measured thickness/i);
  assert.match(holds.programAuditHold(METAL, proven({ plate: { confirmed: true } })), /unreadable/i);
});

test("an unlocked Z calibration HOLDS and names the configured plate", () => {
  const reason = holds.programAuditHold(METAL, proven({ setup: { probeLocked: false, probeThickness: PLATE_MM } }));
  assert.match(reason, /probed and locked/i);
  assert.match(reason, /14\.19 mm/);
});

test("THE 2026-09-30 CONDITION: calibration captured at a different plate thickness HOLDS", () => {
  // The exact incident. The locked calibration was taken believing the plate was
  // 20 mm; the plate is ~14.19 mm. Measured stock thickness still looked right
  // because the error cancels out of bed-minus-stock, so every other gate stayed
  // green. This must hold, and must state both numbers.
  const reason = holds.programAuditHold(METAL, proven({ setup: { probeLocked: true, probeThickness: 20 } }));
  assert.match(reason, /20\.00 mm/);
  assert.match(reason, /14\.19 mm/);
  assert.match(reason, /Re-probe/i);

  // A calibration with no recorded thickness is a mismatch, not a pass.
  assert.match(holds.programAuditHold(METAL, proven({ setup: { probeLocked: true } })), /unrecorded thickness/i);

  // And a difference far below the typing resolution is the same plate.
  assert.equal(holds.programAuditHold(METAL, proven({ setup: { probeLocked: true, probeThickness: PLATE_MM + 0.004 } })), "");
  // While the real 14.00 vs 14.19 variant difference is NOT tolerated.
  assert.match(holds.programAuditHold(METAL, proven({ setup: { probeLocked: true, probeThickness: 14.0 } })), /14\.00 mm/);
});

test("a missing or unready surface-contact proof HOLDS and surfaces its reason", () => {
  assert.match(holds.programAuditHold(METAL, proven({ surfaceProof: null })), /surface-contact proof/i);
  const reason = holds.programAuditHold(METAL, proven({ surfaceProof: { ready: false, reason: "Plate is still under the bit." } }));
  assert.match(reason, /proven independently of the plate/i);
  assert.match(reason, /Plate is still under the bit\./);
});

test("a proof taken at a different plate thickness than configured HOLDS", () => {
  const stale = proven({ surfaceProof: { ready: true, proof: { method: "conductive-stock-touch", plateThicknessMm: 20 } } });
  const reason = holds.programAuditHold(METAL, stale);
  assert.match(reason, /20\.00 mm/);
  assert.match(reason, /14\.19 mm/);
});

test("metal demands a measured conductive touch, wood accepts an attestation", () => {
  const attested = proven({ surfaceProof: { ready: true, proof: { method: "operator-attested-feeler", plateThicknessMm: PLATE_MM } } });
  assert.match(holds.programAuditHold(METAL, attested), /measured surface-contact touch/i);
  assert.equal(holds.programAuditHold(WOOD, attested), "");
  // metalMode alone is not the metal test here; the material string is.
  assert.equal(holds.programAuditHold({ material: "C752 Nickel Silver sheet" }, attested) === "", false);
});

test("the hold never names the retired 1.1 mm incident as a live reason", () => {
  // The old reason string froze a one-off measurement into permanent UI copy.
  const reasons = [
    holds.programAuditHold(METAL, null),
    holds.programAuditHold(METAL, proven({ plate: { thicknessMm: PLATE_MM, confirmed: false } })),
    holds.programAuditHold(METAL, proven({ setup: { probeLocked: true, probeThickness: 20 } })),
  ];
  for (const reason of reasons) {
    assert.doesNotMatch(reason, /1\.1 mm/);
    assert.doesNotMatch(reason, /under depth\/engagement audit/i);
  }
});

test("the plate contract is the single source of truth across CJS and ESM", async () => {
  const esm = await import("./cnc-plate-config.mjs");
  assert.equal(esm.PLATE_THICKNESS_DEFAULT_MM, plateContract.PLATE_THICKNESS_DEFAULT_MM);
  assert.equal(esm.PLATE_THICKNESS_MIN_MM, plateContract.PLATE_THICKNESS_MIN_MM);
  assert.equal(esm.PLATE_THICKNESS_MAX_MM, plateContract.PLATE_THICKNESS_MAX_MM);
  assert.equal(esm.PLATE_THICKNESS_MATCH_TOLERANCE_MM, plateContract.PLATE_THICKNESS_MATCH_TOLERANCE_MM);
  // api/app.js must not re-declare the numbers as literals.
  const api = readFileSync(new URL("../api/app.js", import.meta.url), "utf8");
  assert.match(api, /require\("\.\/cnc-plate-contract\.cjs"\)/);
  assert.doesNotMatch(api, /PROBE_PUCK_DEFAULT_MM\s*=\s*14\.19/);
});

test("audit hold gates G-code execution and the resume offer, but not manual setup", () => {
  const daemon = readFileSync(new URL("./cnc-daemon.mjs", import.meta.url), "utf8");
  // Exactly two places may consult the hold: starting a program, and deciding
  // whether a saved checkpoint may be OFFERED for resume. A held program must not
  // be advertised as resumable either, or the UI presents a path straight back
  // into the audited cut. Everything else -- jog, probe, zeroing, recovery --
  // must stay ungated so manual setup keeps working during a hold.
  const snapshot = daemon.indexOf("const resumeSnapshot =");
  const snapshotEnd = daemon.indexOf("const health = ()", snapshot);
  const start = daemon.indexOf("const startProgram =");
  const startEnd = daemon.indexOf("const resumeSavedProgram =", start);
  assert.ok(snapshot > -1 && snapshotEnd > snapshot, "resumeSnapshot must exist");
  assert.ok(start > -1 && startEnd > start, "startProgram must exist");
  assert.ok(snapshotEnd < start, "resumeSnapshot is expected before startProgram");
  assert.match(daemon.slice(start, startEnd), /programHolds\.programAuditHold/);
  assert.match(daemon.slice(snapshot, snapshotEnd), /programHolds\.programAuditHold/);
  const elsewhere = daemon.slice(0, snapshot) + daemon.slice(snapshotEnd, start) + daemon.slice(startEnd);
  assert.doesNotMatch(elsewhere, /programHolds\.programAuditHold/);
});

test("both daemon hold call sites pass live plate, calibration and proof evidence", () => {
  const daemon = readFileSync(new URL("./cnc-daemon.mjs", import.meta.url), "utf8");
  // A call that forgets the evidence argument fails closed, which would silently
  // make the hold permanent again -- the exact failure being retired here.
  for (const site of ["const resumeSnapshot =", "const startProgram ="]) {
    const from = daemon.indexOf(site);
    const call = daemon.indexOf("programHolds.programAuditHold", from);
    const region = daemon.slice(call, call + 420);
    assert.match(region, /plate: plateSnapshot\(\)/, `${site} must pass the live plate`);
    assert.match(region, /setup/, `${site} must pass the live calibration`);
    assert.match(region, /surfaceProof: surfaceProofSnapshot\(\)/, `${site} must pass the live proof`);
  }
});

test("the Vercel API keeps the 409 and evaluates the hold against the bridge snapshot", () => {
  const api = readFileSync(new URL("../api/app.js", import.meta.url), "utf8");
  assert.match(api, /programAuditHold\(job,health\)/);
  assert.match(api, /if\(auditHold\)return res\.status\(409\)/);
  // The jobs-list hold must be computed after st.agent is loaded, otherwise every
  // job reports "no bridge evidence" regardless of the real machine state.
  const agentAssigned = api.indexOf("st.agent=cncAgent||null;");
  const listHold = api.indexOf("entry.cutAuditHold=programAuditHold(entry,holdHealth)");
  assert.ok(agentAssigned > -1 && listHold > agentAssigned, "list hold must be computed after the bridge snapshot loads");
});

// THE DISTINCTION THE FILE DOCUMENTS AT LENGTH BUT NOTHING ASSERTED.
// Every test above checks the hold's reason STRING. None checked
// requiresFreshSetup, so inverting that single boolean kept the whole suite
// green while sending the operator back to re-probe the bed and stock when all
// he actually needed was one click on Verify surface contact. That is precisely
// how a correct gate turns into the dead end this file warns about.
test("a proof-only hold asks for ONE action; a wrong Z reference demands a fresh setup", () => {
  const detail = (machine) => holds.programAuditHoldDetail(WOOD, machine);

  // Reference is sound, only the physical proof is outstanding -> one action.
  for (const proofState of [
    { ready: false, reason: "Plate is still under the bit." },
    { ready: true, proof: { method: "conductive-stock-touch", plateThicknessMm: 20 } }, // proof predates the plate correction
  ]) {
    const verdict = detail(proven({ surfaceProof: proofState }));
    assert.notEqual(verdict.reason, "", `${JSON.stringify(proofState)} must hold`);
    assert.equal(verdict.requiresFreshSetup, false, `${JSON.stringify(proofState)} must NOT demand a re-probe`);
  }

  // The Z reference itself is wrong or unknown -> nothing is recoverable without
  // probing the bed and stock again.
  for (const over of [
    { plate: { thicknessMm: PLATE_MM, confirmed: false } },
    { plate: { confirmed: true } },                                        // unreadable thickness
    { setup: { probeLocked: false, probeThickness: PLATE_MM } },
    { setup: { probeLocked: true, probeThickness: 20 } },                  // the 2026-09-30 condition
    { surfaceProof: null },                                                // bridge reported nothing
  ]) {
    const verdict = detail(proven(over));
    assert.notEqual(verdict.reason, "", `${JSON.stringify(over)} must hold`);
    assert.equal(verdict.requiresFreshSetup, true, `${JSON.stringify(over)} must demand a fresh setup`);
  }

  // A released cut is never a fresh-setup condition.
  assert.deepEqual(detail(proven()), { reason: "", requiresFreshSetup: false });
});

// GAVIN'S ACTUAL NEXT RUN, end to end: the WOOD buckle, zeroed by touching the
// bare bit to the wood so the puck cannot set the wedding piece's surface zero.
// setStockZZero requires a locked calibration (for stock thickness) and then
// redefines absolute Z from the bare-bit position, and it deliberately CLEARS
// the surface proof because it replaced the reference that proof corroborated.
// The sequence must therefore end released, and must never report that the
// touch-off invalidated the setup.
test("the wood bare-bit touch-off sequence is genuinely runnable", () => {
  // 1. Probed and locked against the confirmed plate, proof in force.
  assert.equal(holds.programAuditHold(WOOD, proven()), "");

  // 2. Bare-bit touch-off. probeLocked and probeThickness survive; the proof is
  //    cleared, so the daemon publishes a snapshot with ready:false (NOT null —
  //    both daemon call sites pass surfaceProofSnapshot(), which always returns
  //    an object; passing the raw cleared value would wrongly read as "the
  //    bridge reported nothing" and demand a teardown).
  const afterTouchOff = proven({
    setup: { probeLocked: true, probeThickness: PLATE_MM, probeLockStatus: "locked_touch_off" },
    surfaceProof: { ready: false, reason: "Surface-contact proof is missing.", proof: null },
  });
  const held = holds.programAuditHoldDetail(WOOD, afterTouchOff);
  assert.match(held.reason, /proven independently of the plate/i);
  assert.equal(held.requiresFreshSetup, false, "a touch-off must not send the operator back to re-probe");

  // 3. Re-verify surface contact. Wood accepts the operator attestation; metal
  //    at the same state still demands the measured conductive touch.
  const attested = proven({ surfaceProof: { ready: true, proof: { method: "operator-attested-feeler", plateThicknessMm: PLATE_MM } } });
  assert.equal(holds.programAuditHold(WOOD, attested), "", "wood must release on an attested proof");
  assert.match(holds.programAuditHold(METAL, attested), /conductive/i, "metal must still demand the measured touch");
});
