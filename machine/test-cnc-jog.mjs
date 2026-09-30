import assert from "node:assert/strict";
import test from "node:test";
import { splitJogDistance, runJogSegments } from "./cnc-jog.mjs";

test("splits large XY jogs into guarded 5 mm segments", () => {
  assert.deepEqual(splitJogDistance("X", 100), Array(20).fill(5));
  assert.deepEqual(splitJogDistance("Y", -25), [-5, -5, -5, -5, -5]);
});

test("splits large Z jogs into guarded 5 mm segments", () => {
  assert.deepEqual(splitJogDistance("Z", 100), Array(20).fill(5));
  assert.deepEqual(splitJogDistance("Z", -12.5), [-5, -5, -2.5]);
});

test("rejects invalid or over-100 mm jog requests", () => {
  assert.throws(() => splitJogDistance("A", 10), /axis/);
  assert.throws(() => splitJogDistance("X", 0), /non-zero/);
  assert.throws(() => splitJogDistance("Z", 100.1), /100 mm/);
});

test("full requested distance is executed, but Stop discards the remaining segments", async () => {
 const moves=[];
 const result=await runJogSegments("Y",-50,{move:async d=>{moves.push(d);return {ok:true};}});
 assert.equal(moves.reduce((a,b)=>a+b,0),-50);assert.equal(result.completedSegments,10);
 let cancelled=false;const partial=[];
 await assert.rejects(runJogSegments("Z",25,{cancelled:()=>cancelled,move:async d=>{partial.push(d);cancelled=true;}}),/cancelled/);
 assert.deepEqual(partial,[5]);
});
test("segment failure does not send the rest of a manual move", async()=>{
 let count=0;await assert.rejects(runJogSegments("X",100,{move:async()=>{count++;throw Error("limit alarm");}}),/limit alarm/);assert.equal(count,1);
});
