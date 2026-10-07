import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url), Module=require('node:module');
const facts=require('./api/guest-facts.cjs');
const approved=(id,topic,a,scope={type:'property'},more={})=>({id,topic,a,scope,status:'approved',reusable:true,kind:'fact',provenance:[{type:'owner-reviewed',id:'source-'+id}],...more});
const checkout=approved('checkout','Checkout procedure','There is no need to check out with the front desk.');
const base={items:[checkout,approved('checkin','Check-in time','4:00 PM'),approved('address','Address & directions','204 Big Sky Way'),approved('fire','Communal fire pits','There are two community fire pits.'),approved('parking','Parking','Flyin Free parking is 150 feet away.',{type:'unit',value:'486918'}),approved('exception','Checkout time','11:30 AM',{type:'booking',value:'123',validUntil:'2026-10-08'}),approved('rule','Style','Do not say checkout on time.',{type:'property'},{kind:'instruction'}),{topic:'Legacy staff promise',a:'We will fix it tomorrow',src:'approved'},approved('pending','Pool hours','MIDNIGHT',{type:'property'},{status:'needs_review'}),approved('retired','Retired','OLD FACT',{type:'property'},{status:'retired'}),approved('superseded','Superseded','OLD ANSWER',{type:'property'},{supersededBy:'checkout'}),approved('internal','Internal','SECRET SETUP',{type:'internal'})]};
assert.equal(facts.select(base).some(i=>i.id==='parking'),false);
assert.equal(facts.select(base,{unit:'486918'}).some(i=>i.id==='parking'),true);
assert.equal(facts.select(base,{unit:'486910'}).some(i=>i.id==='parking'),false);
assert.equal(facts.select(base,{booking:'123',date:'2026-10-07'}).some(i=>i.id==='exception'),true);
assert.equal(facts.select(base,{booking:'123',date:'2026-10-09'}).some(i=>i.id==='exception'),false);
assert.equal(facts.select(base,{booking:'456',date:'2026-10-07'}).some(i=>i.id==='exception'),false);
assert.doesNotMatch(facts.prompt(base),/tomorrow|MIDNIGHT|OLD FACT|OLD ANSWER|SECRET SETUP/);
const notes=[{id:'r1',reason:'Auto-rejected: no decision within 24 hours. This is incorrect / contradictory. There is no need to check-out with the front desk.',draft:'Go to the front desk!',ts:'2026-07-17T20:20:58.861Z',q:'Checkout?'},{id:'r2',reason:'Auto-rejected: no decision within 24 hours.',draft:'Unsupported made-up pool hours'},{id:'r3',reason:'Wrong info, communal fire pits.',draft:'Private fire pits'},{id:'r4',reason:'Too long',draft:'Bogus info'}];
const recovered=facts.recover(notes);assert.equal(recovered.length,2);assert.equal(recovered[0].a,'This is incorrect / contradictory. There is no need to check-out with the front desk.');assert.equal(recovered[0].provenance[0].id,'r1');assert.doesNotMatch(JSON.stringify(recovered),/Go to the front desk|Unsupported made-up|Private fire pits/);assert.equal(facts.select({items:recovered}).length,0,'recovered reasons not auto-approved');
const edited=facts.mergeSave(base,{items:[{id:'parking',topic:'Parking',a:'Updated approved parking wording'}]});assert.equal(edited.items[0].scope.value,'486918');assert.deepEqual(edited.items[0].provenance,base.items[4].provenance);assert.equal(edited.items[0].revision,2);assert.equal(facts.select(edited,{unit:'486910'}).length,0);
const store=new Map(),originalLoad=Module._load;
class Redis{async eval(script,keys,args){assert.match(script,/canonical-state-cas/);const p=JSON.parse(args[0]),cur=store.get(keys[0])||{};if(p.kb&&String(cur.kb?.revision||'')!==args[1])return 0;store.set(keys[0],{...cur,...p});return 1;}async get(k){return structuredClone(store.get(k)||null);}async set(k,v){store.set(k,structuredClone(v));return 'OK';}async del(k){store.delete(k);}}
process.env.APP_PASSWORD='offline-facts';process.env.ANTHROPIC_API_KEY='offline-no-network';
for(const backend of ['memory','redis']){
 store.clear();Module._load=function(id,...args){if(id==='@upstash/redis'){if(backend==='memory')throw Error('offline');return {Redis};}return originalLoad.call(this,id,...args);};delete require.cache[require.resolve('./api/app.js')];const handler=require('./api/app.js');Module._load=originalLoad;
 let modelCalls=0;const prompts=[];
 global.fetch=async(url,opts)=>{assert.equal(String(url),'https://api.anthropic.com/v1/messages','No send/provider/network requests');modelCalls++;const body=JSON.parse(opts.body);prompts.push(body.system);const question=body.messages[0].content;
  let answer='';if(/check.?out/i.test(question)&&/no need to check out with the front desk/.test(body.system))answer=checkout.a;
  else if(/check.?in and address/i.test(question)&&/4:00 PM/.test(body.system)&&/204 Big Sky Way/.test(body.system))answer='Check-in is 4:00 PM; the address is 204 Big Sky Way.';
  else if(/fire pit/i.test(question)&&/two community fire pits/.test(body.system))answer='There are two community fire pits.';
  return {ok:true,json:async()=>({content:[{text:JSON.stringify({known:answer?'full':'none',in_kb:!!answer,answer,needs_response:true,complaint:false})}]})};};
 async function action(name,body={},query={},method='POST',authorized=true){let result,status=200;await handler({method,query:{action:name,...query},headers:authorized?{'x-app-password':'offline-facts'}:{},body},{setHeader(){},status(v){status=v;return this;},json(v){result=v;return this;},end(v){result=v;return this;},set statusCode(v){status=v;}});return {status,result};}
 await action('state',{kb:base});
 store.set('parkside:kb_approved',[{q:'checkout',a:'BANK ONLY GO TO FRONT DESK'}]);store.set('parkside:kb_corrections',[{q:'checkout',bad:'bad',good:'PENDING EDIT MIDNIGHT'}]);store.set('parkside:kb_rejected',notes);
 let out=await action('state',{}, {},'GET');assert.equal(out.result.kb.items[4].scope.value,'486918');assert.deepEqual(out.result.kb.items[4].provenance,base.items[4].provenance);
 assert.equal((await action('state',{}, {},'GET',false)).result.kb.items.length,0,'private provenance not exposed publicly');
 const live=await handler.__msg.aiDraftAnswer(out.result.kb,'Do I check out at the front desk?','Guest',[{a:'EXPLICIT BANK ARGUMENT LEAK'}],[]);
 assert.equal(live.known,'full');assert.equal(live.answer,checkout.a);assert.ok(live.availableFactIds.includes('checkout'));
 for(const question of ['Do I check out at the front desk?','What is check-in and address?','How many fire pits?']){const r=await action('ai_draft',{question});assert.equal(r.result.inKb,true);assert.equal(r.result.sent,false);assert.ok(r.result.availableFactIds.includes('checkout'));}
 for(const question of ['Do you have EV charging?','What are pool hours?','Will someone staff the office after 9?']){const r=await action('ai_draft',{question});assert.equal(r.result.inKb,false);assert.equal(r.result.sent,false);}
 for(const p of prompts)assert.doesNotMatch(p,/BANK ONLY|PENDING EDIT|EXPLICIT BANK|MIDNIGHT|SECRET SETUP|fix it tomorrow/);
 out=await action('kb_query',{}, {q:'Parking'},'GET');assert.equal(out.result.match,null);
 out=await action('kb_query',{}, {q:'Parking',unit:'486918'},'GET');assert.equal(out.result.match.answer,'Flyin Free parking is 150 feet away.');
 out=await action('kb_query',{}, {q:'Style'},'GET');assert.equal(out.result.match,null,'instructions cannot be factual deterministic answers');
 // Removing the canonical entry revokes it even though all historical stores remain.
 await action('state',{kb:{revision:(await action('state',{}, {},'GET')).result.kb.revision,items:base.items.filter(i=>i.id!=='checkout')}});out=await action('ai_draft',{question:'Do I check out at the front desk?'});assert.equal(out.result.inKb,false);assert.ok(!out.result.availableFactIds.includes('checkout'));
 // Imports preserve scope/provenance and metadata-less changes require reapproval.
 await action('kb_learn',{entries:[{id:'parking',topic:'Parking',a:'Changed parking'}]});out=await action('state',{}, {},'GET');let parking=out.result.kb.items.find(i=>i.id==='parking');assert.equal(parking.scope.value,'486918');assert.equal(parking.status,'needs_review');assert.deepEqual(parking.provenance,base.items[4].provenance);
 await action('kb_learn',{entries:[{...parking,status:'approved',reusable:true}]});out=await action('kb_query',{}, {q:'Parking',unit:'486918'},'GET');assert.equal(out.result.match.answer,'Changed parking');
 // Stale full saves cannot resurrect deleted authority; unrelated settings keep it deleted.
 const priorKb=(await action('state',{}, {},'GET')).result.kb;
 const altered={...structuredClone(priorKb),items:priorKb.items.filter(i=>i.id!=='fire')};
 assert.equal((await action('state',{kb:altered})).result.ok,true);
 const stale=await action('state',{kb:priorKb});assert.notEqual(stale.result.ok,true);
 await action('state',{messaging_enabled:true});
 assert.equal((await action('state',{}, {},'GET')).result.kb.items.some(i=>i.id==='fire'),false);
 const concurrent=(await action('state',{}, {},'GET')).result.kb;
 const saves=await Promise.all([action('state',{kb:{...concurrent,format:'a'}}),action('state',{kb:{...concurrent,format:'b'}})]);
 assert.equal(saves.filter(r=>r.result.ok).length,1,'CAS rejects one concurrent KB writer');
 const beforeRead=structuredClone([...store]);const beforeCalls=modelCalls;
 const status=await action('facts_status');assert.equal(status.result.readOnly,true);assert.equal(modelCalls,beforeCalls);assert.deepEqual([...store],beforeRead,'facts_status performs no writes');
 if(backend==='redis'){
  store.set('parkside:pending_facts',[{id:'correction-existing',status:'pending',topic:'Check-in time',a:'4:30 PM'}]);
  out=await action('pending_fact',{id:'correction-existing',action:'approve',scope:{type:'property',value:''}});assert.equal(out.result.approved,true);
  const sameTopic=(await action('state',{}, {},'GET')).result.kb.items.filter(i=>i.topic==='Check-in time');assert.equal(sameTopic.length,1);assert.equal(sameTopic[0].a,'4:30 PM');
  out=await action('fact_corrections');assert.equal(out.result.candidates.length,2);assert.equal(out.result.authoritative,false);
  store.set('parkside:pending_facts',[{id:'one-time',status:'pending',topic:'Repair',a:'Repair tomorrow',source:'approved_reply'}]);
  out=await action('pending_fact',{id:'one-time',action:'approve'});assert.equal(out.status,400,'approval requires explicit scope');
  out=await action('pending_fact',{id:'one-time',action:'approve',scope:{type:'booking',value:'123'}});assert.equal(out.result.approved,true);
  out=await action('state',{}, {},'GET');assert.equal(facts.select(out.result.kb).some(i=>i.topic==='Repair'),false);assert.equal(facts.select(out.result.kb,{booking:'123'}).some(i=>i.topic==='Repair'),true);
 }
 assert.ok(modelCalls>0);console.log('canonical authority / correction regressions passed ('+backend+')');
}
// Precedence and conflict are deterministic, not left for the model to resolve.
const conflicting={items:[approved('default','Checkout time','10 AM'),approved('special','Checkout time','11:30 AM',{type:'booking',value:'123'})]};
assert.deepEqual(facts.select(conflicting,{booking:'123'}).map(i=>i.id),['special']);
assert.deepEqual(facts.select(conflicting,{booking:'456'}).map(i=>i.id),['default']);
assert.equal(facts.select({items:[approved('a','Pool hours','9 PM'),approved('b','Pool hours','10 PM')]}).length,0);
assert.throws(()=>facts.mergeSave({revision:'new',items:[]},{revision:'old',items:[checkout]}),/changed in another session/);
console.log('scope precedence/conflict and stale-save regressions passed');
