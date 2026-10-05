import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
process.env.APP_PASSWORD='routing-test';
delete process.env.ANTHROPIC_API_KEY;
const handler=require('./api/app.js');
const r=handler.__routing;
const calls=[];
global.fetch=async(url,options={})=>{
 calls.push({url:String(url),options,body:options.body?JSON.parse(options.body):null});
 if(String(url).includes('/emails/')&&options.method!=='POST') return {ok:true,status:200,json:async()=>({last_event:'delivered'})};
 if(String(url).includes('/messages/')&&options.method!=='POST') return {ok:true,status:200,json:async()=>({state:'Delivered'})};
 const json=String(url).includes('resend')?{id:'email-test-id'}:{id:'sms-test-id',state:'Pending'};
 return {ok:true,status:200,text:async()=>JSON.stringify(json),json:async()=>json};
};
async function action(name,body={},query={}){
 let result,status=200;
 await handler({method:'POST',query:{action:name,...query},headers:{'x-app-password':'routing-test'},body},{setHeader(){},status(v){status=v;return this;},json(v){result=v;return this;},end(v){result=v;return this;},set statusCode(v){status=v;}});
 return {status,result};
}
const base={smsTo:'+15555550100',victorEmail:'owner@example.com',victorEmail2:'backup@example.com',primaryChannel:'email',smsGatewayUrl:'https://api.sms-gate.app/3rdparty/v1/messages',smsUser:'test-user',smsPass:'test-password',resendApiKey:'test-key',from:'Test <test@example.com>',approveSecret:'test-secret',escalateMins:60};
await r.setNotifyRaw(base);
const legacy=await r.getNotifyConfig();
assert.equal(legacy.routes.normal.channel,'sms','deploy must preserve legacy SMS-first actual behavior');
assert.equal(legacy.routes.normal.recipient,base.smsTo);
assert.deepEqual(await r.getNotifyRaw(),base,'read does not migrate saved settings');
const routes={normal:{channel:'email',recipient:'desk@example.com'},complaint:{channel:'sms',recipient:'+15555550101'},backup:{channel:'sms',recipient:'+15555550102'}};
let result=await action('set_notify_config',{routes});assert.equal(result.result.ok,true);
assert.deepEqual((await r.getNotifyConfig()).routes,routes,'save/reload roundtrip');
assert.equal((await r.getNotifyConfig()).escalateMins,60);
result=await action('set_notify_config',{routes:{...routes,normal:{channel:'email',recipient:'broken'}}});assert.equal(result.status,400);assert.deepEqual((await r.getNotifyConfig()).routes,routes,'invalid save is atomic');
assert.deepEqual(r.authorizedSmsNumbers(await r.getNotifyConfig()).sort(),['5555550100','5555550101','5555550102']);
const item={id:'routing-question',smsLabel:'Q501',question:'What time does the pool close?',firstQuestion:'What time does the pool close?',status:'escalated',guest_name:'Test',ts:new Date().toISOString(),primaryNotifiedAt:new Date(Date.now()-61*60000).toISOString()};
await r.setApprovals([{...item}]);
calls.length=0;await r.sendVictorEscalationSms({},item,{});assert.equal(calls.length,1);assert.equal(calls[0].body.to,'desk@example.com');assert.match(calls[0].body.html,/supply_fact/);assert.doesNotMatch(calls[0].body.html,/also gone to Victor/);
calls.length=0;await r.sendVictorEscalationSms({},{...item,complaint:true},{});assert.deepEqual(calls[0].body.phoneNumbers,['+15555550101']);assert.match(calls[0].body.textMessage.text,/reply directly in OwnerRez/);assert.doesNotMatch(calls[0].body.textMessage.text,/then the fact/);
calls.length=0;await r.sendVictorApprovalEmail({},{...item,complaint:true},{});assert.match(calls[0].body.textMessage.text,/reply directly in OwnerRez/);
calls.length=0;await r.escalateStaleApprovals({});assert.deepEqual(calls[0].body.phoneNumbers,['+15555550102']);assert.equal((await r.getApprovals())[0].backupAskSent,true);calls.length=0;await r.escalateStaleApprovals({});assert.equal(calls.length,0,'successful backup one-shot');
// Front-desk fact supply drafts and emails the same recipient, never calls OwnerRez.
await r.setApprovals([{...item}]);calls.length=0;
result=await action('supply_fact',{fact:'The pool closes at 10pm.'},{id:item.id,token:'test-secret',to:'desk@example.com'});
assert.match(result.result,/reply drafted/);assert.equal(calls.length,1);assert.equal(calls[0].body.to,'desk@example.com');assert.match(calls[0].body.html,/Approve & Send/);assert.equal((await r.getApprovals())[0].status,'pending');
// Backup email recipient remains in the form after validation failure.
await action('set_notify_config',{routes:{...routes,backup:{channel:'email',recipient:'alternate@example.com'}}});
await r.setApprovals([{...item}]);result=await action('supply_fact',{fact:''},{id:item.id,token:'test-secret',to:'alternate@example.com'});assert.match(result.result,/to=alternate%40example.com/);
result=await action('supply_fact',{fact:'10pm'},{id:item.id,token:'test-secret',to:'alternate@example.com'});assert.equal(calls.at(-1).body.to,'alternate@example.com');
// SMS facts return the draft to the actual authorized route recipient, not legacy owner.
await action('set_notify_config',{routes});await r.setApprovals([{...item}]);calls.length=0;
result=await action('sms_inbound',{from:'+15555550102',text:'Q501 10pm'},{token:'test-secret'});assert.equal(result.result.escalation_drafted,true);assert.deepEqual(calls.at(-1).body.phoneNumbers,['+15555550102']);assert.match(calls.at(-1).body.textMessage.text,/Nothing is sent until/);assert.ok(calls.every(c=>!c.url.includes('ownerrez')));
calls.length=0;result=await action('sms_inbound',{from:'+15555550999',text:'Q501 yes'},{token:'test-secret'});assert.equal(result.result.ignored,true);assert.equal(calls.length,0);
// Complaint email has conversation and human instructions but no approve/supply controls.
await action('set_notify_config',{routes:{...routes,complaint:{channel:'email',recipient:'manager@example.com'}}});calls.length=0;await r.sendVictorEscalationSms({},{...item,complaint:true},{});assert.equal(calls[0].body.to,'manager@example.com');assert.match(calls[0].body.html,/respond.*directly in OwnerRez/);assert.doesNotMatch(calls[0].body.html,/Approve & Send|Answer this — supply/);
// Safe UI test sends and provider receipt checks: no approval item or guest send.
await action('set_notify_config',{routes});const before=await r.getApprovals();calls.length=0;
for(const key of ['normal','complaint','backup']){
 result=await action('test_notification_route',{route:key});assert.equal(result.result.ok,true);assert.ok(result.result.test.messageId);const check=await action('notification_test_status',{id:result.result.test.id});assert.match(check.result.test.status,/delivered/i);
}
assert.deepEqual(await r.getApprovals(),before);assert.ok(calls.every(c=>!c.url.includes('ownerrez')));
// Disabled automatic backup stays disabled even though old legacy backup email is set.
await action('set_notify_config',{routes:{...routes,backup:{channel:'email',recipient:''}}});await r.setApprovals([{...item}]);calls.length=0;await r.escalateStaleApprovals({});assert.equal(calls.length,0);
console.log('notification routing integration tests passed');
