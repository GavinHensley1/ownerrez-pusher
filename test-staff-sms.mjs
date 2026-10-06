// No real network, credentials, phone numbers or provider writes are used by this suite.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
process.env.APP_PASSWORD='staff-test';
process.env.APP_PUBLIC_ORIGIN='https://project-jvyw3.vercel.app';
delete process.env.ANTHROPIC_API_KEY;
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
const sms=require('./api/staff-sms.cjs');
const id=(prefix,n)=>prefix+String(n).padStart(32,'0');
const cfg={smsProvider:'twilio',twilioAccountSid:id('AC',1),twilioAuthToken:'test-only-token',twilioMessagingServiceSid:id('MG',2),twilioFrom:'+15555550100',smsTo:'+15555550101'};
const calls=[];
let respond;
global.fetch=async(url,options={})=>{
 const call={url:String(url),options};calls.push(call);
 if(!respond)throw Error('Unexpected mocked fetch: '+url);
 const value=await respond(call);
 return {ok:value.ok??true,status:value.http??200,json:async()=>value.data??{},text:async()=>JSON.stringify(value.data??{})};
};
const db=new Map();
const client=sms.create({get:async k=>structuredClone(db.get(k)),set:async(k,v)=>db.set(k,structuredClone(v)),cas:async(k,revision,next)=>{if((db.get(k)?.revision||'')!==revision)return false;db.set(k,structuredClone(next));return true;}});
const message=(type,n,at)=>({account_sid:cfg.twilioAccountSid,sid:id('SM',n),direction:'inbound',from:cfg.smsTo,to:cfg.twilioFrom,body:type,date_sent:at});
let evidence=[];
const evidenceResponse=call=>({data:call?.url.match(/\/Messages\/(?:SM|MM)[a-f0-9]{32}\.json$/i)?evidence.find(m=>call.url.endsWith('/'+m.sid+'.json'))||{}:{messages:evidence}});
const sign=body=>crypto.createHmac('sha1',cfg.twilioAuthToken).update(sms.inboundUrl()+Object.keys(body).sort().map(k=>k+body[k]).join('')).digest('base64');
const body={AccountSid:cfg.twilioAccountSid,MessageSid:id('SM',1),MessagingServiceSid:cfg.twilioMessagingServiceSid,From:cfg.smsTo,To:cfg.twilioFrom,Body:'START'};
const request={method:'POST',url:'/api/app?action=sms_inbound',headers:{'x-twilio-signature':sign(body)}};
assert.equal(sms.validate(request,body,cfg),true,'canonical signed webhook accepted');
assert.equal(sms.validate({...request,headers:{'x-twilio-signature':'forged'}},body,cfg),false);
assert.equal(sms.validate(request,{...body,Body:'Q1 yes'},cfg),false,'modified payload cannot reuse signature');
assert.equal(sms.validate({...request,url:'/api/app?action=sms_inbound&unexpected=1'},body,cfg),false);
assert.equal(sms.validate({...request,method:'GET'},body,cfg),false);
assert.equal(sms.keyword('YES'),'','approval word is not enrollment');
for(const word of ['STOP','cancel','UNSUBSCRIBE','REVOKE'])assert.equal(sms.keyword(word),'STOP');

