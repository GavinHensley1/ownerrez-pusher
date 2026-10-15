import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';
import Module from 'node:module';
import path from 'node:path';

const app=path.resolve('api/app.js');
const htmlPath=path.resolve('index.html');
const source=fs.readFileSync(app,'utf8');
const html=fs.readFileSync(htmlPath,'utf8');
const realRequire=Module.createRequire(app);
const AC='AC'+'3'.repeat(32);
const GA='GA'+'4'.repeat(32);
const SID='RE'+'1'.repeat(32);
const SID2='RE'+'2'.repeat(32);
const CALL='CA'+'5'.repeat(32);
const CALL2='CA'+'6'.repeat(32);
const GT='GT'+'7'.repeat(32);
const GT2='GT'+'8'.repeat(32);
const DATE='2026-10-14';
const ORIGIN='https://project-jvyw3.vercel.app';
const REPORT_PREFIX='parkside-report:v1:';
const REPORT_FORMAT='v1-json-string';
const SDK_ROOT='/Users/gavinsclaude/Library/Application Support/Claude/local-agent-mode-sessions/8afe1cc5-ce70-4b3c-98d9-94499553ba30/244b85b3-c22a-4abe-bd72-9231ac33a9c1/local_ea116717-4032-4cd4-8e8e-2c5845fbacb9/outputs/orp-engine/node_modules/@upstash/redis';

const baseEnv={
  TWILIO_ACCOUNT_SID:AC,
  TWILIO_AUTH_TOKEN:'fixture-token',
  TWILIO_INTELLIGENCE_SERVICE_SID:GA,
  SMS_VICTOR_NUMBER:'+15550001000',
  GAVIN_PASSWORD:'fixture-owner',
  APP_PUBLIC_ORIGIN:ORIGIN
};
const payload={
  AccountSid:AC,
  From:'+15550001000',
  RecordingSid:SID,
  CallSid:CALL,
  RecordingUrl:'https://api.twilio.com/2010-04-01/Accounts/'+AC+'/Recordings/'+SID,
  RecordingStartTime:'2026-10-15T00:30:00Z',
  RecordingDuration:'180',
  RecordingStatus:'completed'
};
const clone=value=>value==null?value:structuredClone(value);
const encodeRedis=value=>typeof value==='string'?value:JSON.stringify(value);
const autoDecode=raw=>{ if(raw==null)return null; try{return JSON.parse(raw);}catch{return raw;} };
const jsonDecode=(raw,fallback)=>{ if(raw==null)return clone(fallback); try{return JSON.parse(raw);}catch{return clone(fallback);} };
const decodeReport=(raw,format)=>raw==null?'':format===REPORT_FORMAT?JSON.parse(raw.slice(REPORT_PREFIX.length)):raw;
const sidOf=value=>(String(value||'').match(/(?:Recordings\/)?(RE[a-zA-Z0-9]{20,})/)||[])[1]||'';
const scalar=value=>value==null?'':typeof value==='boolean'?(value?'1':'0'):String(value);
const entryFields=['id','from','date','at','recordingUrl','recordingSid','callSid','text','status','isVictor','transcriptionError','provider','providerJobSid','persistenceRevision'];
const sameEntry=(a,b)=>entryFields.every(key=>scalar(a&&a[key])===scalar(b&&b[key]));

function twilioSignature(url,body,token=baseEnv.TWILIO_AUTH_TOKEN){
  let material=url;
  for(const key of Object.keys(body||{}).sort()){
    const value=body[key];
    if(Array.isArray(value)){ for(const item of value.map(String).sort()) material+=key+item; }
    else material+=key+String(value==null?'':value);
  }
  return crypto.createHmac('sha1',token).update(material).digest('base64');
}

