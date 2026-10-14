// Offline wire-level regression tests. All provider calls and consent are in memory.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import test from 'node:test';
import crypto from 'node:crypto';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const require=createRequire(import.meta.url);
const sms=require('./api/staff-sms.cjs');
const id=n=>'SM'+String(n).padStart(32,'0');
const cfg={smsProvider:'twilio',twilioAccountSid:'AC'+'1'.repeat(32),twilioAuthToken:'offline-only',twilioMessagingServiceSid:'MG'+'2'.repeat(32),twilioFrom:'+15555550100',smsTo:'+15555550101'};
const prefix='Tennessee Tepees Employee SMS';
const footer='\nReply STOP to opt out.';
const envelope=(payload,index=1,total=1)=>prefix+(total>1?` (${index}/${total})`:'')+'\n'+payload+footer;

// Independent 3GPP GSM-7 table, written as code points rather than the production
// alphabet. ASCII is NOT all GSM-7 (backtick, tab and ESC are not basic characters).
const gsmBasic=new Set([
  ...Array.from({length:95},(_,i)=>i+32).filter(n=>![0x5b,0x5c,0x5d,0x5e,0x60,0x7b,0x7c,0x7d,0x7e].includes(n)),
  10,13,0xa1,0xa3,0xa4,0xa5,0xa7,0xbf,0xc4,0xc5,0xc6,0xc7,0xc9,0xd1,0xd6,0xd8,0xdc,0xdf,
  0xe0,0xe4,0xe5,0xe6,0xe8,0xe9,0xec,0xf1,0xf2,0xf6,0xf8,0xf9,0xfc,0x393,0x394,0x398,0x39b,0x39e,0x3a0,0x3a3,0x3a6,0x3a8,0x3a9
]);
const gsmExtended=new Set([12,0x5b,0x5c,0x5d,0x5e,0x7b,0x7c,0x7d,0x7e,0x20ac]);
const graphemes=new Intl.Segmenter('en',{granularity:'grapheme'});
function wireCost(body,keepClusters=false){
  assert.doesNotMatch(body,/[\uD800-\uDFFF]/u,'wire body has no lone surrogate');
  const chars=Array.from(body),gsm=chars.every(c=>gsmBasic.has(c.codePointAt(0))||gsmExtended.has(c.codePointAt(0)));
  const charCost=c=>gsm?(gsmExtended.has(c.codePointAt(0))?2:1):c.length;
  const costs=keepClusters?Array.from(graphemes.segment(body),({segment})=>Array.from(segment).reduce((sum,c)=>sum+charCost(c),0)):chars.map(charCost);
  const units=costs.reduce((a,b)=>a+b,0),capacity=gsm?153:67;
  let segments=1,used=0;
  if(units>(gsm?160:70))for(const cost of costs){if(cost>capacity)return {encoding:gsm?'GSM-7':'UCS-2',units,segments:Infinity};if(used+cost>capacity){segments++;used=0;}used+=cost;}
  return {encoding:gsm?'GSM-7':'UCS-2',units,segments};
}
function harness({reply=()=>({data:{status:'queued'}}),consentAtRead}={}){
  const calls=[];let reads=0;
  let consent={status:'verified',optedInSid:id(1),verifiedSid:id(1)};
  const client=sms.create({get:async()=>{reads++;return consentAtRead?consentAtRead(reads,consent):consent;},set:async()=>{}});
  global.fetch=async(url,options)=>{
    assert.equal(String(url),`https://api.twilio.com/2010-04-01/Accounts/${cfg.twilioAccountSid}/Messages.json`,'no gateway/guest/fallback request');
    assert.equal(options.method,'POST');
    const form=new URLSearchParams(options.body);
    assert.equal(form.get('MessagingServiceSid'),cfg.twilioMessagingServiceSid);
    assert.equal(form.get('From'),cfg.twilioFrom);
    assert.equal(form.get('To'),cfg.smsTo);
    calls.push(form.get('Body'));
    const value=await reply(calls.length,{optOut(){consent={status:'opted_out'};}});
    return {ok:value.ok??true,status:value.http??201,json:async()=>value.data===null?{}:{sid:id(100+calls.length),...value.data}};
  };
  return {calls,client,reads:()=>reads};
}
function assertBodies(bodies,text){
  assert.ok(bodies.length);
  const chunks=bodies.map((body,i)=>{
    const head=prefix+(bodies.length>1?` (${i+1}/${bodies.length})`:'')+'\n';
    assert.ok(body.startsWith(head),'exact final index/total and full service prefix');
    assert.ok(body.endsWith(footer),'full STOP footer on every part');
    assert.ok(body.length<=306,'complete wire body is at most 306 UTF-16 units, including prefix, numbering and STOP');
    assert.ok(wireCost(body).segments<=4,'final encoded body is at most four carrier segments');
    assert.ok(wireCost(body,true).segments<=4,'still at most four if the carrier keeps grapheme clusters intact');
    const chunk=body.slice(head.length,-footer.length);
    if(text)assert.ok(chunk.length,'no empty numbered chunks');
    return chunk;
  });
  assert.equal(chunks.join(''),text,'lossless exact reconstruction, including all whitespace and Unicode');
  return chunks;
}
async function sendAndCheck(text){
  const h=harness();const result=await h.client.send(cfg,text);
  assert.equal(result.sent,true);
  assert.equal(result.deliveryStatus,'queued','acceptance is not claimed as delivery');
  assert.equal(result.messageIds.length,h.calls.length);
  assert.equal(result.messageId,result.messageIds[0]);
  assert.equal(h.reads(),h.calls.length+1,'initial and fresh per-part consent checks');
  const chunks=assertBodies(h.calls,text);
  return {...h,result,chunks};
}

