// All backend execution is VM-isolated with a fake Redis and intercepted transport.
// The browser cases execute the actual inline handlers using the existing DOM harness.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import test from 'node:test';
const source=readFileSync(new URL('../api/app.js',import.meta.url),'utf8');
const requireActual=createRequire(new URL('../api/app.js',import.meta.url));
const NOW=Date.parse('2026-10-12T13:05:00Z');
const ago=h=>new Date(NOW-h*3600000).toISOString();
const record=(id,age,extra={})=>({id,smsLabel:id,status:'escalated',question:'What are the Grille hours?',thread_id:'12209207',ts:ago(age),primaryNotifiedAt:ago(age),backupAskSent:true,escalatedTo2At:ago(age-1),...extra});
const clone=x=>x==null?x:JSON.parse(JSON.stringify(x));
function harness(shared){
  const values=shared||new Map(),seen=[],writes=[];
  let failLock=false,beforeClose=null;
  class Redis{
    async get(k){return clone(values.get(k));}
    async mget(...keys){return keys.map(k=>clone(values.get(k))??null);}
    async set(k,v,opts){
      if(opts?.nx&&k.startsWith('parkside:esc_digest:')&&failLock)throw Error('fixture lock outage');
      if(opts?.nx&&values.has(k))return null;
      values.set(k,clone(v));writes.push({k,opts});return 'OK';
    }
    async del(k){return values.delete(k)?1:0;}
    async incr(k){const next=(values.get(k)||0)+1;values.set(k,next);return next;}
    async eval(script,keys,args){
      if(script.includes('-- mark-escalation-handled')){
        if(beforeClose){const fn=beforeClose;beforeClose=null;fn(values);}
        const list=clone(values.get(keys[0]))||[],it=list.find(x=>x.id===args[0]);if(!it)return 0;
        const expected=JSON.parse(args[1]),receipt=JSON.parse(args[2]);
        for(const k of Object.keys(expected))if(JSON.stringify(it[k]??null)!==JSON.stringify(expected[k]))return -1;
        Object.assign(it,{status:'closed',decidedAt:receipt.at,closedBy:'staff',closedReason:'Marked handled without sending'});
        values.set(keys[0],list);values.set(keys[1],receipt);writes.push({k:keys[0]});return 1;
      }
      if(values.get(keys[0])===args[0])return values.delete(keys[0])?1:0;
      return 0;
    }
  }
  const context=vm.createContext({module:{exports:{}},Buffer,URLSearchParams,Date,Intl,console,
    process:{env:{APP_PASSWORD:'offline-fixture'}},
    require(id){return id==='@upstash/redis'?{Redis}:requireActual(id);},
    async fetch(url,options){
      assert.equal(String(url),'http://fixture.invalid/sms','all external traffic is intercepted and denied');
      seen.push(JSON.parse(options.body));
      return {ok:true,status:200,async text(){return JSON.stringify({id:'fixture-'+seen.length,state:'Pending'});}};
    }});
  vm.runInContext(source,context,{filename:'api/app.js'});
  const handler=context.module.exports,R=handler.__routing;
  const request=async(action,body={},headers={'x-app-password':'offline-fixture'},method='POST')=>{
    const res={statusCode:200,setHeader(){},status(n){this.statusCode=n;return this;},json(value){this.value=value;return this;}};
    await handler({query:{action},headers,body,method},res);return res;
  };
  return {values,seen,writes,R,msg:handler.__msg,request,failLock(){failLock=true;},beforeClose(fn){beforeClose=fn;},
    async seed(items){await R.setNotifyRaw({smsProvider:'gateway',smsGatewayUrl:'http://fixture.invalid/sms',smsUser:'fixture',smsPass:'fixture',escalationDigest:true,routes:{normal:{channel:'sms',recipient:'+15550000000'},complaint:{channel:'sms',recipient:'+15550000000'},backup:{channel:'sms',recipient:'+15550000000'}}});await R.setApprovals(items);}};
}