function fixture(opt={}){
  const raw=new Map();
  for(const [key,value] of Object.entries(opt.initial||{})) raw.set(key,encodeRedis(clone(value)));
  for(const [key,value] of Object.entries(opt.initialRaw||{})) raw.set(key,String(value));
  const calls=[];
  const timeoutDelays=[];
  let clockOffsetMs=0;
  class FixtureDate extends Date{
    constructor(...args){ if(args.length) super(...args); else super(Date.now()+clockOffsetMs); }
    static now(){ return Date.now()+clockOffsetMs; }
  }
  const providers=new Map();
  for(const row of opt.providers||[]) providers.set(row.sourceSid,clone(row));
  const recordings={
    [SID]:{sid:SID,account_sid:AC,call_sid:CALL,duration:'180',status:'completed',date_created:'2026-10-15T00:30:00Z'},
    [SID2]:{sid:SID2,account_sid:AC,call_sid:CALL2,duration:'90',status:'completed',date_created:'2026-10-15T01:30:00Z'},
    ...(opt.recordings||{})
  };
  const callInfo={
    [CALL]:{sid:CALL,account_sid:AC,from:'+15550001000',start_time:'2026-10-15T00:30:00Z'},
    [CALL2]:{sid:CALL2,account_sid:AC,from:'+15550001000',start_time:'2026-10-15T01:30:00Z'},
    ...(opt.callInfo||{})
  };
  const scriptCount={};
  const getObject=key=>autoDecode(raw.get(key));
  const setObject=(key,value)=>raw.set(key,encodeRedis(clone(value)));
  let evalQueue=Promise.resolve();

  function emulateReserve(keys,args){
    const [jobKey,tombKey]=keys, tomb=getObject(tombKey);
    if(tomb&&tomb.status==='deleted') return JSON.stringify({ok:false,conflict:'deleted',revision:tomb.revision});
    const existing=getObject(jobKey); if(existing)return JSON.stringify({ok:true,created:false,job:existing});
    const job=JSON.parse(args[0]); job.protectionRevision=tomb&&tomb.revision||''; setObject(jobKey,job);
    return JSON.stringify({ok:true,created:true,job});
  }
  function emulateJobCas(keys,args){
    const [jobKey,tombKey]=keys, current=getObject(jobKey), tomb=getObject(tombKey);
    if(!current)return JSON.stringify({ok:false,conflict:'job_missing'});
    if(current.revision!==args[0])return JSON.stringify({ok:false,conflict:'job_changed'});
    if(tomb&&tomb.status==='deleted')return JSON.stringify({ok:false,conflict:'deleted',revision:tomb.revision});
    const protection=tomb&&tomb.revision||''; if(String(current.protectionRevision||'')!==protection)return JSON.stringify({ok:false,conflict:'protection_changed'});
    const next=JSON.parse(args[1]); next.protectionRevision=protection;
    if(opt.deleteDuringCompletedJobCas&&next.status==='completed'&&!opt.deletedDuringCas){
      opt.deletedDuringCas=true; const rev='delete-race-revision';
      setObject(tombKey,{version:1,status:'deleted',revision:rev,recordingSid:current.recordingSid,entry:getObject('parkside:calllog')?.[0]||null});
      current.revision=rev; current.protectionRevision=rev; current.blockedByDeletion=true; setObject(jobKey,current);
      return JSON.stringify({ok:false,conflict:'deleted',revision:rev});
    }
    setObject(jobKey,next); return JSON.stringify({ok:true,job:next});
  }
  function emulateUpsert(keys,args){
    const [logKey,reportKey,receiptKey,tombKey,jobKey,formatKey]=keys;
    const [metaRaw,expectedRaw,expectedFoundRaw,expectedReport,allowLegacyRaw,prefix,jobRevision,formatName]=args;
    const meta=JSON.parse(metaRaw), expected=JSON.parse(expectedRaw), expectedFound=expectedFoundRaw==='1';
    const tomb=getObject(tombKey), job=getObject(jobKey);
    if(tomb&&tomb.status==='deleted')return JSON.stringify({ok:false,conflict:'deleted',revision:tomb.revision});
    if(!job||job.revision!==jobRevision)return JSON.stringify({ok:false,conflict:'job_changed'});
    if(String(job.protectionRevision||'')!==String(tomb&&tomb.revision||''))return JSON.stringify({ok:false,conflict:'protection_changed'});
    const log=clone(getObject(logKey)||[]); if(!Array.isArray(log))return JSON.stringify({ok:false,error:'invalid_call_log'});
    const report=decodeReport(raw.get(reportKey),raw.get(formatKey));
    const receipt=clone(getObject(receiptKey));
    const index=log.findIndex(row=>String(row.recordingSid||sidOf(row.recordingUrl))===meta.recordingSid), found=index>=0?log[index]:null;
    if(Boolean(found)!==expectedFound)return JSON.stringify({ok:false,conflict:'call_changed'});
    if(found&&!sameEntry(found,expected))return JSON.stringify({ok:false,conflict:'call_changed'});
    const entry=found||{id:meta.recordingSid};
    for(const field of ['from','date','at','recordingUrl','recordingSid','callSid'])if(!entry[field])entry[field]=meta[field]||'';
    if(entry.isVictor==null)entry.isVictor=meta.isVictor===true;
    entry.provider=meta.provider||''; entry.providerJobSid=meta.providerJobSid||'';
    if(!String(entry.text||'')&&String(meta.text||''))entry.text=String(meta.text); else entry.text=String(entry.text||'');
    if(entry.text){entry.status='completed';delete entry.transcriptionError;}else{entry.status=meta.status||entry.status||'failed';if(meta.transcriptionError)entry.transcriptionError=meta.transcriptionError;}
    entry.persistenceRevision=meta.persistenceRevision;
    if(index<0)log.unshift(entry);else log[index]=entry; log.splice(500);
    let nextReport=report,nextReceipt=receipt,disposition='no_text',writeReport=false;
    if(entry.isVictor&&entry.text){
      if(receipt&&receipt.status==='completed')disposition='already_materialized';
      else{
        if(report!==expectedReport)return JSON.stringify({ok:false,conflict:'report_changed'});
        const padded='\n\n'+report+'\n\n', legacy=allowLegacyRaw==='1'&&(report===entry.text||padded.includes('\n\n'+entry.text+'\n\n')||padded.includes('\n\n[call] '+entry.text+'\n\n'));
        if(legacy)disposition='existing_legacy';else{nextReport=report?report+'\n\n[call] '+entry.text:entry.text;disposition='appended';writeReport=true;}
        nextReceipt={version:1,status:'completed',recordingSid:meta.recordingSid,date:entry.date,entryId:entry.id,textLength:Buffer.byteLength(entry.text),textDigest:meta.textDigest,reportDisposition:disposition,materializedAt:meta.persistedAt,source:meta.source};
      }
    }else if(entry.isVictor)nextReceipt={version:1,status:entry.status,recordingSid:meta.recordingSid,date:entry.date,entryId:entry.id,error:entry.transcriptionError||'',updatedAt:meta.persistedAt,source:meta.source};
    else{disposition='not_victor';nextReceipt={version:1,status:entry.text?'completed':entry.status,recordingSid:meta.recordingSid,date:entry.date,entryId:entry.id,reportDisposition:disposition};}
    if(opt.failCompletedUpsertOnce&&entry.text&&!opt.failedCompletedUpsert){opt.failedCompletedUpsert=true;throw Error('fixture completed upsert failure');}
    setObject(logKey,log);setObject(receiptKey,nextReceipt);if(writeReport){raw.set(reportKey,prefix+JSON.stringify(nextReport));raw.set(formatKey,formatName);}
    return JSON.stringify({ok:true,entry,receipt:nextReceipt,reportDisposition:disposition,reportWritten:writeReport});
  }
  function emulateDelete(keys,args){
    const [logKey,tombKey,jobKey]=keys, log=clone(getObject(logKey)||[]), selector=args[0], recSid=args[1], rev=args[2], at=args[3];
    const matches=log.filter(c=>String(c.id||'')===selector||String(c.at||'')===selector); if(matches.length!==1)return JSON.stringify({ok:false,conflict:matches.length?'ambiguous':'not_found'});
    const entry=matches[0]; if(String(entry.recordingSid||sidOf(entry.recordingUrl))!==recSid)return JSON.stringify({ok:false,conflict:'recording_changed'});
    const next=log.filter(c=>c!==entry); raw.set(logKey,next.length?JSON.stringify(next):'[]'); setObject(tombKey,{version:1,status:'deleted',revision:rev,recordingSid:recSid,deletedAt:at,entry});
    const job=getObject(jobKey); if(job){job.revision=rev;job.protectionRevision=rev;job.blockedByDeletion=true;job.deletionRevision=rev;job.updatedAt=at;setObject(jobKey,job);}
    return JSON.stringify({ok:true,deleted:1,remaining:next.length,recordingSid:recSid,restoreRevision:rev});
  }
  function emulateRestore(keys,args){
    const [logKey,tombKey,jobKey]=keys, [recSid,expected,newRev,at]=args, tomb=getObject(tombKey);
    if(!tomb||tomb.status!=='deleted'||tomb.revision!==expected)return JSON.stringify({ok:false,conflict:'tombstone_changed'});
    const log=clone(getObject(logKey)||[]); if(log.some(c=>String(c.recordingSid||sidOf(c.recordingUrl))===recSid))return JSON.stringify({ok:false,conflict:'already_restored'});
    log.unshift(clone(tomb.entry));setObject(logKey,log);tomb.status='restored';tomb.revision=newRev;tomb.restoredAt=at;setObject(tombKey,tomb);
    const job=getObject(jobKey);if(job){job.revision=newRev;job.protectionRevision=newRev;job.blockedByDeletion=false;job.updatedAt=at;setObject(jobKey,job);}
    return JSON.stringify({ok:true,recordingSid:recSid,revision:newRev,job});
  }

  class Redis{
    constructor(config={}){if(opt.noRedis)throw Error('store unavailable');this.raw=config.automaticDeserialization===false;}
    async get(key){if(opt.failReadKey===key)throw Error('fixture read failure');const value=raw.get(key);return this.raw?(value??null):clone(autoDecode(value));}
    async set(key,value,options){if(options&&options.nx&&raw.has(key))return null;raw.set(key,encodeRedis(value));return 'OK';}
    async mset(values){for(const [key,value] of Object.entries(values||{}))raw.set(key,encodeRedis(value));return 'OK';}
    async del(key){return raw.delete(key)?1:0;}
    async zrange(){return [];}
    async eval(script,keys,args){
      const marker=(String(script).match(/-- ([^\n]+)/)||[])[1]||'unknown';scriptCount[marker]=(scriptCount[marker]||0)+1;
      const run=evalQueue.then(async()=>{
        if(marker==='victor-transcript-job-reserve-v1')return emulateReserve(keys,args);
        if(marker==='victor-transcript-job-cas-v1'){
          const next=JSON.parse(args[1]);
          if(opt.failSubmittingCasBeforeCommit&&!opt.failedSubmittingCas&&next.submissionState==='submitting'){opt.failedSubmittingCas=true;throw Error('fixture CAS unavailable');}
          return emulateJobCas(keys,args);
        }
        if(marker==='victor-transcript-upsert-v3')return emulateUpsert(keys,args);
        if(marker==='victor-call-delete-v2')return emulateDelete(keys,args);
        if(marker==='victor-call-restore-v1')return emulateRestore(keys,args);
        if(marker==='victor-call-move-v1')return JSON.stringify({found:false,from:'',to:args[1]});
        throw Error('unexpected fixture eval '+marker);
      });evalQueue=run.catch(()=>{});const result=await run;if(opt.afterEval)await opt.afterEval(marker,keys,args,result,{advanceMs(ms){clockOffsetMs+=Number(ms)||0;},now(){return FixtureDate.now();}});return result;
    }
  }

  const env={...baseEnv,...opt.env};
  const context=vm.createContext({
    module:{exports:{}},exports:{},require:id=>id==='@upstash/redis'?{Redis}:realRequire(id),__dirname:path.dirname(app),__filename:app,process:{env},
    Buffer,Response,URLSearchParams,URL,Date:FixtureDate,Math,console,setTimeout:(fn,delay,...args)=>{timeoutDelays.push(Number(delay));return setTimeout(fn,delay,...args);},clearTimeout,AbortController,AbortSignal,structuredClone,
    fetch:async(url,options={})=>{
      const target=String(url), method=String(options.method||'GET').toUpperCase();
      const recMatch=target.match(/\/Recordings\/(RE[A-Za-z0-9]+)\.json/);
      if(recMatch){calls.push({kind:'recording',url:target});const row=clone(recordings[recMatch[1]]);return new Response(JSON.stringify(row||{}),{status:row?200:404,headers:{'content-type':'application/json'}});}
      const callMatch=target.match(/\/Calls\/(CA[A-Za-z0-9]+)\.json/);
      if(callMatch){calls.push({kind:'call',url:target});const row=clone(callInfo[callMatch[1]]);return new Response(JSON.stringify(row||{}),{status:row?200:404,headers:{'content-type':'application/json'}});}
      if(target.startsWith('https://intelligence.twilio.com/v2/Transcripts?')){
        calls.push({kind:'list',url:target});const u=new URL(target), recSid=u.searchParams.get('SourceSid'), rows=[];const p=providers.get(recSid);if(p)rows.push(clone(p));
        return new Response(JSON.stringify({transcripts:rows,meta:{next_page_url:null}}),{status:200,headers:{'content-type':'application/json'}});
      }
      if(target==='https://intelligence.twilio.com/v2/Transcripts'&&method==='POST'){
        const form=new URLSearchParams(String(options.body||'')), recSid=JSON.parse(form.get('Channel')).media_properties.source_sid, n=calls.filter(x=>x.kind==='create').length+1, gt=n===1?GT:GT2;
        calls.push({kind:'create',url:target,serviceSid:form.get('ServiceSid'),customerKey:form.get('CustomerKey'),sourceSid:recSid,hasTimeoutSignal:!!options.signal});
        if(opt.beforeCreate) await opt.beforeCreate(n,options);
        const row={sid:gt,account_sid:AC,service_sid:GA,channel:{media_properties:{source_sid:recSid}},customer_key:form.get('CustomerKey'),status:'queued'};
        if(!opt.createUnknown||opt.createVisibleAfterUnknown)providers.set(recSid,clone(row));
        if(opt.createUnknown&&n===1)throw Error('fixture response lost after provider accepted request');
        providers.set(recSid,clone(row));return new Response(JSON.stringify(row),{status:201,headers:{'content-type':'application/json'}});
      }
      const sentenceMatch=target.match(/\/v2\/Transcripts\/(GT[A-Za-z0-9]+)\/Sentences/);
      if(sentenceMatch){
        calls.push({kind:'sentences',url:target});const gt=sentenceMatch[1], u=new URL(target), second=u.searchParams.get('PageToken')==='two';
        const rows=second?[{transcript_sid:gt,sentence_index:2,transcript:'Second complete sentence Ω.'}]:[{transcript_sid:gt,sentence_index:1,transcript:'First complete sentence.'}];
        const next=second?null:'https://intelligence.twilio.com/v2/Transcripts/'+gt+'/Sentences?PageSize=5000&PageToken=two';
        return new Response(JSON.stringify({sentences:rows,meta:{next_page_url:next}}),{status:200,headers:{'content-type':'application/json'}});
      }
      const gtMatch=target.match(/\/v2\/Transcripts\/(GT[A-Za-z0-9]+)$/);
      if(gtMatch){
        calls.push({kind:'transcript',url:target});let row=[...providers.values()].find(x=>x.sid===gtMatch[1]);if(row&&opt.mutateTranscript)row=opt.mutateTranscript(clone(row));
        return new Response(JSON.stringify(row||{}),{status:row?200:404,headers:{'content-type':'application/json'}});
      }
      throw Error('Unexpected fixture URL '+target);
    }
  });
  vm.runInContext(source,context,{filename:app});

  async function request(body={},action='voice_recording',requestOpt={}){
    const query={action,...(requestOpt.query||{})}, qs=new URLSearchParams(query).toString(), url='/api/app?'+qs, method=requestOpt.method||'POST';
    const headers={...(requestOpt.headers||{})};
    if(requestOpt.sign!==false&&['voice_recording','voice_transcription','voice_intelligence'].includes(action))headers['x-twilio-signature']=twilioSignature(ORIGIN+url,body,env.TWILIO_AUTH_TOKEN);
    if(action==='voice_intelligence'){
      const gt=String(body.transcript_sid||body.TranscriptSid||''), provider=[...providers.values()].find(row=>String(row.sid||'')===gt);
      if(provider)provider.status=String(opt.providerStatusOnCallback||'completed');
    }
    const out={status:0,body:null,headers:{}};
    const res={statusCode:200,setHeader(k,v){out.headers[String(k).toLowerCase()]=v;},status(code){this.statusCode=code;out.status=code;return this;},end(value){out.status=out.status||this.statusCode;out.body=String(value||'');return this;},json(value){out.status=out.status||this.statusCode;out.body=clone(value);return this;}};
    await context.module.exports({query,body,headers,method,url,originalUrl:url},res);return out;
  }
  return {raw,calls,providers,request,handler:context.module.exports,env,value:getObject,scriptCount,timeoutDelays};
}