test('independent encoding oracle recognizes GSM extension costs and Unicode fallback',()=>{
  assert.equal(gsmBasic.size,127);assert.equal(gsmExtended.size,10);
  assert.deepEqual(wireCost('^{}\\[~]|€\f'),{encoding:'GSM-7',units:20,segments:1});
  for(const c of ['`','\t','\x1b','“','中','😀'])assert.equal(wireCost(c).encoding,'UCS-2');
  assert.equal(wireCost('😀').units,2);
  assert.equal(wireCost('a'.repeat(160)).segments,1);
  assert.equal(wireCost('a'.repeat(161)).segments,2);
  assert.equal(wireCost('中'.repeat(70)).segments,1);
  assert.equal(wireCost('中'.repeat(71)).segments,2);
  assert.equal(wireCost('a'.repeat(152)+'^'+'a'.repeat(152)).segments,3,'escape pair cannot straddle a segment');
  assert.equal(wireCost('中'.repeat(66)+'😀'+'中'.repeat(66)).segments,3,'surrogate pair cannot straddle a segment');
  assert.equal(wireCost('中'.repeat(60)+'👨‍👩‍👧‍👦'+'中'.repeat(63),true).segments,3,'ZWJ cluster padding can need an extra segment');
});

for(const [name,text] of [
  ['empty',''],['short ASCII','Staff-only test'],
  ['entire GSM basic alphabet',String.fromCodePoint(...gsmBasic).repeat(12)],
  ['every GSM extended character','^{}\\[~]|€\f'.repeat(80)],
  ['ASCII backticks and tabs','Name\t`value`\r\n'.repeat(60)],
  ['curly quotes and em dash','Q390: “Please don’t omit this.” — Guest\n'.repeat(45)],
  ['CJK','客人問：入住時間是幾點？請保留完整內容。\n'.repeat(70)],
  ['emoji','😀'.repeat(2000)],
  ['ZWJ emoji and modifiers','👩🏽‍💻 👨‍👩‍👧‍👦 🏳️‍🌈 🇺🇸 ✈️\n'.repeat(70)],
  ['combining marks','e\u0301 cafe\u0301\n'.repeat(130)],
  ['newlines and literal envelope text',' \n\r\n\tTennessee Tepees Employee SMS (3/9)\nReply STOP to opt out.\n\n'.repeat(45)],
  ['Unicode switches after long ASCII','A'.repeat(500)+'“'+'B'.repeat(400)+'😀'+'C'.repeat(500)],
  ['former surrogate boundary','x'.repeat(1349)+'😀'+' tail '.repeat(410)],
  ['oversized combining cluster','e'+'\u0301'.repeat(300)+'\nTail.']
])test(`wire budget and exact reconstruction: ${name}`,async()=>{await sendAndCheck(text);});