test('recent window uses exact time, preserves historical and unknown records',async()=>{
  const h=harness();const all=[record('Qold',74*24),record('Qedge',7*24),record('Qover',7*24+.0001),record('Qfuture',-1),record('Qunknown',1,{ts:'bad',primaryNotifiedAt:'bad'}),record('Qrenewed',74*24,{lastGuestMsgAt:ago(30),escalatedTo2At:ago(29)})];
  const summary=h.R.openEscalationSummary(all,NOW);
  assert.equal(summary.count,6);assert.equal(summary.recentCount,2);assert.equal(summary.historicalCount,4);
  assert.deepEqual(Array.from(summary.recent,x=>x.label),['Qedge','Qrenewed']);
  assert.equal(all[0].status,'escalated');
});

test('24-hour cooldown forbids a digest immediately after first backup or new activity',async()=>{
  const h=harness();await h.seed([]);
  const items=[record('Qfirst',1,{escalatedTo2At:ago(0)}),record('Qjust',40,{escalatedTo2At:ago(23.999)}),record('Qexact',40,{escalatedTo2At:ago(24)}),record('Qreply',40,{lastGuestMsgAt:ago(1)}),record('Qlegacy',25,{escalatedTo2At:null}),record('QlegacyYoung',24.99,{escalatedTo2At:null}),record('Qpartial',40,{partialAnswered:true,answeredToGuest:true}),record('Quncertain',40,{backupAskUncertain:true})];
  const eligible=h.R.escalationDigestItems(items,await h.R.getNotifyConfig(),NOW);
  assert.deepEqual(Array.from(eligible,x=>x.label),['Qexact','Qpartial','Qlegacy']);
});

test('two isolated invocations share atomic Redis daily lock; receipt keeps provider IDs',async()=>{
  const values=new Map(),a=harness(values),b=harness(values);await a.seed([record('Q386',40)]);
  const results=await Promise.all([a.R.remindOpenEscalations({}, {now:NOW}),b.R.remindOpenEscalations({}, {now:NOW})]);
  assert.equal(results.filter(x=>x.sent).length,1);assert.equal(a.seen.length+b.seen.length,1);
  const receipt=await a.R.getEscalationDigestLast();assert.equal(receipt.accepted,true);assert.equal(receipt.deliveryStatus,'Pending');assert.equal(receipt.messageId,'fixture-1');
  const text=(a.seen[0]||b.seen[0]).textMessage.text;
  assert.match(text,/What are the Grille hours\?/);assert.match(text,/https:\/\/app.ownerrez.com\/inbox\/12209207/);assert.match(text,/some may already be handled/);
  assert.doesNotMatch(text,/still unanswered|Still waiting for an answer/);
});

test('Redis lock failure cannot send or claim a successful digest',async()=>{
  const h=harness();await h.seed([record('Q386',40)]);h.failLock();
  const r=await h.R.remindOpenEscalations({}, {now:NOW});assert.equal(r.sent,false);assert.equal(r.reason,'could not take the daily lock');assert.equal(h.seen.length,0);
});

test('Twilio local preflight failure is known-unsent, not uncertain, and recorded',async()=>{
  const h=harness();await h.seed([record('Q386',40)]);
  await h.R.setNotifyRaw({smsProvider:'twilio',routes:{backup:{channel:'sms',recipient:'+15550000000'}}});
  const r=await h.R.remindOpenEscalations({}, {now:NOW});assert.equal(r.sent,false);assert.equal(r.retryable,true);assert.equal(r.uncertain,false);assert.equal(h.seen.length,0);
  assert.equal((await h.R.getEscalationDigestLast()).accepted,false);
});