respond=evidenceResponse;
await assert.rejects(()=>client.verify(cfg,cfg.smsTo),/START|evidence/i,'identity assertion alone cannot invent consent');
assert.equal(await client.ready(cfg,cfg.smsTo),false);
calls.length=0;
assert.equal((await client.send(cfg,'unconsented')).sent,false);
assert.equal(calls.length,0,'no message request without consent');
evidence=[message('START',10,'2026-10-06T12:00:00Z')];
await client.sync(cfg,cfg.smsTo);
assert.equal(await client.ready(cfg,cfg.smsTo),false,'actual START still requires identity verification');
await client.verify(cfg,cfg.smsTo);
assert.equal(await client.ready(cfg,cfg.smsTo),true);
calls.length=0;
respond=()=>({data:{sid:id('SM',11),status:'queued'}});
const sent=await client.send(cfg,'Staff-only test');
assert.equal(sent.sent,true);assert.equal(sent.deliveryStatus,'queued','accepted is not delivered');
const form=new URLSearchParams(calls[0].options.body);
assert.equal(form.get('From'),cfg.twilioFrom);assert.equal(form.get('MessagingServiceSid'),cfg.twilioMessagingServiceSid);assert.equal(form.get('To'),cfg.smsTo);
assert.match(form.get('Body'),/Tennessee Tepees Employee SMS/);assert.match(form.get('Body'),/STOP/);
calls.length=0;respond=()=>{throw Error('timeout');};
const uncertain=await client.send(cfg,'do not retry');assert.equal(uncertain.sent,false);assert.equal(uncertain.uncertain,true);assert.equal(calls.length,1,'uncertain outcome does not retry');
assert.ok(calls.every(c=>c.url.startsWith('https://api.twilio.com/')),'no gateway fallback');
// A successful HTTP response without its receipt, or a server error, may hide an accepted send.
for(const response of [{http:201,data:{}},{ok:false,http:503,data:{code:20500}}]){
 calls.length=0;respond=()=>response;
 const ambiguous=await client.send(cfg,'first-part outcome must remain unconfirmed');
 assert.equal(ambiguous.sent,false);
 assert.equal(ambiguous.uncertain,true,'ambiguous first part must retain automatic-backup lock');
 assert.equal(ambiguous.messageIds.length,0);
 assert.equal(calls.length,1,'ambiguous provider response must not retry or fall back');
 assert.ok(calls.every(c=>c.url.startsWith('https://api.twilio.com/')));
}
// Multipart sends preserve all content, including an emoji at a chunk boundary.
const longText='x'.repeat(1349)+'😀'+' tail '.repeat(410);
calls.length=0;let partNumber=0;
respond=()=>({data:{sid:id('SM',100+(++partNumber)),status:'queued'}});
const longResult=await client.send(cfg,longText);
assert.equal(longResult.sent,true);assert.equal(longResult.messageIds.length,calls.length);assert.ok(calls.length>1);
const contents=calls.map(c=>new URLSearchParams(String(c.options.body)).get('Body'));
assert.ok(contents.every(text=>text.length<=1600),'each serialized body respects Twilio limit');
assert.equal(contents.map(text=>text.replace(/^Tennessee Tepees Employee SMS(?: \(\d+\/\d+\))?\n/,'').replace(/\nReply STOP to opt out\.$/,'')).join(''),longText,'no lost content or broken Unicode during multipart serialization');
calls.length=0;partNumber=0;
respond=()=>{if(++partNumber===2)throw Error('ambiguous second part');return {data:{sid:id('SM',120+partNumber),status:'queued'}};};
const partial=await client.send(cfg,longText);
assert.equal(partial.sent,false);assert.equal(partial.uncertain,true);assert.equal(partial.messageIds.length,1);assert.equal(calls.length,2,'no third part or retries after uncertain second part');
calls.length=0;partNumber=0;respond=()=>({data:{sid:id('SM',130+(++partNumber)),status:'queued'}});
await client.send(cfg,'😀'.repeat(2000));
assert.ok(calls.every(c=>new URLSearchParams(String(c.options.body)).get('Body').length<=1600),'emoji-heavy text also respects body length');
respond=evidenceResponse;
evidence=[message('START',10,'2026-10-06T12:00:00Z'),message('STOP',12,'2026-10-06T12:05:00Z')];
await client.sync(cfg,cfg.smsTo);assert.equal(await client.ready(cfg,cfg.smsTo),false,'latest provider STOP wins despite list order');
await assert.rejects(()=>client.verify(cfg,cfg.smsTo),/opted out|START/i);
await client.record(cfg,cfg.smsTo,'START',id('SM',10),'2026-10-06T12:00:00Z');
assert.equal(await client.ready(cfg,cfg.smsTo),false,'delayed START cannot undo newer STOP');
evidence.push(message('START',13,'2026-10-06T12:10:00Z'));
await client.sync(cfg,cfg.smsTo);assert.equal(await client.ready(cfg,cfg.smsTo),false,'new START requires new identity confirmation');
await client.verify(cfg,cfg.smsTo);assert.equal(await client.ready(cfg,cfg.smsTo),true);
// Racing workers cannot overwrite a later STOP with a delayed START.
await Promise.all([
 client.record(cfg,cfg.smsTo,'STOP',id('SM',15),'2026-10-06T12:20:00Z'),
 client.record(cfg,cfg.smsTo,'START',id('SM',14),'2026-10-06T12:15:00Z')
]);
assert.equal(await client.ready(cfg,cfg.smsTo),false);
assert.equal((await client.consent(cfg,cfg.smsTo)).eventSid,id('SM',15));
// A STOP arriving between provider evidence and identity-confirmation CAS must win.
const raceDb=new Map();let injectStop=false;
const racing=sms.create({get:async k=>structuredClone(raceDb.get(k)),set:async(k,v)=>raceDb.set(k,structuredClone(v)),cas:async(k,revision,next)=>{
 if(injectStop&&next.status==='verified'){
  injectStop=false;raceDb.set(k,{...raceDb.get(k),status:'opted_out',eventSid:id('SM',17),eventAt:'2026-10-06T12:30:00Z',revision:'concurrent-stop'});return false;
 }
 if((raceDb.get(k)?.revision||'')!==revision)return false;
 raceDb.set(k,structuredClone(next));return true;
}});
evidence=[message('START',16,'2026-10-06T12:25:00Z')];
await racing.sync(cfg,cfg.smsTo);injectStop=true;
await assert.rejects(()=>racing.verify(cfg,cfg.smsTo),/Consent changed|opted out/);
assert.equal(await racing.ready(cfg,cfg.smsTo),false);
evidence=[message('START',18,'2026-10-06T12:40:00Z'),message('STOP',19,'2026-10-06T12:40:00Z')];
await assert.rejects(()=>client.verify(cfg,cfg.smsTo),/opted out|START/i,'same-second ambiguity gives STOP precedence regardless of provider array order');
assert.equal(await client.ready(cfg,cfg.smsTo),false);

