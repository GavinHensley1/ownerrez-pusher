// Employee-only Twilio transport. No automatic fallback to another provider.
const crypto = require('node:crypto');
const e164 = v => /^\+[1-9]\d{7,14}$/.test(String(v||''));
const sid = (v,prefix) => new RegExp('^'+prefix+'[a-fA-F0-9]{32}$').test(String(v||''));
const keyword = text => {
  const t=String(text||'').trim().toUpperCase();
  if(['START','UNSTOP'].includes(t)) return 'START';
  if(['STOP','STOPALL','UNSUBSCRIBE','CANCEL','END','QUIT','REVOKE','OPTOUT'].includes(t)) return 'STOP';
  if(['HELP','INFO'].includes(t)) return 'HELP';
  return '';
};
function connection(cfg){return !!(sid(cfg.twilioAccountSid,'AC')&&cfg.twilioAuthToken&&sid(cfg.twilioMessagingServiceSid,'MG')&&e164(cfg.twilioFrom));}
function inboundUrl(){return String(process.env.APP_PUBLIC_ORIGIN||'https://project-jvyw3.vercel.app').replace(/\/$/,'')+'/api/app?action=sms_inbound';}
function validate(req,body,cfg){
  if(req.method!=='POST'||!connection(cfg)) return false;
  const signature=String((req.headers||{})['x-twilio-signature']||'');
  if(!signature||body.AccountSid!==cfg.twilioAccountSid||body.To!==cfg.twilioFrom||!sid(body.MessageSid,'(?:SM|MM)')) return false;
  if(body.MessagingServiceSid && body.MessagingServiceSid!==cfg.twilioMessagingServiceSid) return false;
  // Canonical public URL, never an untrusted Host/X-Forwarded-Host header.
  const expected=new URL(inboundUrl());
  const relative=req.url||('/api/app?'+new URLSearchParams(req.query||{}));
  const actual=new URL(relative,expected.origin);
  if(actual.origin!==expected.origin||actual.pathname!==expected.pathname||actual.search!==expected.search) return false;
  let payload=actual.href;
  for(const k of Object.keys(body).sort()){
    if(typeof body[k]!=='string') return false;
    payload+=k+body[k];
  }
  const want=crypto.createHmac('sha1',cfg.twilioAuthToken).update(payload).digest('base64');
  const a=Buffer.from(signature),b=Buffer.from(want);
  return a.length===b.length&&crypto.timingSafeEqual(a,b);
}
function headers(cfg){return {Authorization:'Basic '+Buffer.from(cfg.twilioAccountSid+':'+cfg.twilioAuthToken).toString('base64')};}
async function request(cfg,path,options={}){
  const response=await fetch('https://api.twilio.com/2010-04-01/Accounts/'+cfg.twilioAccountSid+'/'+path,{...options,headers:{...headers(cfg),...(options.headers||{})},signal:AbortSignal.timeout(15000)});
  const data=await response.json().catch(()=>({}));
  return {response,data};
}
async function serviceRequest(cfg,suffix,options={}){
  const response=await fetch('https://messaging.twilio.com/v1/Services/'+cfg.twilioMessagingServiceSid+suffix,{...options,headers:{...headers(cfg),...(options.headers||{})},signal:AbortSignal.timeout(15000)});
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw Error('Twilio service request failed (HTTP '+response.status+(data.code?', code '+data.code:'')+')');
  return data;
}
async function inspect(cfg){
  if(!connection(cfg))throw Error('Save the Twilio account, token, sender and Messaging Service first.');
  const service=await serviceRequest(cfg,'');
  if(service.account_sid!==cfg.twilioAccountSid)throw Error('Messaging Service account mismatch');
  const campaign=await serviceRequest(cfg,'/Compliance/Usa2p');
  const rows=campaign.compliance||campaign.us_app_to_person||campaign.usa2p||[campaign];
  const registrations=Array.isArray(rows)?rows:[rows];
  const verified=registrations.find(x=>x.campaign_status==='VERIFIED'&&x.account_sid===cfg.twilioAccountSid&&x.messaging_service_sid===cfg.twilioMessagingServiceSid&&x.mock!==true);
  const phones=await serviceRequest(cfg,'/PhoneNumbers');
  const sender=(phones.phone_numbers||[]).find(x=>x.phone_number===cfg.twilioFrom&&x.account_sid===cfg.twilioAccountSid);
  const {response,data}=await request(cfg,'IncomingPhoneNumbers.json?'+new URLSearchParams({PhoneNumber:cfg.twilioFrom}));
  if(!response.ok)throw Error('Cannot verify owned Twilio number');
  const owned=(data.incoming_phone_numbers||[]).find(x=>x.phone_number===cfg.twilioFrom&&x.account_sid===cfg.twilioAccountSid);
  return {approved:!!verified,campaignStatus:verified?'VERIFIED':registrations.map(x=>x.campaign_status).filter(Boolean).join(', ')||'unknown',campaignSid:verified?.campaign_id||verified?.sid||null,senderRegistered:!!sender,numberOwned:!!owned,numberSid:owned?.sid||null,voiceUrl:owned?.voice_url||null,voiceMethod:owned?.voice_method||null,inboundUrl:service.inbound_request_url||null,inboundMethod:service.inbound_method||null,useInboundWebhookOnNumber:service.use_inbound_webhook_on_number,ready:!!(verified&&sender&&owned&&service.inbound_request_url===inboundUrl()&&service.inbound_method==='POST'&&service.use_inbound_webhook_on_number===false&&service.us_app_to_person_registered===true)};
}
async function connect(cfg){
  const before=await inspect(cfg);
  if(!before.approved||!before.numberOwned)throw Error('An approved campaign and existing owned sender number are required.');
  // Only Messaging Service settings are written; do not PATCH IncomingPhoneNumbers/voice.
  await serviceRequest(cfg,'',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({InboundRequestUrl:inboundUrl(),InboundMethod:'POST',UseInboundWebhookOnNumber:'false'})});
  if(!before.senderRegistered)await serviceRequest(cfg,'/PhoneNumbers',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({PhoneNumberSid:before.numberSid})});
  const after=await inspect(cfg);
  if(before.voiceUrl!==after.voiceUrl||before.voiceMethod!==after.voiceMethod)throw Error('Voice configuration changed unexpectedly; stop cutover and inspect Twilio.');
  if(!after.ready)throw Error('Twilio connection did not verify after saving.');
  return {...after,voicePreserved:true};
}
function create({get,set,cas}){
  const key=(cfg,phone)=>'parkside:twilio_consent:'+cfg.twilioMessagingServiceSid+':'+cfg.twilioFrom+':'+phone;
  async function consent(cfg,phone){return await get(key(cfg,phone))||{};}
  async function update(cfg,phone,change){
    const k=key(cfg,phone);
    for(let i=0;i<8;i++){
      const old=await consent(cfg,phone),next=change(old);
      if(next===old)return old;
      next.revision=crypto.randomUUID();
      if(cas){if(await cas(k,old.revision||'',next))return next;}
      else {await set(k,next);return next;}
    }
    throw Error('Consent changed during verification. Refresh and try again.');
  }
  async function record(cfg,phone,type,messageSid,at){
    const time=at||new Date().toISOString();
    return update(cfg,phone,old=>{
      if(old.eventAt && Date.parse(old.eventAt)>Date.parse(time)) return old;
      if(old.eventSid===messageSid)return old;
      if(old.eventAt===time&&old.status==='opted_out'&&type==='START')return old;
      const next={...old,phone,eventAt:time,eventSid:messageSid};
      if(type==='START'){next.status='pending_verification';next.optedInAt=time;next.optedInSid=messageSid;delete next.verifiedAt;delete next.verifiedSid;}
      else if(type==='STOP'){next.status='opted_out';next.optedOutAt=time;delete next.verifiedAt;delete next.verifiedSid;}
      else return old;
      return next;
    });
  }
  async function ready(cfg,phone){const c=await consent(cfg,phone);return c.status==='verified'&&!!c.optedInSid&&c.verifiedSid===c.optedInSid;}
  async function send(cfg,text){
    if(!connection(cfg))return {sent:false,provider:'twilio',reason:'Twilio connection is incomplete.'};
    if(!e164(cfg.smsTo))return {sent:false,provider:'twilio',reason:'A valid staff recipient is required.'};
    if(!await ready(cfg,cfg.smsTo))return {sent:false,provider:'twilio',reason:'Staff member must text START and have their identity verified before receiving operational texts.'};
    const chunks=[];let chunk='';for(const char of String(text)){if(chunk.length+char.length>1350){chunks.push(chunk);chunk='';}chunk+=char;}chunks.push(chunk);
    const messageIds=[];
    for(let i=0;i<chunks.length;i++){
      // A fresh consent check for every part prevents continuation after an opt-out.
      if(!await ready(cfg,cfg.smsTo))return {sent:false,provider:'twilio',partial:messageIds.length>0,uncertain:messageIds.length>0,messageIds,reason:'Employee opted out before all parts were sent.'};
      try{
        const body='Tennessee Tepees Employee SMS'+(chunks.length>1?' ('+(i+1)+'/'+chunks.length+')':'')+'\n'+chunks[i]+'\nReply STOP to opt out.';
        const {response,data}=await request(cfg,'Messages.json',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({MessagingServiceSid:cfg.twilioMessagingServiceSid,From:cfg.twilioFrom,To:cfg.smsTo,Body:body})});
        if(!response.ok||!sid(data.sid,'(?:SM|MM)')||['failed','undelivered','canceled'].includes(data.status))return {sent:false,provider:'twilio',partial:messageIds.length>0,uncertain:messageIds.length>0||response.status>=500||(response.ok&&!sid(data.sid,'(?:SM|MM)')),messageIds,messageId:messageIds[0]||null,status:response.status,errorCode:data.error_code||data.code||null,error:'Twilio did not accept every message part'+(data.code?' (code '+data.code+')':'')};
        messageIds.push(data.sid);
        if(i===chunks.length-1)return {sent:true,provider:'twilio',messageId:messageIds[0],messageIds,deliveryStatus:data.status||'accepted',status:response.status};
      }catch(e){return {sent:false,provider:'twilio',uncertain:true,messageIds,messageId:messageIds[0]||null,error:'Twilio send outcome is unconfirmed. Check Twilio logs before retrying.'};}
    }
  }

  async function status(cfg,messageSid){
    if(!sid(messageSid,'(?:SM|MM)'))throw Error('Invalid Twilio message ID');
    const {response,data}=await request(cfg,'Messages/'+messageSid+'.json');
    if(!response.ok)throw Error('Twilio status check returned HTTP '+response.status);
    return {status:data.status,errorCode:data.error_code||null};
  }
  // Synchronize real provider evidence, including a later STOP; never create consent from an assertion.
  async function sync(cfg,phone){
    const query=new URLSearchParams({From:phone,To:cfg.twilioFrom,PageSize:'100'});
    const {response,data}=await request(cfg,'Messages.json?'+query);
    if(!response.ok)throw Error('Unable to read Twilio consent evidence (HTTP '+response.status+')');
    const events=(data.messages||[]).filter(m=>m.direction==='inbound'&&m.account_sid===cfg.twilioAccountSid&&m.from===phone&&m.to===cfg.twilioFrom&&sid(m.sid,'(?:SM|MM)')&&['START','STOP'].includes(keyword(m.body))).sort((a,b)=>Date.parse(b.date_sent||b.date_created)-Date.parse(a.date_sent||a.date_created)||(keyword(b.body)==='STOP'?1:0)-(keyword(a.body)==='STOP'?1:0));
    if(!events.length)throw Error('No recent real START/STOP message found. Employee must text START from their own phone.');
    const m=events[0];return record(cfg,phone,keyword(m.body),m.sid,new Date(m.date_sent||m.date_created).toISOString());
  }
  async function receive(cfg,phone,type,messageSid){
    if(type==='STOP')await record(cfg,phone,'STOP',messageSid);
    const {response,data}=await request(cfg,'Messages/'+messageSid+'.json');
    if(!response.ok||data.account_sid!==cfg.twilioAccountSid||data.from!==phone||data.to!==cfg.twilioFrom||data.direction!=='inbound'||keyword(data.body)!==type)throw Error('Cannot verify inbound consent event.');
    const at=new Date(data.date_sent||data.date_created).toISOString();
    if(type==='STOP'){
      // Replace only this provisional event, then sync to account for a newer real START.
      await update(cfg,phone,old=>old.eventSid===messageSid?{...old,eventAt:at,optedOutAt:at}:old);
      return sync(cfg,phone);
    }
    return record(cfg,phone,type,messageSid,at);
  }
  async function verify(cfg,phone){
    const c=await sync(cfg,phone);
    if(c.status==='opted_out'||!c.optedInSid)throw Error('Employee is opted out or has no START evidence.');
    return update(cfg,phone,old=>{if(old.eventSid!==c.eventSid||old.status==='opted_out')throw Error('Consent changed. Refresh before verifying.');return {...old,status:'verified',verifiedAt:new Date().toISOString(),verifiedSid:c.optedInSid};});
  }
  return {consent,record,ready,send,status,sync,verify,receive};
}
module.exports={create,connection,inboundUrl,validate,keyword,e164,sid,inspect,connect};
