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
test("audit hold is limited to G-code Start and does not gate manual setup",()=>{
 const daemon=readFileSync(new URL("./cnc-daemon.mjs",import.meta.url),"utf8");
 const start=daemon.indexOf("const startProgram =");const end=daemon.indexOf("const resumeSavedProgram =",start);
 assert.match(daemon.slice(start,end),/programHolds.programAuditHold/);
 assert.equal((daemon.match(/programHolds.programAuditHold/g)||[]).length,1);
});