for(const [name,char,expectedLimit,expectedUnits,expectedSegments] of [
  ['ASCII','a',253,306,2],['GSM extended','^',253,306,4],['CJK','中',215,268,4],['emoji','😀',106,265,4]
]){
  test(`single-body envelope-inclusive boundary: ${name}`,async()=>{
    const fits=body=>body.length<=306&&wireCost(body).segments<=4&&wireCost(body,true).segments<=4;
    let limit=0;while(fits(envelope(char.repeat(limit+1))))limit++;
    assert.equal(limit,expectedLimit,'independent boundary includes both limits and carrier padding');
    const below=await sendAndCheck(char.repeat(limit-1));assert.equal(below.calls.length,1);
    const exact=await sendAndCheck(char.repeat(limit));assert.deepEqual(exact.calls,[envelope(char.repeat(limit))]);
    assert.equal(exact.calls[0].length,expectedUnits);assert.equal(wireCost(exact.calls[0],true).segments,expectedSegments);
    const over=await sendAndCheck(char.repeat(limit+1));assert.equal(over.calls.length,2,'one more scalar requires a numbered split');
    if(name==='ASCII'||name==='GSM extended'){
      const tooLong=envelope(char.repeat(limit+1));
      assert.equal(tooLong.length,307);assert.ok(wireCost(tooLong,true).segments<=4,'segment cap alone would wrongly accept this body');
    }
  });
}

// Message-volume/cost acceptance: the superseded two-segment policy sent 1,500
// CJK units as 21 provider messages / 42 segments. Preserve every unit in 8 / 30.
// Distinguish code-point segment estimates from extra conservative grapheme
// padding; neither is delivery evidence or a provider invoice.
for(const [name,text,messages,segments,maxUnits,envelopeUnits,paddedSegments=segments] of [
  ['basic GSM','x'.repeat(1500),7,13,306,413],
  ['CJK','中'.repeat(1500),8,30,268,472],
  ['astral emoji','😀'.repeat(750),8,30,265,472],
  ['GSM extension','^'.repeat(1500),7,25,306,413],
  ['ZWJ/modifier/flag/combining clusters','👩🏽‍💻e\u0301👨‍👩‍👧‍👦🏳️‍🌈🇺🇸'.repeat(75),12,47,260,723,48]
])test(`lossless operator-volume and carrier-cost regression: ${name}`,async()=>{
  const fixed=await sendAndCheck(text);
  assert.equal(fixed.calls.length,messages,'no avoidable multiplication of provider requests');
  assert.equal(fixed.calls.reduce((sum,body)=>sum+wireCost(body).segments,0),segments,'estimated total carrier segments');
  assert.equal(fixed.calls.reduce((sum,body)=>sum+wireCost(body,true).segments,0),paddedSegments,'conservative grapheme-padded total');
  assert.equal(Math.max(...fixed.calls.map(body=>body.length)),maxUnits);
  assert.equal(fixed.calls.reduce((sum,body)=>sum+body.length,0)-text.length,envelopeUnits,'repeated envelopes are part of the cost');
});

test('ordinary grapheme clusters remain intact across application parts',async()=>{
  const segmenter=new Intl.Segmenter('en',{granularity:'grapheme'});
  const text='👩🏽‍💻e\u0301👨‍👩‍👧‍👦🏳️‍🌈🇺🇸'.repeat(120);
  const {chunks}=await sendAndCheck(text);
  assert.deepEqual(chunks.flatMap(c=>Array.from(segmenter.segment(c),x=>x.segment)),Array.from(segmenter.segment(text),x=>x.segment));
});

test('numbering reaches a deterministic fixed point across 9/10 and 99/100 parts',async()=>{
  for(const boundary of [10,100]){
    // Each single-byte payload fills the assumed numbered envelope exactly.
    // Adding a digit to the true total must trigger a repartition, not an oversized body.
    const oldTotal=boundary-1;
    let text='';
    for(let index=1;index<=oldTotal;index++)text+='x'.repeat(306-envelope('',index,oldTotal).length);
    for(const suffix of ['', 'x']){
      const first=await sendAndCheck(text+suffix);
      assert.equal(first.calls.length,suffix?boundary:oldTotal);
      const second=await sendAndCheck(text+suffix);
      assert.deepEqual(second.calls,first.calls,'same input has identical boundaries and numbering');
    }
  }
});

