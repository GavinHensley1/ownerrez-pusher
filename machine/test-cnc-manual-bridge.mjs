import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {runJogSegments} from './cnc-jog.mjs';
const source=readFileSync(new URL('./cnc-cloud-agent.mjs',import.meta.url),'utf8');
const execute=source.slice(source.indexOf('async function execute('),source.indexOf('\nasync function loop('));
function fixture({report=async()=>{},localRequest=async()=>({frameValid:false,frameRecovery:{active:true}})}={}){
 const context=vm.createContext({runJogSegments,report,localRequest,COMMAND_LEDGER_PATH:'unused',agentStartedAtMs:0,claimCommand:()=>({claimed:true}),completeCommand:()=>({}),commandRejectionReason:()=>'',heartbeat:async()=>{},process:{stderr:{write(){}}}});
 vm.runInContext('let activeJog;let activeStart;let stopped=false;'+execute,context);
 return context;
}
test('acceptance-report failure does not strand manual positioning',async()=>{
 let fail=true,moves=0;
 const c=fixture({report:async()=>{if(fail){fail=false;throw Error('cloud unavailable');}},localRequest:async path=>{if(path.startsWith('/jog'))moves++;return {frameValid:false,frameRecovery:{active:true}};}});
 const cmd={id:'j1',action:'jog',axis:'Y',distanceMm:50,feedMmPerMin:100};
 await c.execute(cmd);assert.equal(moves,0);assert.equal(vm.runInContext('activeJog',c),undefined);
 await c.execute({...cmd,id:'j2'});assert.equal(moves,10);
});
test('Stop discards remaining segments and concurrent setup cannot interleave a manual move',async()=>{
 let release,entered;const entry=new Promise(r=>entered=r),blocked=new Promise(r=>release=r);const wire=[],receipts=[];
 const c=fixture({report:async(cmd,state,msg)=>receipts.push({id:cmd.id,state,msg}),localRequest:async path=>{wire.push(path);if(path.startsWith('/jog')){entered();await blocked;}return {frameValid:false,frameRecovery:{active:true}};}});
 const run=c.execute({id:'j',action:'jog',axis:'X',distanceMm:100,feedMmPerMin:100});await entry;
 await c.execute({id:'z',action:'zero_xy'});assert(!wire.includes('/zero/xy'));
 await c.execute({id:'s',action:'stop'});release();await run;
 assert.equal(wire.filter(x=>x.startsWith('/jog')).length,1);assert(wire.includes('/job/stop'));
 assert(receipts.some(x=>x.id==='j'&&/cancelled/.test(x.msg)));assert.equal(vm.runInContext('activeJog',c),undefined);
});
test('API Stop accepts pending or moving manual positioning despite idle program state',()=>{
 const api=readFileSync(new URL('../api/app.js',import.meta.url),'utf8');
 const a=api.indexOf('const liveRunState='),b=api.indexOf('\n',api.indexOf('if(act==="stop"',a));
 function check(health,job){let rejected=false;const c=vm.createContext({health,job,act:'stop',st:{},res:{status:()=>({json:()=>{rejected=true;}})}});vm.runInContext('(function(){'+api.slice(a,b)+'})()',c);return rejected;}
 assert.equal(check({job:{state:'idle'},moving:true},{}),false);
 assert.equal(check({job:{state:'idle'},moving:false},{agentAction:'jog',agentState:'accepted'}),false);
 assert.equal(check({job:{state:'idle'},moving:false},{}),true);
});