const service={account_sid:cfg.twilioAccountSid,inbound_request_url:sms.inboundUrl(),inbound_method:'POST',use_inbound_webhook_on_number:false,us_app_to_person_registered:true};
const number={account_sid:cfg.twilioAccountSid,phone_number:cfg.twilioFrom,sid:id('PN',3),voice_url:'https://project-jvyw3.vercel.app/api/app?action=voice',voice_method:'POST'};
let campaignStatus='VERIFIED',owned=true,linked=true;
respond=({url,options})=>{
 assert.notEqual(options.method,'POST','inspect is read-only');
 if(url.endsWith('/Compliance/Usa2p'))return {data:{us_app_to_person:[{sid:id('QE',4),campaign_status:campaignStatus,account_sid:cfg.twilioAccountSid,messaging_service_sid:cfg.twilioMessagingServiceSid}]}};
 if(url.endsWith('/PhoneNumbers'))return {data:{phone_numbers:linked?[number]:[]}};
 if(url.includes('/IncomingPhoneNumbers.json?'))return {data:{incoming_phone_numbers:owned?[number]:[]}};
 return {data:service};
};
assert.equal((await sms.inspect(cfg)).ready,true,'real documented us_app_to_person collection recognized');
campaignStatus='IN_PROGRESS';assert.equal((await sms.inspect(cfg)).ready,false);campaignStatus='VERIFIED';
owned=false;assert.equal((await sms.inspect(cfg)).ready,false);owned=true;
linked=false;assert.equal((await sms.inspect(cfg)).ready,false);linked=true;
service.inbound_request_url='https://wrong.example/';assert.equal((await sms.inspect(cfg)).ready,false);service.inbound_request_url=sms.inboundUrl();
service.use_inbound_webhook_on_number=true;assert.equal((await sms.inspect(cfg)).ready,false);service.use_inbound_webhook_on_number=false;
service.us_app_to_person_registered=false;assert.equal((await sms.inspect(cfg)).ready,false);service.us_app_to_person_registered=true;
// Connect changes only this Messaging Service; owned number voice configuration is preserved.
const readResponder=respond;
service.inbound_request_url='';linked=false;calls.length=0;
respond=call=>{
 if(call.options.method!=='POST')return readResponder(call);
 if(call.url.endsWith('/PhoneNumbers')){linked=true;assert.equal(new URLSearchParams(call.options.body).get('PhoneNumberSid'),number.sid);}
 else {assert.equal(call.url,'https://messaging.twilio.com/v1/Services/'+cfg.twilioMessagingServiceSid);service.inbound_request_url=new URLSearchParams(call.options.body).get('InboundRequestUrl');}
 return {data:{}};
};
assert.equal((await sms.connect(cfg)).voicePreserved,true);
assert.ok(calls.filter(c=>c.options.method==='POST').every(c=>c.url.startsWith('https://messaging.twilio.com/v1/Services/')),'no number/voice writes or number purchases');