test('synthetic Q390: old 1350-unit first payload reproduces 22 carrier segments',async()=>{
  // No guest text is copied. A curly quote selects UCS-2 for the entire old body.
  const text='Q390 — Full recent conversation:\n“'+ 'x'.repeat(1500)+'”\nTo answer, text: Q390 then the fact.';
  assert.equal(wireCost(envelope(text.slice(0,1350),1,2)).segments,22);
  const fixed=await sendAndCheck(text);
  assert.equal(fixed.calls.length,7);
  assert.equal(fixed.calls.reduce((sum,body)=>sum+wireCost(body,true).segments,0),17);
  assert.equal(Math.max(...fixed.calls.map(body=>body.length)),306);
  // Fewer requests than the superseded 8/16 policy, but one MORE estimated
  // carrier segment: this balances message volume, not universal cost savings.
});

test('STOP received after first acceptance prevents every remaining part',async()=>{
  const h=harness({reply:(_n,{optOut})=>{optOut();return {data:{status:'queued'}};}});
  const result=await h.client.send(cfg,'“'.repeat(800));
  assert.equal(result.sent,false);assert.equal(result.partial,true);assert.equal(result.uncertain,true);
  assert.equal(result.messageIds.length,1);assert.equal(h.calls.length,1);assert.equal(h.reads(),3);
  assert.match(result.reason,/opted out/);
});

test('STOP between initial readiness and first part prevents all requests',async()=>{
  const h=harness({consentAtRead:(n,c)=>n===1?c:{status:'opted_out'}});
  const result=await h.client.send(cfg,'“'.repeat(800));
  assert.equal(result.sent,false);assert.equal(result.partial,false);assert.equal(result.uncertain,false);
  assert.deepEqual(result.messageIds,[]);assert.equal(h.calls.length,0);assert.equal(h.reads(),2);
});

for(const [name,failure,uncertain] of [
  ['definite HTTP 400',()=>({ok:false,http:400,data:{code:21617}}),false],
  ['provider undelivered',()=>({data:{status:'undelivered',error_code:30019}}),false],
  ['missing receipt',()=>({data:null}),true],
  ['HTTP 503',()=>({ok:false,http:503,data:{code:20500}}),true],
  ['transport timeout',()=>{throw Error('ambiguous socket timeout');},true]
])for(const failAt of [1,2])test(`${name} on part ${failAt}: stop without retry or fallback`,async()=>{
  const h=harness({reply:n=>n===failAt?failure():{data:{status:'queued'}}});
  const result=await h.client.send(cfg,'“'.repeat(800));
  assert.equal(result.sent,false);
  assert.equal(!!result.uncertain,uncertain||failAt>1);
  assert.equal(result.messageIds.length,failAt-1);assert.equal(h.calls.length,failAt);
  assert.equal(result.messageId,failAt>1?id(101):null);
});

test('invalid UTF-16 is refused before any request instead of silently replaced on the wire',async()=>{
  for(const text of ['before\ud800after','before\udc00after','x'.repeat(500)+'\ud800']){
    const h=harness();const result=await h.client.send(cfg,text);
    assert.equal(result.sent,false);assert.equal(h.calls.length,0);assert.match(result.reason,/Unicode/i);
  }
});

test('deterministic mixed-alphabet corpus preserves all content and wire budgets',async()=>{
  let seed=0x390;
  const tokens=['a','^','€','\n','\r\n','“','中','😀','👩🏽‍💻','e\u0301','\t','{',' '];
  for(let run=0;run<40;run++){
    let text='';
    for(let i=0;i<run*13+1;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;text+=tokens[seed%tokens.length];}
    await sendAndCheck(text);
  }
});


