import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const Module=require('node:module');

// No real credentials, persistence, model calls or messages. Exercise both local
// fallback and the Redis NX path with an in-process store.
process.env.APP_PASSWORD='offline-approval-test';
process.env.ANTHROPIC_API_KEY='offline-model-test';
const storage=new Map();
let failListWrite=false,failReceiptWrite=false;
class FakeRedis{
  async get(k){ return storage.has(k)?structuredClone(storage.get(k)):null; }
  async mget(...keys){return Promise.all(keys.map(k=>this.get(k)));}
  async eval(_script,keys,args){if(storage.get(keys[0])===args[0]) return this.del(keys[0]);return 0;}
  async set(k,v,opts={}){ if(k==='parkside:approvals'&&failListWrite){failListWrite=false;throw Error('simulated list failure');} if(k.startsWith('parkside:approval_send:')&&v.state==='sent'&&failReceiptWrite){failReceiptWrite=false;throw Error('simulated receipt failure');} if(opts.nx&&storage.has(k)) return null; storage.set(k,structuredClone(v)); return 'OK'; }
  async del(k){return storage.delete(k)?1:0;}
}
const originalLoad=Module._load;
for(const backend of ['memory','redis']){
  storage.clear();
  Module._load=function(id,...args){ if(id==='@upstash/redis'){ if(backend==='memory') throw new Error('offline memory mode'); return {Redis:FakeRedis}; } return originalLoad.call(this,id,...args); };
  delete require.cache[require.resolve('./api/app.js')];
  const handler=require('./api/app.js');
  Module._load=originalLoad;
  const r=handler.__routing;
  let guestCalls=0,modelCalls=0,staffCalls=0,guestFail=false,guestAmbiguous=false,modelKnown=false;
  global.fetch=async(url,options={})=>{
    const u=String(url);
    if(u==='https://api.anthropic.com/v1/messages'){
      modelCalls++;return {ok:true,json:async()=>({content:[{text:JSON.stringify({in_kb:modelKnown,answer:modelKnown?'The pool closes at 10pm.':''})}]})};
    }
    if(u==='https://api.ownerrez.com/v2/messages'){
      guestCalls++;
      // Yield to a concurrent second approval while the first holds its lock.
      await new Promise(resolve=>setTimeout(resolve,5));
      if(guestAmbiguous) throw Error('socket reset after possible acceptance');
      return {ok:!guestFail,status:guestFail?400:200,text:async()=>guestFail?'offline invalid payload':'{}'};
    }
    if(u==='https://mock.invalid/sms'){staffCalls++;return {ok:true,status:200,text:async()=>'{}'};}
    throw new Error('Unexpected outbound in offline test: '+u);
  };
  async function action(name,body={},query={},method='POST'){
    let result,status=200;
    await handler({method,query:{action:name,...query},headers:{'x-app-password':'offline-approval-test'},body},{setHeader(){},status(v){status=v;return this;},json(v){result=v;return this;},end(v){result=v;return this;},set statusCode(v){status=v;}});
    return {status,result};
  }
  await r.setNotifyRaw({smsTo:'+15555550100',smsGatewayUrl:'https://mock.invalid/sms',smsBody:'{"phone":"{to}","message":"{text}"}',ownerrez_oauth_token:'offline-not-real',approveSecret:'offline',routes:{normal:{channel:'email',recipient:'desk@example.com'},complaint:{channel:'sms',recipient:'+15555550100'},backup:{channel:'sms',recipient:'+15555550100'}}});
  let smsStatus=await action('sms_status');
  assert.equal(smsStatus.result.provider,'gateway');assert.equal(smsStatus.result.configured,false);
  await r.setNotifyRaw({...await r.getNotifyRaw(),smsUser:'offline-user',smsPass:'offline-password'});
  smsStatus=await action('sms_status');assert.equal(smsStatus.result.configured,true);assert.equal(smsStatus.result.recipientSet,true);
  assert.doesNotMatch(JSON.stringify(smsStatus.result),/offline-user|offline-password|mock\.invalid/,'status exposes no connection secrets');
  await action('state',{messaging_enabled:true});
  const item={id:'offline-q501',smsLabel:'Q501',status:'pending',thread_id:123,question:'When does the pool close?',proposed:'The pool closes at 10pm.',ts:new Date().toISOString()};
  await r.setApprovals([{...item}]);
  let out=await action('sms_inbound',{from:'+15555550100',text:'Q501'},{token:'offline'});
  assert.equal(out.result.need_approval,true);assert.equal(guestCalls,0);assert.equal((await r.getApprovals())[0].status,'pending');

  guestFail=true;
  out=await action('approve',{id:item.id,decision:'yes',answer:'The pool closes at 9pm.'});
  assert.equal(out.status,400);assert.equal(out.result.sent,false);assert.equal(out.result.retryable,true);
  assert.match(out.result.error,/still pending/);assert.equal((await r.getApprovals())[0].status,'pending');
  assert.equal((await r.getApprovals())[0].proposed,'The pool closes at 9pm.','failed edited reply is retained');
  out=await action('approve',{}, {id:item.id,token:'offline',decision:'yes'},'GET');
  assert.doesNotMatch(out.result,/Approved — reply sent/);assert.match(out.result,/not sent/);
  assert.equal((await r.getApprovals())[0].status,'pending');

  guestFail=false;guestCalls=0;
  const both=await Promise.all([action('approve',{id:item.id,decision:'yes'}),action('approve',{id:item.id,decision:'yes'})]);
  assert.equal(guestCalls,1,'concurrent approvals send once');assert.equal(both.filter(x=>x.result.sent).length,1);
  assert.equal((await r.getApprovals())[0].status,'approved');
  out=await action('approve',{id:item.id,decision:'yes'});assert.equal(out.result.ok,false);assert.equal(guestCalls,1);

  const complaint={...item,id:'offline-complaint'};
  await r.setApprovals([{...complaint,complaint:true}]);guestCalls=0;
  out=await action('sms_inbound',{from:'+15555550100',text:'Q501 yes'},{token:'offline'});
  assert.equal(out.result.complaint_human_only,true);assert.equal(guestCalls,0);
  await r.setApprovals([{...item,id:'offline-needs-fact',status:'escalated'}]);
  out=await action('sms_inbound',{from:'+15555550100',text:'Q501 yes'},{token:'offline'});
  assert.equal(out.result.need_facts,true);assert.equal(guestCalls,0);

  const disabled={...item,id:'offline-disabled'};
  await r.setApprovals([disabled]);await action('state',{messaging_enabled:false});
  out=await action('approve',{id:disabled.id,decision:'yes'});assert.equal(out.result.sent,false);assert.equal((await r.getApprovals())[0].status,'pending');assert.equal(guestCalls,0);
  await action('state',{messaging_enabled:true});
  const before=await r.getApprovals();const priorStaff=staffCalls;
  for(const known of [false,true]){
    modelKnown=known;
    out=await action('ai_draft',{question:'When does the pool close?',booking_id:789,thread_id:123});
    assert.equal(out.result.dryRun,true);assert.equal(out.result.sent,false);assert.equal(out.result.inKb,known);assert.equal(out.result.escalate,!known);
    assert.deepEqual(out.result.route,{channel:'email',recipient:'desk@example.com'});
  }
  assert.equal(modelCalls,2);assert.equal(guestCalls,0);assert.equal(staffCalls,priorStaff);assert.deepEqual(await r.getApprovals(),before,'preview does not queue or mutate approval');
  // Different-ID concurrency cannot revert a confirmed send or resend it.
  const pair=[{...item,id:'parallel-a'},{...item,id:'parallel-b'}];
  await r.setApprovals(pair);guestCalls=0;
  const pairResult=await Promise.all(pair.map(it=>action('approve',{id:it.id,decision:'yes'})));
  assert.equal(guestCalls,2);assert.equal(pairResult.filter(x=>x.result.sent).length,2);
  assert.ok((await r.getApprovals()).every(it=>it.status==='approved'));
  await r.setApprovals(pair); // simulate any stale shared-array writer
  for(const it of pair) await action('approve',{id:it.id,decision:'yes'});
  assert.equal(guestCalls,2,'durable receipts survive a stale array overwrite');

  const uncertain={...item,id:'uncertain'};await r.setApprovals([uncertain]);guestCalls=0;guestAmbiguous=true;
  out=await action('approve',{id:uncertain.id,decision:'yes'});
  assert.equal(out.result.uncertain,true);assert.equal(out.result.retryable,false);
  assert.match(out.result.error,/unconfirmed/);assert.equal((await r.getApprovals())[0].sendUncertain,true);
  guestAmbiguous=false;await action('approve',{id:uncertain.id,decision:'yes'});assert.equal(guestCalls,1,'ambiguous send never automatically retries');
  out=await action('approve',{id:uncertain.id,decision:'no',reason:'Checked and handled in OwnerRez'});
  assert.equal(out.result.decision,'rejected');assert.equal(out.result.uncertain,true);
  assert.equal((await r.getApprovals())[0].status,'rejected');

  if(backend==='redis'){
    const persisted={...item,id:'persist-failure'};await r.setApprovals([persisted]);guestCalls=0;failListWrite=true;
    out=await action('approve',{id:persisted.id,decision:'yes'});
    assert.equal(out.result.sent,true);assert.equal((await r.getApprovals())[0].status,'approved');
    await action('approve',{id:persisted.id,decision:'yes'});assert.equal(guestCalls,1,'list persistence failure cannot repeat send');
    const lost={...item,id:'receipt-failure'};await r.setApprovals([lost]);guestCalls=0;failReceiptWrite=true;
    out=await action('approve',{id:lost.id,decision:'yes'});assert.equal(out.result.ok,false);
    await action('approve',{id:lost.id,decision:'yes'});assert.equal(guestCalls,1,'lost success receipt leaves durable intent blocking resend');
  }
  console.log('messaging approval/preview regressions passed ('+backend+')');
}