let passed=0;
async function test(name,fn){await fn();passed++;console.log('PASS '+passed+' '+name);}
const count=(f,kind)=>f.calls.filter(x=>x.kind===kind).length;
const ownerHeaders={'x-gavin-password':baseEnv.GAVIN_PASSWORD,'content-type':'application/json'};
const intelligenceBody=(sid=SID,gt=GT)=>({account_sid:AC,service_sid:GA,transcript_sid:gt,customer_key:'victor-report:'+sid,event_type:'voice_intelligence_transcript_available'});

function assertLuaHasNoLiteralLineBreakInShortString(script){
  let quote=null,comment=false;
  for(let i=0;i<script.length;i++){
    const ch=script[i], next=script[i+1];
    if(comment){if(ch==='\n')comment=false;continue;}
    if(!quote&&ch==='-'&&next==='-'){comment=true;i++;continue;}
    if(!quote&&(ch==="'"||ch==='"')){quote=ch;continue;}
    if(quote){if(ch==='\\'){i++;continue;}if(ch===quote){quote=null;continue;}assert.notEqual(ch,'\n','literal LF inside Lua short string');assert.notEqual(ch,'\r','literal CR inside Lua short string');}
  }
  assert.equal(quote,null,'unterminated Lua short string');
}

await test('B1 emits String.raw Lua without literal line breaks in short strings',async()=>{
  const f=fixture(), scripts=['CALL_UPSERT_LUA','CALL_JOB_RESERVE_LUA','CALL_JOB_CAS_LUA','CALL_DELETE_LUA','CALL_RESTORE_LUA'];
  for(const name of scripts){const script=f.handler.__calls[name];assert.equal(typeof script,'string');assertLuaHasNoLiteralLineBreakInShortString(script);}
  assert.match(source,/CALL_UPSERT_LUA=String\.raw/);assert.doesNotMatch(source,/victor-transcript-lease/);
});