// Real app routing/backup/approval code, with an explicitly isolated memory backend
// and environment. The only reachable transports are the in-process fake below.
async function appHarness(){
  const actualRequire=createRequire(new URL('./api/app.js',import.meta.url));
  const context=vm.createContext({module:{exports:{}},Buffer,URL,URLSearchParams,Date,Intl,console,AbortSignal,setTimeout,clearTimeout,
    process:{env:{APP_PASSWORD:'offline-split',APP_PUBLIC_ORIGIN:sms.inboundUrl().split('/api/')[0]}},
    require(name){if(name==='@upstash/redis')throw Error('offline in-memory store');return actualRequire(name);},
    fetch:(...args)=>global.fetch(...args)
  });
  vm.runInContext(readFileSync(new URL('./api/app.js',import.meta.url),'utf8'),context,{filename:'api/app.js'});
  const app=context.module.exports,R=app.__routing;
  const routes={normal:{channel:'email',recipient:'desk@example.com'},complaint:{channel:'sms',recipient:'+15555550102'},backup:{channel:'sms',recipient:'+15555550103'}};
  const saved={...cfg,routes,escalateMins:60,escalationDigest:false,smsGatewayUrl:'https://gateway.invalid/messages',smsUser:'unused',smsPass:'unused',ownerrez_oauth_token:'offline-token',approveSecret:'offline-secret',resendApiKey:'offline-email',from:'Test <test@example.com>'};
  await R.setNotifyRaw(saved);
  global.fetch=async url=>{
    const query=new URL(String(url)).searchParams,phone=query.get('From');
    assert.ok([cfg.smsTo,routes.complaint.recipient,routes.backup.recipient].includes(phone));
    return {ok:true,status:200,json:async()=>({messages:[{account_sid:cfg.twilioAccountSid,sid:id(1),direction:'inbound',from:phone,to:cfg.twilioFrom,body:'START',date_sent:'2026-10-01T12:00:00Z'}]})};
  };
  for(const phone of [cfg.smsTo,routes.complaint.recipient,routes.backup.recipient])await app.__staffSms.employeeSms.verify(cfg,phone);
  const messages=[],guests=[],emails=[];
  let reply=()=>({data:{status:'queued'}});
  global.fetch=async(url,options={})=>{
    const address=String(url);
    if(address==='https://api.resend.com/emails'){
      emails.push(JSON.parse(options.body));return {ok:true,status:200,text:async()=>JSON.stringify({id:'offline-email'})};
    }
    if(address==='https://api.ownerrez.com/v2/messages'){
      guests.push(JSON.parse(options.body));return {ok:true,status:200,text:async()=>'{}'};
    }
    assert.equal(address,`https://api.twilio.com/2010-04-01/Accounts/${cfg.twilioAccountSid}/Messages.json`,'no gateway or unexpected external call');
    assert.equal(options.method,'POST');
    const form=new URLSearchParams(options.body);
    assert.equal(form.get('From'),cfg.twilioFrom);assert.equal(form.get('MessagingServiceSid'),cfg.twilioMessagingServiceSid);
    messages.push({to:form.get('To'),body:form.get('Body')});
    const value=await reply(messages.length);
    return {ok:value.ok??true,status:value.http??201,json:async()=>value.data===null?{}:{sid:id(100+messages.length),...value.data}};
  };
  async function action(name,body={},headers={'x-app-password':'offline-split'}){
    const res={statusCode:200,setHeader(){},status(n){this.statusCode=n;return this;},json(value){this.value=value;return this;},end(value){this.value=value;return this;}};
    await app({method:'POST',url:'/api/app?action='+name,query:{action:name},headers,body},res);
    return res;
  }
  let inboundNumber=500;
  async function inbound(text,from=routes.backup.recipient){
    const body={AccountSid:cfg.twilioAccountSid,MessageSid:id(++inboundNumber),MessagingServiceSid:cfg.twilioMessagingServiceSid,From:from,To:cfg.twilioFrom,Body:text};
    const signature=crypto.createHmac('sha1',cfg.twilioAuthToken).update(sms.inboundUrl()+Object.keys(body).sort().map(k=>k+body[k]).join('')).digest('base64');
    return action('sms_inbound',body,{'x-twilio-signature':signature});
  }
  const item={id:'offline-split-q',smsLabel:'Q501',status:'escalated',thread_id:123,question:'“Full question with context.” '.repeat(50),guest_name:'Offline',ts:new Date(Date.now()-61*60000).toISOString(),primaryNotifiedAt:new Date(Date.now()-61*60000).toISOString()};
  await R.setApprovals([{...item}]);
  return {app,R,saved,routes,messages,guests,emails,action,inbound,item,respond(fn){reply=fn;}};
}
function joinedPayload(messages){
  const bodies=messages.map(m=>m.body);
  const text=bodies.map(body=>body.replace(/^Tennessee Tepees Employee SMS(?: \(\d+\/\d+\))?\n/,'').slice(0,-footer.length)).join('');
  assertBodies(bodies,text);return text;
}