test('mark handled authenticates, requires POST, sends nothing and leaves KB/other records unchanged',async()=>{
  const h=harness();const chosen=record('Q378',40),other=record('Q386',40);await h.seed([chosen,other]);
  h.values.set('parkside:state',{messaging_enabled:true,kb:{items:[{topic:'Original',a:'Unchanged'}]}});
  const kb=clone(h.values.get('parkside:state'));const body={id:chosen.id,reviewVersion:h.R.escalationReviewVersion(chosen)};
  assert.equal((await h.request('mark_escalation_handled',body,{})).statusCode,401);
  assert.equal((await h.request('mark_escalation_handled',body,undefined,'GET')).statusCode,405);
  const result=await h.request('mark_escalation_handled',body);assert.equal(result.statusCode,200);assert.equal(result.value.sent,false);assert.equal(result.value.learned,false);
  assert.equal((await h.R.getApprovals())[0].status,'closed');assert.deepEqual(clone((await h.R.getApprovals())[1]),other);assert.deepEqual(h.values.get('parkside:state'),kb);assert.equal(h.seen.length,0);
  assert.equal((await h.request('mark_escalation_handled',body)).value.already,true);
});

test('stale review and concurrent guest update both refuse closure without overwriting anything',async()=>{
  const h=harness();const chosen=record('Q387',40);await h.seed([chosen]);const body={id:chosen.id,reviewVersion:h.R.escalationReviewVersion(chosen)};
  await h.R.setApprovals([{...chosen,question:'And what is the price?',lastGuestMsgAt:ago(1)}]);
  assert.equal((await h.request('mark_escalation_handled',body)).statusCode,409);
  await h.R.setApprovals([chosen]);
  h.beforeClose(values=>values.set('parkside:approvals',[{...chosen,question:'Brand-new question',lastGuestMsgAt:ago(0)},record('Qnew',1)]));
  assert.equal((await h.request('mark_escalation_handled',body)).statusCode,409);
  const list=await h.R.getApprovals();assert.equal(list.length,2);assert.equal(list[0].question,'Brand-new question');assert.equal(list[0].status,'escalated');assert.equal(h.seen.length,0);
});

test('handled receipt prevents stale same-revision reopen but never suppresses a new guest message',async()=>{
  const h=harness();const chosen=record('Q378',40);await h.seed([chosen]);
  await h.request('mark_escalation_handled',{id:chosen.id,reviewVersion:h.R.escalationReviewVersion(chosen)});
  await h.R.setApprovals([chosen]);assert.equal((await h.R.getApprovals())[0].status,'closed');
  await h.R.setApprovals([{...chosen,question:'The door is broken',lastGuestMsgAt:ago(0)}]);
  assert.equal((await h.R.getApprovals())[0].status,'escalated');
});

test('exact checkout thanks on muted thread is logged without new complaint, backup or send',async()=>{
  const h=harness();await h.seed([]);h.values.set('parkside:complaint_mute:t:fixture-thread','earlier');
  const question='Thank you enjoyed.. see you next time! We have left.';
  const out=await h.msg.processGuestQuestion({}, {question,threadId:'fixture-thread'});
  assert.equal(out.pleasantry,true);assert.equal((await h.R.getApprovals()).length,0);assert.equal(h.seen.length,0);
  assert.equal(h.values.get('parkside:thr:t:fixture-thread').at(-1).b,question);
  for(const text of ['Thanks, the door is broken','Thank you! Can we stay another night?','Thank you enjoyed.. see you next time! We have left. Please refund us','Thanks we have left the door unlocked','Thank you we enjoyed our stay but the fridge is broken','Thanks, we need help'])assert.equal(h.msg.isObviousPleasantry(text),false,text);
  const issue=await h.msg.processGuestQuestion({}, {question:'Thanks, the door is broken',threadId:'fixture-thread'});
  assert.equal(issue.complaint_muted,true);assert.equal(issue.no_guest_reply,true);assert.equal((await h.R.getApprovals()).length,1);assert.equal(h.seen.length,1,'only staff alerted for the genuine new issue');
});

async function browser(){
  const raw=readFileSync(new URL('./cnc-browser-harness.mjs',import.meta.url),'utf8').replace('return { cncRenderToolpath,',`return { messagingHooks(send,confirmation) { smsRequest=send;confirm=confirmation||(()=>true);return {loadSmsTransport,smsUiWork,saveNotify,activateSmsProvider,smsProviderChoiceChanged,syncDigestSetting,digestSettingChanged,renderDigestSetting,markOpenEscalationHandled,setFetch(fn){fetch=fn;},setPassword(){PW='offline-fixture';},state(){return {SMS_TRANSPORT,SMS_PROVIDER_SYNCED,NOTIFY_DIGEST_SAVED};}}; }, cncRenderToolpath,`);
  const harnessModule=await import('data:text/javascript;base64,'+Buffer.from(raw).toString('base64'));
  return harnessModule.loadBrowserScript(new URL('../index.html',import.meta.url).pathname);
}
const status=(provider='gateway',extra={})=>({provider,twilio:{from:'+15550000001'},smsRecipients:[],openEscalations:{count:0,recent:[],historical:[],items:[]},escalationDigest:false,...extra});