await test('signed recording callback submits one Classic CI job by RecordingSid',async()=>{
  const f=fixture();const r=await f.request({...payload});assert.equal(r.status,200);assert.equal(count(f,'create'),1);assert.equal(count(f,'recording'),1);assert.equal(count(f,'call'),1);
  const create=f.calls.find(x=>x.kind==='create');assert.equal(create.serviceSid,GA);assert.equal(create.sourceSid,SID);assert.equal(create.customerKey,'victor-report:'+SID);
  const job=f.value('parkside:calljob:'+SID);assert.equal(job.transcriptSid,GT);assert.equal(job.submissionState,'submitted');assert.equal(f.value('parkside:calllog')[0].recordingSid,SID);
  assert.equal(count(f,'audio'),0);assert.doesNotMatch(source,/GROQ_API_KEY|OPENAI_API_KEY|audio\/transcriptions/);
});

await test('missing or invalid Twilio signatures fail closed before reads, writes, or provider work',async()=>{
  for(const mode of ['missing','invalid']){const f=fixture();const headers=mode==='invalid'?{'x-twilio-signature':'invalid'}:{};const r=await f.request({...payload},'voice_recording',{sign:false,headers});assert.equal(r.status,403);assert.equal(f.calls.length,0);assert.equal(f.raw.size,0);}
});

