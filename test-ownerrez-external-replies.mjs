// Offline regressions for OwnerRez's owner-role trigger notices. The public schema
// (https://api.ownerrez.com/openapi/v2.json, ThreadMessageViewModel) does NOT expose
// manual/trigger provenance. Do not invent such a flag or claim the text filter is
// proof of human authorship. Routine/unclear replies remain reviewable in the panel.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import test from 'node:test';

const source=readFileSync(new URL('./api/app.js',import.meta.url),'utf8');
const actualRequire=createRequire(new URL('./api/app.js',import.meta.url));
const NOW=Date.parse('2026-10-11T16:00:00Z');
const clone=x=>x==null?x:structuredClone(x);
const key='parkside:approvals',threadKey='parkside:thr:t:123';
// Actual Oct 11 false-close notice and later genuine staff reply, with no secrets.
const guidebook="Hi Emily, thank you for completing your booking! 🏕️✨\n\nYou can find lots of helpful information for your stay in our digital guidebook here:\nhttps://guide.parksidetepees.com/g/buffalo-run\n\nWe'll also send you more detailed arrival information the morning of your arrival. We're so excited to welcome you! 😊";
const human='We have to get all of our check outs cleaned. Please feel free to contact the office to see when and if your unit is ready.';
const item=(extra={})=>({id:'emily-early-checkin',smsLabel:'Q389',status:'escalated',thread_id:123,booking_id:456,question:'Is early check-in possible?',ts:'2026-10-11T15:08:00Z',primaryNotifiedAt:'2026-10-11T15:08:00Z',...extra});

async function harness(){
  const db=new Map(),network=[];let beforeClose=null;
  class Redis{
    async get(k){return clone(db.get(k))??null;}
    async mget(...keys){return keys.map(k=>clone(db.get(k))??null);}
    async set(k,v,opts={}){if(opts.nx&&db.has(k))return null;db.set(k,clone(v));return 'OK';}
    async del(k){return db.delete(k)?1:0;}
    async eval(script,keys,args){
      if(script.includes('-- mark-escalation-handled')){
        if(beforeClose){const hook=beforeClose;beforeClose=null;hook(db);}
        if(keys[2]){
          const latest=(db.get(keys[2])||[]).filter(m=>m.d==='in').at(-1)||null;
          const expected=JSON.parse(args[4]);
          if(!!latest!==!!expected)return -1;
          if(latest&&['t','b','n'].some(k=>(latest[k]||'')!==(expected[k]||'')))return -1;
        }
        const list=clone(db.get(keys[0])||[]),record=list.find(x=>x.id===args[0]);
        if(!record)return 0;
        const expected=JSON.parse(args[1]);
        if(Object.keys(expected).some(k=>JSON.stringify(record[k]??null)!==JSON.stringify(expected[k])))return -1;
        Object.assign(record,JSON.parse(args[3]));
        db.set(keys[0],list);db.set(keys[1],JSON.parse(args[2]));return 1;
      }
      if(db.get(keys[0])===args[0])return db.delete(keys[0])?1:0;
      return 0;
    }
  }
  class Clock extends Date{constructor(...args){super(...(args.length?args:[NOW]));}static now(){return NOW;}}
  const context=vm.createContext({module:{exports:{}},Buffer,URLSearchParams,Date:Clock,Intl,console,setTimeout(fn){fn();},
    process:{env:{APP_PASSWORD:'offline',GAVIN_PASSWORD:'offline-owner'}},
    require(id){return id==='@upstash/redis'?{Redis}:actualRequire(id);},
    async fetch(url){network.push(url);throw Error('Unexpected external request: '+url);}
  });
  vm.runInContext(source,context,{filename:'api/app.js'});
  const handler=context.module.exports,r=handler.__routing;
  await r.setNotifyRaw({approveSecret:'offline-token',smsProvider:'none',smsTo:'+15555550100',routes:{normal:{channel:'sms',recipient:'+15555550100'},complaint:{channel:'sms',recipient:'+15555550100'},backup:{channel:'email',recipient:''}}});
  const action=async(name,body={},query={})=>{
    let result,status=200;
    await handler({method:'POST',query:{action:name,...query},headers:{'x-app-password':'offline'},body},{setHeader(){},status(n){status=n;return this;},json(v){result=v;return this;},end(v){result=v;return this;},set statusCode(n){status=n;}});
    return {status,result};
  };
  return {db,r,network,action,
    seed(records=[item()]){db.set(key,clone(records));db.set(threadKey,[{d:'in',b:records[0].question,t:records[0].lastGuestMsgAt||records[0].ts,n:'Emily'}]);},
    beforeClose(fn){beforeClose=fn;},
    webhook(entity={},actionName='entity_create',id='event-1'){return action('or_message_inbound',{action:actionName,entity_type:'thread_message',entity_id:id,entity:{id:119533723,thread_id:123,booking_id:456,from_role:'owner',from_contact_id:789,is_draft:false,date_utc:'2026-10-11T15:41:00Z',body:human,...entity}});}
  };
}