test('real browser refresh corrects stale service while busy and preserves an unsaved selection',async()=>{
  const b=await browser();let current=status();const ui=b.messagingHooks(async()=>current);await ui.loadSmsTransport();assert.equal(b.elements.smsProviderChoice.value,'gateway');
  current=status('twilio');await ui.smsUiWork(async()=>'Saved');assert.equal(b.elements.smsProviderChoice.value,'twilio');
  await ui.loadSmsTransport();assert.equal(b.elements.smsProviderChoice.value,'twilio','subsequent refresh stays correct');
  b.elements.smsProviderChoice.value='none';await ui.smsUiWork(async()=>'Checked');assert.equal(b.elements.smsProviderChoice.value,'none','deliberate operator choice preserved');
});

test('real digest checkbox never labels unsaved change live and failed save preserves setting',async()=>{
  const b=await browser();const ui=b.messagingHooks(async()=>status());await ui.loadSmsTransport();
  assert.equal(b.elements.nEscDigest.checked,false);b.elements.nEscDigest.checked=true;ui.digestSettingChanged();
  assert.match(b.elements.nEscDigestState.textContent,/Saved daily reminder: OFF.*Unsaved/);
  await ui.loadSmsTransport();assert.equal(b.elements.nEscDigest.checked,true);assert.equal(ui.state().NOTIFY_DIGEST_SAVED,false);
  let savedBody;ui.setFetch(async(url,opts)=>{if(opts?.method==='POST'){savedBody=JSON.parse(opts.body);return {ok:false,status:503,async json(){return {error:'fixture rejection'};}};}return {ok:true,async json(){return {};}};});
  assert.equal(await ui.saveNotify(),false);assert.equal(savedBody.escalationDigest,true);assert.equal(ui.state().NOTIFY_DIGEST_SAVED,false);assert.match(b.elements.nMsg.textContent,/Save failed/);
});

test('real mark-handled UI uses reviewed revision; stale backend failure remains visible',async()=>{
  const h=harness();const chosen=record('Q378',40);await h.seed([chosen]);const b=await browser();const summary=()=>h.R.openEscalationSummary(h.values.get('parkside:approvals'),NOW);
  const ui=b.messagingHooks(async(action,body)=>{if(action==='sms_status')return status('twilio',{openEscalations:summary()});const res=await h.request(action,body);if(res.statusCode!==200)throw Error(res.value.error);return res.value;});
  await ui.loadSmsTransport();assert.match(b.elements.smsOpenEsc.innerHTML,/Mark handled — no reply/);assert.match(b.elements.smsOpenEsc.innerHTML,/Historical \/ unknown date/);
  await h.R.setApprovals([{...chosen,question:'New message'}]);await ui.markOpenEscalationHandled(0);assert.match(b.elements.smsOpenEscMsg.textContent,/changed after/);assert.equal((await h.R.getApprovals())[0].status,'escalated');
  await ui.loadSmsTransport();await ui.markOpenEscalationHandled(0);assert.match(b.elements.smsOpenEscMsg.textContent,/Nothing sent; knowledge base unchanged/);assert.equal((await h.R.getApprovals())[0].status,'closed');assert.equal(h.seen.length,0);
});