await test('callback and provider account/service/source provenance fail closed',async()=>{
  const badAccount={...payload,AccountSid:'AC'+'9'.repeat(32)};const a=fixture();const ar=await a.request(badAccount);assert.equal(ar.status,400);assert.equal(count(a,'create'),0);
  const pending=fixture({recordings:{[SID]:{sid:SID,account_sid:AC,call_sid:CALL,duration:'180',status:'processing',date_created:'2026-10-15T00:30:00Z'}}});const pr=await pending.request({...payload});assert.equal(pr.status,503);assert.equal(count(pending,'create'),0);
  const f=fixture();await f.request({...payload});f.providers.get(SID).service_sid='GA'+'9'.repeat(32);const r=await f.request(intelligenceBody(),'voice_intelligence');assert.equal(r.status,400);assert.equal(String(f.value('parkside:calllog')[0].text||''),'');
});

await test('B2 full paginated sentences are durable before one-time call/report materialization',async()=>{
  const f=fixture();await f.request({...payload});const r=await f.request(intelligenceBody(),'voice_intelligence');assert.equal(r.status,204);assert.equal(count(f,'sentences'),2);
  const text='First complete sentence.\nSecond complete sentence Ω.';assert.equal(f.value('parkside:calljob:'+SID).text,text);assert.equal(f.value('parkside:calllog')[0].text,text);assert.equal(decodeReport(f.raw.get('parkside:report:'+DATE),f.raw.get('parkside:report-format:'+DATE)),text);assert.equal(count(f,'create'),1);
  const again=await f.request(intelligenceBody(),'voice_intelligence');assert.equal(again.status,204);assert.equal(count(f,'create'),1);assert.equal(decodeReport(f.raw.get('parkside:report:'+DATE),f.raw.get('parkside:report-format:'+DATE)),text);
});

await test('B2 pending provider metadata never reads sentences or materializes partial text',async()=>{
  const f=fixture({providerStatusOnCallback:'in-progress'});await f.request({...payload});const r=await f.request(intelligenceBody(),'voice_intelligence');assert.equal(r.status,503);assert.equal(count(f,'sentences'),0);
  const job=f.value('parkside:calljob:'+SID), entry=f.value('parkside:calllog')[0];assert.equal(job.providerStatus,'in-progress');assert.notEqual(job.status,'completed');assert.equal(String(job.text||''),'');assert.equal(String(entry.text||''),'');assert.equal(f.raw.has('parkside:report:'+DATE),false);
});

await test('B2 completed provider text survives report persistence failure and resumes without retranscription',async()=>{
  const f=fixture({failCompletedUpsertOnce:true});await f.request({...payload});const first=await f.request(intelligenceBody(),'voice_intelligence');assert.equal(first.status,503);assert.equal(f.value('parkside:calljob:'+SID).status,'completed');assert.equal(count(f,'create'),1);
  const second=await f.request(intelligenceBody(),'voice_intelligence');assert.equal(second.status,204);assert.equal(count(f,'create'),1);assert.match(decodeReport(f.raw.get('parkside:report:'+DATE),f.raw.get('parkside:report-format:'+DATE)),/Second complete sentence/);
});

await test('B2 uncertain provider create resolves by exact service/source and never auto-replays',async()=>{
  const f=fixture({createUnknown:true,createVisibleAfterUnknown:true});const first=await f.request({...payload});assert.equal(first.status,200);assert.equal(count(f,'create'),1);assert.equal(count(f,'list'),1);assert.equal(f.value('parkside:calljob:'+SID).transcriptSid,GT);
  await f.request({...payload});assert.equal(count(f,'create'),1);
  const unresolved=fixture({createUnknown:true,createVisibleAfterUnknown:false});assert.equal((await unresolved.request({...payload})).status,503);assert.equal((await unresolved.request({...payload})).status,200);assert.equal(count(unresolved,'create'),1);assert.equal(unresolved.value('parkside:calljob:'+SID).submissionState,'uncertain');
  const preview=await unresolved.request({recordingSid:SID},'calls_reconcile',{headers:ownerHeaders,sign:false});assert.equal(preview.status,200);assert.equal(preview.body.preview.nextOperation,'pending');assert.equal(preview.body.preview.submissionFenced,true);assert.equal(count(unresolved,'create'),1);
});

await test('B2 storage uncertainty before submission blocks the paid provider request',async()=>{
  const f=fixture({failSubmittingCasBeforeCommit:true});const r=await f.request({...payload});assert.equal(r.status,503);assert.equal(count(f,'create'),0);assert.equal(f.value('parkside:calljob:'+SID).submissionState,'not_started');
});

await test('P1 active submission fence stays pending and cannot be owner-reset into a second create',async()=>{
  let releaseCreate,startCreate;const started=new Promise(resolve=>{startCreate=resolve;}), gate=new Promise(resolve=>{releaseCreate=resolve;});
  const f=fixture({beforeCreate:async n=>{if(n===1){startCreate();await gate;}}});
  const original=f.request({...payload});await started;
  const preview=await f.request({recordingSid:SID},'calls_reconcile',{headers:ownerHeaders,sign:false});assert.equal(preview.status,200);assert.equal(preview.body.preview.nextOperation,'pending');assert.equal(preview.body.preview.submissionActive,true);
  const blocked=await f.request({recordingSid:SID,confirmation:preview.body.preview.confirmation,operation:'pending'},'calls_reconcile',{headers:ownerHeaders,sign:false});assert.equal(blocked.status,503);assert.equal(blocked.body.code,'CALL_PROVIDER_PENDING');assert.equal(count(f,'create'),1);
  const activeJob=f.value('parkside:calljob:'+SID);assert.equal(Date.parse(activeJob.submissionDeadlineAt)-Date.parse(activeJob.submissionStartedAt),30000);assert.equal(f.calls.find(x=>x.kind==='create').hasTimeoutSignal,true);
  releaseCreate();assert.equal((await original).status,200);assert.equal(count(f,'create'),1);assert.equal(f.value('parkside:calljob:'+SID).submissionState,'submitted');
});