test('the actual guidebook trigger cannot close Q388, even if its owner-role sent date is valid',async()=>{
  const h=await harness();h.seed([item({smsLabel:'Q388',ts:'2026-10-11T13:03:00Z',primaryNotifiedAt:'2026-10-11T13:03:00Z'})]);
  const out=await h.webhook({id:119509989,body:guidebook,date_utc:'2026-10-11T13:05:00Z'});
  assert.equal(out.result.closureSkipped,'guidebook notice');assert.equal(out.result.closedExternally.length,0);
  assert.equal((await h.r.getApprovals())[0].status,'escalated');
  assert.equal(h.db.get(threadKey).at(-1).b,guidebook,'notice remains visible in conversation');
  assert.equal(h.network.length,0);
  const record=(await h.r.getApprovals())[0];
  const handled=await h.action('mark_escalation_handled',{id:record.id,reviewVersion:h.r.escalationReviewVersion(record)});
  assert.equal(handled.result.ok,true,'existing staff Mark handled remains usable after review');
});

test('routine booking, arrival, checkout and review notices leave the question open',async()=>{
  for(const body of ['Thank you for booking with us!','Your reservation is confirmed.','Please sign your rental agreement.','Here are your arrival instructions.','Your check-in details are available below.','Checkout reminder: please lock the door.','We hope you enjoyed your stay. Please leave us a review.']){
    const h=await harness();h.seed();const out=await h.webhook({body});
    assert.equal(out.result.closedExternally.length,0,body);assert.equal((await h.r.getApprovals())[0].status,'escalated',body);assert.equal(h.network.length,0);
  }
});

test('actual owner reply resolves only its thread; its durable receipt blocks a later Q# yes',async()=>{
  const h=await harness();const original=item();const other=item({id:'different-thread',smsLabel:'Q390',thread_id:999});h.seed([original,other]);
  const out=await h.webhook();assert.equal(out.result.closedExternally.join(','),'Q389');
  let records=await h.r.getApprovals();assert.equal(records[0].status,'closed');assert.equal(records[0].externalReply,human);assert.equal(records[1].status,'escalated');
  h.db.set(key,[original,other]); // stale writer must not reopen the answered revision
  assert.equal((await h.r.getApprovals())[0].status,'closed');
  const reply=await h.action('sms_inbound',{from:'+15555550100',text:'Q389 yes'},{token:'offline-token'});
  assert.equal(reply.result.already,'closed');assert.equal(h.network.length,0,'no duplicate guest message');
  h.db.set(key,[{...original,question:'A new question from the guest',lastGuestMsgAt:'2026-10-11T15:50:00Z'},other]);
  assert.equal((await h.r.getApprovals())[0].status,'escalated','old receipt never hides a newer guest question');
});