test('provider explicit choice survives return-to-original during activation and later external switches',async()=>{
  const b=await browser();let current=status(),release;
  const ui=b.messagingHooks(async(action)=>{if(action==='set_notify_config'){await new Promise(r=>release=r);current=status('twilio');return {ok:true};}return current;});
  await ui.loadSmsTransport();
  b.elements.smsProviderChoice.value='twilio';ui.smsProviderChoiceChanged();
  const activating=ui.activateSmsProvider();
  b.elements.smsProviderChoice.value='gateway';ui.smsProviderChoiceChanged();release();await activating;
  assert.equal(b.elements.smsProviderChoice.value,'gateway','explicit return to original is not overwritten');
  b.elements.smsProviderChoice.value='twilio';ui.smsProviderChoiceChanged();
  await ui.loadSmsTransport();current=status('gateway');await ui.loadSmsTransport();
  assert.equal(b.elements.smsProviderChoice.value,'twilio','matching one intermediate server status must not erase explicit choice');
});

test('digest actual transport body stays within one readable chunk and counts omitted records',async()=>{
  const h=harness();await h.seed(Array.from({length:12},(_,i)=>record('Q'+i,40+i,{question:'A long guest question '.repeat(100),unit:'x'.repeat(500),guest_name:'y'.repeat(500)})));
  const result=await h.R.remindOpenEscalations({}, {now:NOW});const text=h.seen[0].textMessage.text;
  assert.equal(result.sent,true);assert.ok(text.length<=1300);assert.ok(result.shown<8);assert.equal(result.more,12-result.shown);assert.match(text,/more in the Messaging panel/);assert.match(text,/app.ownerrez.com\/inbox\/12209207/);
});

test('successful activation clears dirty state so a later actual provider change is reflected',async()=>{
  const b=await browser();let current=status();
  const ui=b.messagingHooks(async(action,body)=>{if(action==='set_notify_config'){current=status(body.smsProvider);return {ok:true};}return current;});
  await ui.loadSmsTransport();b.elements.smsProviderChoice.value='twilio';ui.smsProviderChoiceChanged();
  await ui.activateSmsProvider();assert.equal(b.elements.smsProviderChoice.value,'twilio');
  current=status('gateway');await ui.loadSmsTransport();assert.equal(b.elements.smsProviderChoice.value,'gateway');
});

test('unsaved digest choice survives matching then conflicting server refreshes',async()=>{
  const b=await browser();let current=status();const ui=b.messagingHooks(async()=>current);await ui.loadSmsTransport();
  b.elements.nEscDigest.checked=true;ui.digestSettingChanged();
  current=status('gateway',{escalationDigest:true});await ui.loadSmsTransport();
  current=status('gateway',{escalationDigest:false});await ui.loadSmsTransport();
  assert.equal(b.elements.nEscDigest.checked,true);assert.match(b.elements.nEscDigestState.textContent,/Saved daily reminder: OFF.*Unsaved/);
});

test('digest save preserves mid-request edit, then clears dirty only after that selection is saved',async()=>{
  const b=await browser();let current=status(),release;
  const ui=b.messagingHooks(async()=>current);await ui.loadSmsTransport();
  ui.setFetch(async(url,opts)=>{if(opts?.method==='POST'){const body=JSON.parse(opts.body);await new Promise(r=>release=r);current=status('gateway',{escalationDigest:body.escalationDigest});return {ok:true,async json(){return {ok:true,saved:{escalationDigest:body.escalationDigest}};}};}return {ok:true,async json(){return {};}};});
  b.elements.nEscDigest.checked=true;ui.digestSettingChanged();const saving=ui.saveNotify();
  b.elements.nEscDigest.checked=false;ui.digestSettingChanged();release();assert.equal(await saving,true);await ui.loadSmsTransport();
  assert.equal(b.elements.nEscDigest.checked,false);assert.match(b.elements.nEscDigestState.textContent,/Saved daily reminder: ON.*Unsaved/);
  const saveLatest=ui.saveNotify();release();assert.equal(await saveLatest,true);await ui.loadSmsTransport();
  assert.equal(ui.state().NOTIFY_DIGEST_SAVED,false);assert.doesNotMatch(b.elements.nEscDigestState.textContent,/Unsaved/);
  current=status('gateway',{escalationDigest:true});await ui.loadSmsTransport();assert.equal(b.elements.nEscDigest.checked,true,'saved choice may follow later server updates');
});