await test('P1 absolute submission deadline includes delayed CAS acknowledgment and an expired acknowledgment cannot launch',async()=>{
  const delaySubmittingAck=ms=>{let advanced=false;return async(marker,keys,args,result,clock)=>{const next=marker==='victor-transcript-job-cas-v1'?JSON.parse(args[1]):null;if(!advanced&&next&&next.submissionState==='submitting'){advanced=true;clock.advanceMs(ms);}};};
  const delayed=fixture({afterEval:delaySubmittingAck(2500)});const sent=await delayed.request({...payload});assert.equal(sent.status,200);assert.equal(count(delayed,'create'),1);assert.equal(delayed.timeoutDelays.length,1);assert.ok(delayed.timeoutDelays[0]>26000&&delayed.timeoutDelays[0]<29000,'provider timeout must use only the durable deadline remainder');
  const expired=fixture({afterEval:delaySubmittingAck(30001)});const blocked=await expired.request({...payload});assert.equal(blocked.status,503);assert.equal(count(expired,'create'),0);assert.equal(expired.timeoutDelays.length,0);
  const expiredJob=expired.value('parkside:calljob:'+SID);assert.equal(expiredJob.submissionState,'failed');assert.match(expiredJob.providerError,/not launched.*durable submission deadline/i);
  const preview=await expired.request({recordingSid:SID},'calls_reconcile',{headers:ownerHeaders,sign:false});assert.equal(preview.status,200);assert.equal(preview.body.preview.submissionActive,false);assert.equal(preview.body.preview.nextOperation,'retry_submission');assert.equal(count(expired,'list'),1);assert.equal(count(expired,'create'),0);
});

await test('P1 stale submission requires exact owner confirmation after reconciliation before one retry',async()=>{
  const f=fixture({createUnknown:true,createVisibleAfterUnknown:false});assert.equal((await f.request({...payload})).status,503);assert.equal(count(f,'create'),1);
  const stale=f.value('parkside:calljob:'+SID);stale.status='submitting';stale.submissionState='submitting';stale.submissionDeadlineAt='2026-01-01T00:00:00.000Z';stale.submissionFinishedAt='';f.raw.set('parkside:calljob:'+SID,JSON.stringify(stale));
  assert.equal((await f.request({...payload})).status,503);assert.equal(count(f,'create'),1);
  const preview=await f.request({recordingSid:SID},'calls_reconcile',{headers:ownerHeaders,sign:false});assert.equal(preview.status,200);assert.equal(preview.body.preview.submissionActive,false);assert.equal(preview.body.preview.nextOperation,'retry_submission');
  const retry=await f.request({recordingSid:SID,confirmation:preview.body.preview.confirmation,operation:'retry_submission'},'calls_reconcile',{headers:ownerHeaders,sign:false});assert.equal(retry.status,200);assert.equal(retry.body.pending,true);assert.equal(count(f,'create'),2);assert.ok(f.value('parkside:calljob:'+SID).ownerRetryAuthorizedAt);
});

await test('P1 completed legacy row and raw report adopt into durable job and receipt without provider create',async()=>{
  const manualDate='2026-10-12', text='  Existing completed owner transcript Ω.\nSecond line.  ', grade={score:5,by:'gavin'};
  const entry={id:SID,recordingSid:SID,callSid:CALL,recordingUrl:payload.RecordingUrl,from:payload.From,date:manualDate,at:'2026-10-12T23:30:00Z',isVictor:true,status:'completed',text};
  const f=fixture({initial:{'parkside:calllog':[entry],['parkside:grade:'+manualDate]:grade},initialRaw:{['parkside:report:'+manualDate]:text}});const r=await f.request({...payload});assert.equal(r.status,200);assert.equal(count(f,'create'),0);
  const job=f.value('parkside:calljob:'+SID), receipt=f.value('parkside:callreceipt:'+SID), stored=f.value('parkside:calllog')[0];assert.equal(job.status,'completed');assert.equal(job.submissionState,'completed');assert.equal(job.text,text);assert.equal(job.materializationSource,'existing_completed_call');assert.equal(receipt.status,'completed');assert.equal(receipt.reportDisposition,'existing_legacy');
  assert.equal(stored.date,manualDate);assert.equal(stored.text,text);assert.equal(f.raw.get('parkside:report:'+manualDate),text);assert.deepEqual(f.value('parkside:grade:'+manualDate),grade);
});

await test('P1 exact-SID owner recovery previews materialization and adopts completed legacy text without provider create',async()=>{
  const manualDate='2026-10-12', text='  Existing completed owner transcript Ω.\nSecond line.  ', grade={score:5,by:'gavin'};
  const entry={id:SID,recordingSid:SID,callSid:CALL,recordingUrl:payload.RecordingUrl,from:payload.From,date:manualDate,at:'2026-10-12T23:30:00Z',isVictor:true,status:'completed',text};
  const f=fixture({initial:{'parkside:calllog':[entry],['parkside:grade:'+manualDate]:grade},initialRaw:{['parkside:report:'+manualDate]:text}});
  const preview=await f.request({recordingSid:SID},'calls_reconcile',{headers:ownerHeaders,sign:false});assert.equal(preview.status,200);assert.equal(preview.body.preview.nextOperation,'materialize');assert.equal(count(f,'create'),0);
  const p=preview.body.preview, recovered=await f.request({recordingSid:SID,confirmation:p.confirmation,operation:p.nextOperation},'calls_reconcile',{headers:ownerHeaders,sign:false});assert.equal(recovered.status,200);assert.equal(recovered.body.pending,false);assert.equal(count(f,'create'),0);
  const job=f.value('parkside:calljob:'+SID), receipt=f.value('parkside:callreceipt:'+SID), stored=f.value('parkside:calllog')[0];assert.equal(job.status,'completed');assert.equal(job.submissionState,'completed');assert.equal(job.text,text);assert.equal(job.materializationSource,'existing_completed_call');assert.equal(receipt.status,'completed');assert.equal(receipt.reportDisposition,'existing_legacy');
  assert.equal(stored.date,manualDate);assert.equal(stored.text,text);assert.equal(f.raw.get('parkside:report:'+manualDate),text);assert.deepEqual(f.value('parkside:grade:'+manualDate),grade);
});