// Real app boundary: reserved STOP must not become a rejection of a pending guest reply.
const app=require('./api/app.js');
await app.__routing.setNotifyRaw({...cfg,smsGatewayUrl:'https://gateway.invalid/messages',smsUser:'not-used',smsPass:'not-used',approveSecret:'gateway-test',routes:{normal:{channel:'sms',recipient:cfg.smsTo},complaint:{channel:'sms',recipient:cfg.smsTo},backup:{channel:'sms',recipient:cfg.smsTo}}});
const approvals=[{id:'pending',smsLabel:'Q501',status:'pending',question:'test',draft:'must not send',ts:new Date().toISOString()}];
await app.__routing.setApprovals(approvals);
async function inbound(payload,signature=sign(payload),query={}){
 let value,status=200;
 const res={get statusCode(){return status;},set statusCode(v){status=v;},setHeader(){},status(v){status=v;return this;},json(v){value=v;return this;},end(v){value=v;return this;}};
 await app({method:'POST',url:'/api/app?action=sms_inbound',query:{action:'sms_inbound',...query},headers:{'x-twilio-signature':signature},body:payload},res);
 return {status,value};
}
evidence=[message('STOP',21,'2026-10-06T13:00:00Z')];respond=evidenceResponse;calls.length=0;
const stopBody={...body,Body:'STOP',MessageSid:id('SM',21),OptOutType:'STOP'};
assert.equal((await inbound(stopBody)).status,200);
assert.deepEqual(await app.__routing.getApprovals(),approvals,'STOP leaves pending approval untouched');
assert.equal(await app.__staffSms.employeeSms.ready(await app.__routing.getNotifyConfig(),cfg.smsTo),false);
assert.ok(calls.every(c=>c.url.includes('api.twilio.com')&&c.options.method!=='POST'),'STOP sends no app acknowledgment or guest message');
calls.length=0;
assert.equal((await inbound({...body,Body:'Q501 yes'},'forged')).status,403);assert.equal(calls.length,0);
assert.equal((await inbound({from:cfg.smsTo,text:'Q501 yes'},'',{token:'gateway-test'})).status,403,'gateway cannot process approvals after Twilio activation');
assert.deepEqual(await app.__routing.getApprovals(),approvals);
console.log('staff SMS transport, signature, consent, readiness and inbound boundary tests passed');