test('saved Twilio routes retain all recipients, normal email and complaint human-only context',async()=>{
  const h=await appHarness(),before=JSON.stringify(await h.R.getNotifyRaw());
  await h.R.sendVictorEscalationSms({},h.item,{});
  assert.equal(h.emails.length,1);assert.equal(h.emails[0].to,h.routes.normal.recipient);assert.equal(h.messages.length,0);
  const complaint=await h.R.sendVictorEscalationSms({},{...h.item,complaint:true},{});
  assert.equal(complaint.sent,true);assert.ok(h.messages.length>2);
  assert.ok(h.messages.every(m=>m.to===h.routes.complaint.recipient));
  const text=joinedPayload(h.messages);
  assert.ok(text.includes(h.item.question.trim()),'full supplied context remains in routed message');
  assert.match(text,/reply directly in OwnerRez/);assert.doesNotMatch(text,/then the fact/);
  h.messages.length=0;
  await h.R.sendVictorEscalationSms({},h.item,{backup:true});
  assert.ok(h.messages.every(m=>m.to===h.routes.backup.recipient));
  assert.match(joinedPayload(h.messages),/To answer, text: Q501 then the fact/);
  assert.equal(h.guests.length,0);assert.equal(JSON.stringify(await h.R.getNotifyRaw()),before,'send never rewrites saved settings');
});

test('generic SMS selector honors saved Twilio/disabled choice without fallback',async()=>{
  const h=await appHarness(),text='Generic staff context “😀” '.repeat(40);
  assert.equal((await h.app.__msg.sendSms(h.routes.backup.recipient,text)).sent,true);
  assert.ok(h.messages.every(m=>m.to===h.routes.backup.recipient));assert.equal(joinedPayload(h.messages),text);
  const before=h.messages.length;
  await h.R.setNotifyRaw({...h.saved,smsProvider:'disabled'});
  assert.equal((await h.app.__msg.sendSms(h.routes.backup.recipient,text)).sent,false);
  assert.equal(h.messages.length,before);assert.equal(h.guests.length,0);assert.equal(h.emails.length,0);
});

test('real backup flow retains partial/ambiguous markers and does not duplicate on the next sweep',async()=>{
  for(const [failAt,failure] of [[2,()=>({ok:false,http:400,data:{code:21617}})],[2,()=>{throw Error('socket timeout');}],[1,()=>({data:null})],[1,()=>({ok:false,http:503,data:{code:20500}})]]){
    const h=await appHarness();h.respond(n=>n===failAt?failure():{data:{status:'queued'}});
    await h.R.escalateStaleApprovals({});
    const [record]=await h.R.getApprovals();
    assert.equal(record.status,'escalated');assert.equal(record.backupAskSent,false);assert.equal(record.backupAskUncertain,true);
    assert.equal(record.backupAskMessageIds.length,failAt-1);assert.equal(h.messages.length,failAt);
    await h.R.escalateStaleApprovals({});
    assert.equal(h.messages.length,failAt,'no duplicate retry after partial or ambiguous transport');assert.equal(h.guests.length,0);
  }
});

test('signed Twilio fact/draft/YES sequence keeps explicit guest approval and duplicate protection',async()=>{
  const h=await appHarness();await h.action('state',{messaging_enabled:true});
  const facts='The pool closes at 10pm. “Please retain the details.” 😀 '.repeat(5);
  assert.equal((await h.inbound('Q501 '+facts)).statusCode,200);
  const [pending]=await h.R.getApprovals();
  assert.equal(pending.status,'pending');assert.ok(pending.proposed);assert.equal(h.guests.length,0,'facts only create a staff draft');
  assert.ok(h.messages.length>1);assert.ok(h.messages.every(m=>m.to===h.routes.backup.recipient));
  assert.match(joinedPayload(h.messages),/Nothing is sent until you reply Q501 yes/);
  const draftParts=h.messages.length;
  await h.inbound('Q501 yes','+15555550999');
  assert.equal(h.guests.length,0);assert.equal(h.messages.length,draftParts,'unknown sender is ignored');
  await h.inbound('Q501 yes');
  assert.equal(h.guests.length,1);assert.equal(h.guests[0].body,pending.proposed);assert.equal((await h.R.getApprovals())[0].status,'approved');
  await h.inbound('Q501 yes');assert.equal(h.guests.length,1,'duplicate approval cannot resend the guest reply');
  await h.R.setApprovals([{...h.item,id:'offline-complaint',complaint:true}]);
  await h.inbound('Q501 yes');assert.equal(h.guests.length,1,'complaints remain human-only');
});