await test('B3 exact owner preview supports a legitimate future RecordingSid with no permanent cohort lock',async()=>{
  const f=fixture();const preview=await f.request({recordingSid:SID2},'calls_reconcile',{headers:ownerHeaders,sign:false});assert.equal(preview.status,200);assert.equal(preview.body.preview.recordingSid,SID2);assert.equal(preview.body.preview.nextOperation,'submit');
  const p=preview.body.preview;const run=await f.request({recordingSid:SID2,confirmation:p.confirmation,operation:p.nextOperation},'calls_reconcile',{headers:ownerHeaders,sign:false});assert.equal(run.status,200);assert.equal(count(f,'create'),1);assert.equal(f.value('parkside:calljob:'+SID2).recordingSid,SID2);
  assert.doesNotMatch(source,/Sep 30-Oct 14|RECOVERY_ALLOWLIST|owner_allowlisted/);
});

await test('B4/B5 delete writes [] tombstone, blocks late callback, and explicit owner restore works',async()=>{
  const f=fixture();await f.request({...payload});const del=await f.request({},'calls_delete',{headers:ownerHeaders,sign:false,query:{id:SID}});assert.equal(del.status,200);assert.equal(f.raw.get('parkside:calllog'),'[]');assert.equal(f.value('parkside:calltombstone:'+SID).status,'deleted');
  const late=await f.request(intelligenceBody(),'voice_intelligence');assert.equal(late.status,409);assert.deepEqual(f.value('parkside:calllog'),[]);
  const restore=await f.request({recordingSid:SID,restoreRevision:del.body.restoreRevision},'calls_restore',{headers:ownerHeaders,sign:false});assert.equal(restore.status,200);assert.equal(f.value('parkside:calltombstone:'+SID).status,'restored');assert.equal(f.value('parkside:calllog').length,1);
  const complete=await f.request(intelligenceBody(),'voice_intelligence');assert.equal(complete.status,204);assert.match(f.value('parkside:calllog')[0].text,/First complete sentence/);
});

await test('P2 exact-SID recovery restores after reload and rejects a stale tombstone preview',async()=>{
  const grade={score:4,by:'gavin'}, f=fixture({initial:{['parkside:grade:'+DATE]:grade}});await f.request({...payload});const del=await f.request({},'calls_delete',{headers:ownerHeaders,sign:false,query:{id:SID}});assert.equal(del.status,200);
  const first=await f.request({recordingSid:SID},'calls_reconcile',{headers:ownerHeaders,sign:false});assert.equal(first.status,200);assert.equal(first.body.preview.nextOperation,'restore');
  const tomb=f.value('parkside:calltombstone:'+SID), job=f.value('parkside:calljob:'+SID);tomb.revision='newer-delete-revision';job.revision=tomb.revision;job.protectionRevision=tomb.revision;job.deletionRevision=tomb.revision;f.raw.set('parkside:calltombstone:'+SID,JSON.stringify(tomb));f.raw.set('parkside:calljob:'+SID,JSON.stringify(job));
  const stale=await f.request({recordingSid:SID,confirmation:first.body.preview.confirmation,operation:'restore'},'calls_reconcile',{headers:ownerHeaders,sign:false});assert.equal(stale.status,409);assert.deepEqual(f.value('parkside:calllog'),[]);
  const fresh=await f.request({recordingSid:SID},'calls_reconcile',{headers:ownerHeaders,sign:false});assert.equal(fresh.status,200);assert.equal(fresh.body.preview.tombstoneRevision,'newer-delete-revision');const restored=await f.request({recordingSid:SID,confirmation:fresh.body.preview.confirmation,operation:'restore'},'calls_reconcile',{headers:ownerHeaders,sign:false});assert.equal(restored.status,200);assert.equal(restored.body.restored,true);assert.equal(f.value('parkside:calllog')[0].recordingSid,SID);assert.deepEqual(f.value('parkside:grade:'+DATE),grade);
});

await test('B5 deletion revision defeats a callback already inside provider readback',async()=>{
  const f=fixture({deleteDuringCompletedJobCas:true});await f.request({...payload});const r=await f.request(intelligenceBody(),'voice_intelligence');assert.equal(r.status,409);assert.equal(f.value('parkside:calltombstone:'+SID).status,'deleted');assert.equal(String(f.value('parkside:calllog')[0].text||''),'');assert.equal(f.raw.has('parkside:report:'+DATE),false);
});

await test('B4 a new intake works after the last deletion encoded a real empty array',async()=>{
  const f=fixture();await f.request({...payload});const del=await f.request({},'calls_delete',{headers:ownerHeaders,sign:false,query:{id:SID}});assert.equal(del.status,200);const p2={...payload,RecordingSid:SID2,CallSid:CALL2,RecordingUrl:'https://api.twilio.com/2010-04-01/Accounts/'+AC+'/Recordings/'+SID2};const r=await f.request(p2);assert.equal(r.status,200);assert.equal(f.value('parkside:calllog')[0].recordingSid,SID2);
});

await test('B6 raw legacy scalar-looking reports and Unicode round-trip as strings',async()=>{
  const values=['123','0','true','[]','{}','null','1.0','雪 Ω emoji 😀','',REPORT_PREFIX+'"legacy prefix-like text"'];
  for(const value of values){const key='parkside:report:2026-10-01',formatKey='parkside:report-format:2026-10-01',f=fixture({initialRaw:{[key]:value}});const get=await f.request({},'scorecard_report',{headers:ownerHeaders,sign:false,method:'GET',query:{date:'2026-10-01'}});assert.equal(get.body.report,value);const next=value+' / saved';const save=await f.request({report:next},'scorecard_report',{headers:ownerHeaders,sign:false,query:{date:'2026-10-01'}});assert.equal(save.status,200);assert.equal(f.raw.get(key),REPORT_PREFIX+JSON.stringify(next));assert.equal(f.raw.get(formatKey),REPORT_FORMAT);}
});