test('co-host can resolve a pending draft without sending its obsolete proposed reply',async()=>{
  const h=await harness();h.seed([item({status:'pending',proposed:'Obsolete proposed answer'})]);
  const out=await h.webhook({from_role:'co_host'});assert.equal(out.result.closedExternally.length,1);assert.equal((await h.r.getApprovals())[0].closedBy,'co_host');assert.equal(h.network.length,0);
});

test('bot, support, other, unknown, draft, removed and non-create events never close records',async()=>{
  for(const entity of [{from_role:'bot'},{from_role:'support'},{from_role:'other'},{from_role:''},{is_draft:true},{is_draft:'true'},{removed_utc:'2026-10-11T15:42:00Z'}]){
    const h=await harness();h.seed();await h.webhook(entity);assert.equal((await h.r.getApprovals())[0].status,'escalated',JSON.stringify(entity));assert.equal(h.network.length,0);
  }
  for(const event of ['entity_update','entity_delete']){const h=await harness();h.seed();await h.webhook({},event);assert.equal((await h.r.getApprovals())[0].status,'escalated');}
});

test('missing, invalid or queued-future sent time never falls back to webhook receipt time',async()=>{
  for(const date_utc of [null,'','not-a-date','2026-10-11T16:01:00Z']){const h=await harness();h.seed();const out=await h.webhook({date_utc});assert.match(out.result.closureSkipped,/provider sent time/);assert.equal((await h.r.getApprovals())[0].status,'escalated');}
  const h=await harness();h.seed();await h.webhook({date_utc:'2026-10-11T15:41:00'});assert.equal((await h.r.getApprovals())[0].status,'closed','documented UTC dates without a timezone suffix stay UTC');
});

test('delayed old-provider message cannot resolve a newer guest follow-up',async()=>{
  const h=await harness();h.seed([item({lastGuestMsgAt:'2026-10-11T15:50:00Z'})]);
  await h.webhook({date_utc:'2026-10-11T15:41:00Z'});assert.equal((await h.r.getApprovals())[0].status,'escalated');assert.equal(h.network.length,0);
});

test('engine echoes and holding notes cannot close an escalation',async()=>{
  for(const body of [human,'I am checking with my manager and will follow up shortly.']){
    const h=await harness();h.seed();if(body===human)h.db.get(threadKey).push({d:'out',b:human,t:'2026-10-11T15:40:00Z',n:''});
    await h.webhook({body});assert.equal((await h.r.getApprovals())[0].status,'escalated');
  }
});

test('new guest record racing the close is preserved by the existing reviewed-version CAS',async()=>{
  const h=await harness();h.seed();h.beforeClose(db=>{const records=db.get(key);records[0]={...records[0],question:'Please answer this new question',lastGuestMsgAt:'2026-10-11T15:59:00Z'};});
  const out=await h.webhook();assert.equal(out.result.closedExternally.length,0);const record=(await h.r.getApprovals())[0];assert.equal(record.status,'escalated');assert.equal(record.question,'Please answer this new question');assert.equal(h.db.has('parkside:approval_send:'+record.id),false);
});

test('new incoming transcript racing before the intake record update also prevents closure',async()=>{
  const h=await harness();h.seed();h.beforeClose(db=>db.get(threadKey).push({d:'in',b:'A follow-up is being processed',t:'2026-10-11T15:59:00Z',n:'Emily'}));
  const out=await h.webhook();assert.equal(out.result.closedExternally.length,0);assert.equal((await h.r.getApprovals())[0].status,'escalated');
});

test('external close shares the approval-decision lock and cannot erase another in-flight decision',async()=>{
  const h=await harness();h.seed();h.db.set('parkside:approval_decision:'+item().id,'another-decision');
  const out=await h.webhook();assert.equal(out.result.closedExternally.length,0);assert.equal((await h.r.getApprovals())[0].status,'escalated');assert.equal(h.db.get('parkside:approval_decision:'+item().id),'another-decision');
});
