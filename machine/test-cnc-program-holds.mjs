import test from "node:test";
import assert from "node:assert/strict";
import holds from "../api/cnc-program-holds.cjs";
import library from "../api/cnc-certified-library.cjs";
import { readFileSync } from "node:fs";
test("all incident stage hashes stay stopped independently of stale certification labels",()=>{
 for(const meta of Object.values(library.MANIFEST.stages))assert.match(holds.programAuditHold({camSourceHash:meta.sha256}),/1.1 mm/);
 assert(holds.programAuditHold({certifiedLibraryId:library.LIBRARY_ID}));
 assert.equal(holds.programAuditHold({camSourceHash:"a".repeat(64)}),"");
});
test("audit hold gates G-code execution and the resume offer, but not manual setup",()=>{
 const daemon=readFileSync(new URL("./cnc-daemon.mjs",import.meta.url),"utf8");
 // Exactly two places may consult the hold: starting a program, and deciding
 // whether a saved checkpoint may be OFFERED for resume. A held program must not
 // be advertised as resumable either, or the UI presents a path straight back
 // into the audited cut. Everything else -- jog, probe, zeroing, recovery --
 // must stay ungated so manual setup keeps working during an audit.
 const snapshot=daemon.indexOf("const resumeSnapshot =");
 const snapshotEnd=daemon.indexOf("const health = ()",snapshot);
 const start=daemon.indexOf("const startProgram =");
 const startEnd=daemon.indexOf("const resumeSavedProgram =",start);
 assert.ok(snapshot>-1&&snapshotEnd>snapshot,"resumeSnapshot must exist");
 assert.ok(start>-1&&startEnd>start,"startProgram must exist");
 assert.ok(snapshotEnd<start,"resumeSnapshot is expected before startProgram");
 assert.match(daemon.slice(start,startEnd),/programHolds.programAuditHold/);
 assert.match(daemon.slice(snapshot,snapshotEnd),/programHolds.programAuditHold/);
 const elsewhere=daemon.slice(0,snapshot)+daemon.slice(snapshotEnd,start)+daemon.slice(startEnd);
 assert.doesNotMatch(elsewhere,/programHolds.programAuditHold/);
});