await test('B6 exact existing Upstash SDK 1.38.0 verifies raw-vs-default response behavior offline',async()=>{
  const pkg=JSON.parse(fs.readFileSync(path.join(SDK_ROOT,'package.json'),'utf8'));assert.equal(pkg.version,'1.38.0');const sdkRequire=Module.createRequire(path.join(SDK_ROOT,'package.json'));const {Redis}=sdkRequire('@upstash/redis');
  const oldFetch=globalThis.fetch, requests=[];globalThis.fetch=async(_url,options)=>{requests.push(JSON.parse(options.body));return new Response(JSON.stringify([{result:'MTIz'}]),{status:200,headers:{'content-type':'application/json'}});};
  try{const rawClient=new Redis({url:'https://fixture.upstash.invalid',token:'fixture',automaticDeserialization:false});const defaultClient=new Redis({url:'https://fixture.upstash.invalid',token:'fixture'});assert.equal(await rawClient.get('report'),'123');assert.equal(await defaultClient.get('report'),123);await rawClient.mset({report:'encoded',format:'v1-json-string'});assert.deepEqual(requests[0],[['get','report']]);assert.deepEqual(requests[2],[['mset','report','encoded','format','v1-json-string']]);}finally{globalThis.fetch=oldFetch;}
});

await test('B7 save-and-score aborts on failed save, keeps text, and succeeds on retry',async()=>{
  const start=html.indexOf('async function saveReport()'), end=html.indexOf('async function saveGrade()',start);assert.ok(start>0&&end>start);const code=html.slice(start,end);
  const elements={monDate:{value:'2026-10-14'},monDevice:{value:'victor'},scStatus:{textContent:''},scReport:{value:'unsaved owner text'}};let responses=[],urls=[],rendered=null;
  const context=vm.createContext({document:{getElementById:id=>elements[id]||null},GPW:'owner',Date,encodeURIComponent,api:a=>'/api/app?action='+a,renderScore:j=>{rendered=j;},fetch:async url=>{urls.push(String(url));return responses.shift();}});vm.runInContext(code,context);
  responses=[new Response(JSON.stringify({ok:false,error:'down'}),{status:503,headers:{'content-type':'application/json'}})];await context.runScore();assert.equal(urls.length,1);assert.doesNotMatch(urls[0],/score_day/);assert.equal(elements.scReport.value,'unsaved owner text');assert.match(elements.scStatus.textContent,/report kept.*Retry Save/i);
  urls=[];responses=[new Response(JSON.stringify({ok:true}),{status:200,headers:{'content-type':'application/json'}}),new Response(JSON.stringify({truth_score:5}),{status:200,headers:{'content-type':'application/json'}})];await context.runScore();assert.equal(urls.length,2);assert.match(urls[1],/score_day/);assert.deepEqual(rendered,{truth_score:5});
});

await test('P2 interrupted owner UI exposes exact-SID recovery, blocks active retry, and restores after reload',async()=>{
  assert.match(html,/id="callRecoverySid"[^>]*aria-label="Exact RecordingSid"/);assert.match(html,/callRecoverySid[\s\S]{0,300}event\.key==='Enter'/);
  const start=html.indexOf('async function recoverExactCall()'), end=html.indexOf('async function moveCall(',start);assert.ok(start>0&&end>start);const code=html.slice(start,end);
  const elements={callRecoverySid:{value:SID,focused:false,focus(){this.focused=true;}},callsStatus:{textContent:''}};let replies=[],requests=[],confirms=0,loads=0;
  const context=vm.createContext({document:{getElementById:id=>elements[id]||null},GPW:'owner',api:a=>'/api/app?action='+a,confirm:()=>{confirms++;return true;},loadCalls:async()=>{loads++;},fetch:async(url,opt)=>{requests.push({url:String(url),body:opt&&opt.body?JSON.parse(opt.body):null});const next=replies.shift();return new Response(JSON.stringify(next.body),{status:next.status,headers:{'content-type':'application/json'}});},Response,JSON,String,console});vm.runInContext(code,context);
  replies=[{status:200,body:{ok:true,preview:{recordingSid:SID,date:DATE,duration:180,caller:'***0000',storedStatus:'reserved',jobStatus:'submitting',nextOperation:'pending',submissionActive:true,submissionDeadlineAt:'2026-10-15T00:31:00.000Z',confirmation:'pending-confirm'}}}];await context.recoverExactCall();assert.equal(requests.length,1);assert.equal(confirms,0);assert.match(elements.callsStatus.textContent,/still active.*no retry was sent/i);
  replies=[{status:200,body:{ok:true,preview:{recordingSid:SID,date:DATE,duration:180,caller:'***0000',storedStatus:'completed',jobStatus:'submitted',nextOperation:'restore',confirmation:'fresh-restore'}}},{status:200,body:{ok:true,operation:'restore',restored:true}}];requests=[];await context.recoverExactCall();assert.equal(requests.length,2);assert.equal(requests[1].body.operation,'restore');assert.equal(requests[1].body.confirmation,'fresh-restore');assert.equal(confirms,1);assert.equal(loads,1);assert.equal(elements.callsStatus.textContent,'Call restored ✓');
});

await test('legacy transcription callback is signed, provenance-checked, and never retranscribes audio',async()=>{
  const f=fixture();const body={...payload,TranscriptionText:'Legacy provider supplied text.',TranscriptionSid:'TR'+'9'.repeat(32)};const r=await f.request(body,'voice_transcription');assert.equal(r.status,200);assert.equal(count(f,'create'),0);assert.equal(f.value('parkside:calllog')[0].text,'Legacy provider supplied text.');
});

console.log('\n'+passed+' focused safety tests passed.');
console.log('HONEST GATE: Lua source bytes were lexically checked, but no native Redis/Lua engine was executed by this test.');
console.log('HONEST GATE: Upstash request/response behavior was exercised offline with exact installed @upstash/redis 1.38.0; no live Redis was accessed.');
