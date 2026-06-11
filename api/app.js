// Parkside Tepees — pricing control backend. Routes on ?action.
// MODEL (resort-dominant, pace-based, self-learning):
//   * PACE: each month has an expected occupancy trajectory by lead time (how booked it "should" be
//     N days out to land on the monthly target). expected = target * paceFrac(monthLead, daytype).
//     Seeded with a default STR pickup curve; blended with a curve LEARNED from real booking events.
//   * Price off AHEAD vs BEHIND pace (not current-occ vs final-target):
//       resortGap = poolOcc - expected   (PRIMARY ~80%: the whole resort moves all units together)
//       gap>=0 -> level travels toward $300 ; gap<0 -> toward $99.
//     Then a GENTLE per-unit nudge (~20%, capped +/-$25) for unit-level scarcity vs the resort.
//   Overrides pin a night. No occupancy data at all -> price at market.
let redis=null; try{ const {Redis}=require("@upstash/redis"); redis=new Redis({url:process.env.KV_REST_API_URL,token:process.env.KV_REST_API_TOKEN}); }catch{ redis=null; }
const FLOOR=99, CEIL=300, OV_MIN=50, OV_MAX=1000, ENDPOINT="https://api.ownerrez.com/v2/spotrates";
const UNITS=[
  {orp:486910,name:"Bear Claw",offset:0},{orp:486911,name:"Flyin' Horse",offset:5},
  {orp:486912,name:"Mustang Manor",offset:15},{orp:486913,name:"Soaring Dreams",offset:0},
  {orp:486891,name:"Arrowhead",offset:20},{orp:486914,name:"Sunset Stampede",offset:0},
  {orp:486915,name:"Buffalo Run",offset:0},{orp:486916,name:"Scarlet Antler",offset:0},
  {orp:486917,name:"Cub House",offset:12},{orp:486918,name:"Flyin' Free",offset:0},
];
const SEED_TARGETS={1:{wd:.40,we:.60},2:{wd:.40,we:.60},3:{wd:.55,we:.78},4:{wd:.58,we:.80},5:{wd:.60,we:.82},6:{wd:.70,we:.90},7:{wd:.75,we:.92},8:{wd:.65,we:.85},9:{wd:.60,we:.82},10:{wd:.72,we:.92},11:{wd:.55,we:.78},12:{wd:.62,we:.85}};
const KNOBS={weekendDays:[5,6],raiseSpan:.13,cutSpan:.20,unitGain:50,unitBand:25};
// Seed booking-pace curve = fraction of FINAL bookings on the books by `lead` days out (leisure STR).
const PACE_SEED={
  weekend:[[0,1],[7,.93],[14,.87],[30,.74],[60,.55],[90,.40],[120,.30],[180,.16],[270,.07],[365,.03]],
  weekday:[[0,1],[7,.90],[14,.82],[30,.66],[60,.46],[90,.32],[120,.22],[180,.11],[270,.05],[365,.02]]
};
const DEFAULTS={targets:SEED_TARGETS,auto_sync:false,overrides:{},icals:{}};
const SKEY="parkside:state";

async function getState(){ if(!redis) return JSON.parse(JSON.stringify(DEFAULTS)); const s=await redis.get(SKEY); return {...JSON.parse(JSON.stringify(DEFAULTS)),...(s||{})}; }
async function setState(p){ const cur=await getState(); const next={...cur,...p}; if(redis) await redis.set(SKEY,next); return next; }
const isWe=d=>KNOBS.weekendDays.includes(d.getUTCDay());
function targetFor(d,t){ const m=t[d.getUTCMonth()+1]; return isWe(d)?m.we:m.wd; }
function monthLead(ds,today){ const first=new Date(ds.slice(0,7)+"-01T00:00:00Z"); const t=new Date(today+"T00:00:00Z"); return Math.max(0,Math.round((first-t)/86400000)); }
function interp(pts,x){ if(x<=pts[0][0])return pts[0][1]; for(let i=1;i<pts.length;i++){ if(x<=pts[i][0]){ const a=pts[i-1],b=pts[i]; return a[1]+(b[1]-a[1])*(x-a[0])/(b[0]-a[0]); } } return pts[pts.length-1][1]; }
function paceFrac(lead,dt,learned){ const seed=interp(PACE_SEED[dt],lead);
  if(!learned||!learned[dt]||!learned[dt].n) return seed;
  const w=Math.min(0.8, learned[dt].n/300); return (1-w)*seed + w*interp(learned[dt].curve,lead); }
// Learn the pace curve from logged booking events: fraction of bookings made at lead >= X.
function buildLearnedPace(events){ const out={weekend:{n:0},weekday:{n:0}};
  for(const dt of ["weekend","weekday"]){ const leads=(events||[]).filter(e=>e.daytype===dt&&e.lead>=0).map(e=>e.lead); const n=leads.length;
    if(n){ out[dt]={n,curve:PACE_SEED[dt].map(p=>[p[0], leads.filter(l=>l>=p[0]).length/n])}; } } return out; }

function signalFallback(sig,ds){ const k=Object.keys(sig); if(!k.length)return 0; const d=new Date(ds+"T00:00:00Z"),mo=d.getUTCMonth(),dw=d.getUTCDay();
  const med=a=>{a=a.slice().sort((x,y)=>x-y);const n=a.length;return n?(n%2?a[(n-1)/2]:(a[n/2-1]+a[n/2])/2):0;};
  let s=k.filter(x=>{const e=new Date(x+"T00:00:00Z");return e.getUTCMonth()===mo&&e.getUTCDay()===dw;}).map(x=>sig[x]); if(s.length)return med(s);
  s=k.filter(x=>new Date(x+"T00:00:00Z").getUTCDay()===dw).map(x=>sig[x]); if(s.length)return med(s); return med(k.map(x=>sig[x])); }
async function getSignal(){
  if(redis){ const c=await redis.get("parkside:signal"); if(c&&c.day===new Date().toISOString().slice(0,10)) return c.map; }
  const key=process.env.PRICELABS_API_KEY; if(!key) throw new Error("PRICELABS_API_KEY not set");
  const id=process.env.PRICELABS_REF_ID||"486915", pms=process.env.PRICELABS_REF_PMS||"ownerrez";
  const t=new Date(), e=new Date(); e.setDate(e.getDate()+365);
  const r=await fetch("https://api.pricelabs.co/v1/listing_prices",{method:"POST",headers:{"X-API-Key":key,"Content-Type":"application/json"},body:JSON.stringify({listings:[{id,pms,dateFrom:t.toISOString().slice(0,10),dateTo:e.toISOString().slice(0,10),reason:false}]})});
  const data=await r.json(); const rows=(data[0]&&data[0].data)||[]; const map={};
  for(const x of rows){ if(x.date&&!x.booking_status&&!x.unbookable&&x.price>0) map[x.date.slice(0,10)]=Math.round(x.price); }
  if(redis) await redis.set("parkside:signal",{day:new Date().toISOString().slice(0,10),map}); return map;
}
function parseIcs(text){ const out=[]; const blocks=String(text).split("BEGIN:VEVENT").slice(1);
  for(const b of blocks){ const a=(b.match(/DTSTART[^:\n]*:(\d{8})/)||[])[1]; const c=(b.match(/DTEND[^:\n]*:(\d{8})/)||[])[1]; if(a&&c) out.push([a,c]); } return out; }
async function getBooked(state,start,days,useCache=true){
  if(useCache&&redis){ const c=await redis.get("parkside:booked"); if(c&&(Date.now()-c.ts)<3600000) return {byUnit:c.byUnit,total:c.total,channels:c.channels}; }
  const icals=(state&&state.icals)||{}; const out={}; for(const u of UNITS)out[u.orp]={};
  const s=new Date(start+"T00:00:00Z"); const end=new Date(s); end.setUTCDate(end.getUTCDate()+days); let total=0; const channels={};
  for(const u of UNITS){ const urls=icals[u.orp]||[]; channels[u.orp]=0;
    for(const url of urls){ try{ const r=await fetch(url,{headers:{"User-Agent":"parkside-control/1.0"}}); if(!r.ok) continue; const t=await r.text(); channels[u.orp]++;
      for(const [a,c] of parseIcs(t)){ let d=new Date(a.slice(0,4)+"-"+a.slice(4,6)+"-"+a.slice(6,8)+"T00:00:00Z"); const e=new Date(c.slice(0,4)+"-"+c.slice(4,6)+"-"+c.slice(6,8)+"T00:00:00Z");
        for(;d<e;d.setUTCDate(d.getUTCDate()+1)){ if(d>=s&&d<end){ const k=d.toISOString().slice(0,10); if(!out[u.orp][k]){out[u.orp][k]=true; total++;} } } }
    }catch{} } }
  if(redis) await redis.set("parkside:booked",{ts:Date.now(),byUnit:out,total,channels}); return {byUnit:out,total,channels};
}
function buildAgg(booked,start,days){
  const s=new Date(start+"T00:00:00Z"); const unitAgg={},poolAgg={}; for(const u of UNITS)unitAgg[u.orp]={};
  for(let i=0;i<days;i++){ const d=new Date(s); d.setUTCDate(d.getUTCDate()+i); const ds=d.toISOString().slice(0,10); const mk=ds.slice(0,7); const dt=isWe(d)?1:0;
    if(!poolAgg[mk])poolAgg[mk]=[{b:0,t:0},{b:0,t:0}];
    for(const u of UNITS){ if(!unitAgg[u.orp][mk])unitAgg[u.orp][mk]=[{b:0,t:0},{b:0,t:0}];
      unitAgg[u.orp][mk][dt].t++; poolAgg[mk][dt].t++; if(booked.byUnit[u.orp][ds]){ unitAgg[u.orp][mk][dt].b++; poolAgg[mk][dt].b++; } } }
  return {unitAgg,poolAgg};
}
function priceNight(base,poolOcc,unitOcc,expected){
  const rGap=poolOcc-expected; let level;
  if(rGap>=0){ const t=Math.min(1,rGap/KNOBS.raiseSpan); level=base+(CEIL-base)*t; }    // resort ahead of pace -> up
  else { const t=Math.min(1,-rGap/KNOBS.cutSpan); level=base-(base-FLOOR)*t; }            // resort behind pace -> down
  const nudge=Math.max(-KNOBS.unitBand,Math.min(KNOBS.unitBand,(unitOcc-poolOcc)*KNOBS.unitGain)); // gentle per-unit
  return Math.max(FLOOR,Math.min(CEIL,Math.round(level+nudge)));
}
function compute(signalMap,targets,today,startDate,days,occ,overrides,learned){
  const start=new Date(startDate+"T00:00:00Z"); const out=[]; overrides=overrides||{};
  for(let i=0;i<days;i++){ const d=new Date(start); d.setUTCDate(d.getUTCDate()+i); const ds=d.toISOString().slice(0,10); const mk=ds.slice(0,7); const we=isWe(d); const dt=we?1:0; const dtN=we?"weekend":"weekday"; const tg=targetFor(d,targets);
    const exp=tg*paceFrac(monthLead(ds,today),dtN,learned);
    let sig=signalMap[ds]; if(sig==null) sig=signalFallback(signalMap,ds);
    for(const u of UNITS){ const key=u.orp+"|"+ds; let amount,overridden=false;
      if(overrides[key]!=null){ amount=Math.round(Math.max(OV_MIN,Math.min(OV_MAX,Number(overrides[key])))); overridden=true; }
      else { const base=Math.max(FLOOR,Math.min(CEIL,sig+u.offset));
        if(!occ.hasData){ amount=Math.round(base); }
        else { let poolOcc,unitOcc; if(occ.mock!=null){poolOcc=unitOcc=occ.mock;} else { const ua=occ.agg.unitAgg[u.orp][mk][dt], pa=occ.agg.poolAgg[mk][dt]; unitOcc=ua&&ua.t?ua.b/ua.t:0; poolOcc=pa&&pa.t?pa.b/pa.t:0; }
          amount=priceNight(base,poolOcc,unitOcc,exp); } }
      out.push({property_id:u.orp,unit:u.name,date:ds,amount,currency:"USD",overridden}); } }
  return out;
}
function validate(es){ const ok=[]; for(const e of es){ const pid=Number(e.property_id), amt=Number(e.amount);
  if(Number.isInteger(pid)&&/^\d{4}-\d{2}-\d{2}$/.test(e.date)&&amt>=OV_MIN&&amt<=OV_MAX&&e.currency==="USD") ok.push({property_id:pid,date:e.date,amount:Math.round(amt),currency:"USD"}); } return ok; }
async function pushOwnerRez(es){ const user=process.env.OWNERREZ_API_USER,token=process.env.OWNERREZ_API_TOKEN; if(!user||!token) throw new Error("missing OWNERREZ creds");
  const ok=validate(es); if(!ok.length) throw new Error("no valid entries"); const auth="Basic "+Buffer.from(`${user}:${token}`).toString("base64");
  const r=await fetch(ENDPOINT,{method:"PATCH",headers:{Authorization:auth,"Content-Type":"application/json","User-Agent":"parkside-control/1.0"},body:JSON.stringify(ok)});
  const t=await r.text(); return {status:r.status,sent:ok.length,ownerrezOk:r.ok,body:t.slice(0,200)}; }
async function logPhase1(rates,booked,today){
  if(!redis) return 0; const HOR=120; const start=new Date(today+"T00:00:00Z"); const lim=new Date(start); lim.setUTCDate(lim.getUTCDate()+HOR);
  const snap={};
  for(const r of rates){ const d=new Date(r.date+"T00:00:00Z"); if(d<start||d>=lim) continue; snap[r.property_id+"|"+r.date]=[r.amount, booked.byUnit[r.property_id][r.date]?1:0]; }
  const prev=(await redis.get("parkside:snap"))||{}; const events=[];
  for(const k in snap){ const [,bk]=snap[k]; const p=prev[k]; if(bk===1&&p&&p[1]===0){ const [pid,date]=k.split("|"); const night=new Date(date+"T00:00:00Z"); const lead=Math.round((night-start)/86400000); const dow=night.getUTCDay();
    events.push({unit:Number(pid),date,priceShown:p[0],lead,daytype:[5,6].includes(dow)?"weekend":"weekday",observed:today}); } }
  if(events.length){ const log=(await redis.get("parkside:events"))||[]; await redis.set("parkside:events",log.concat(events).slice(-5000)); }
  await redis.set("parkside:snap",snap); return events.length;
}
async function getLearned(){ const ev=(redis&&await redis.get("parkside:events"))||[]; return buildLearnedPace(ev); }

module.exports=async(req,res)=>{
  try{
    const action=(req.query&&req.query.action)||""; const today=new Date().toISOString().slice(0,10), days=365;
    if(action==="state"){
      if(req.method==="GET"){ const s=await getState(); const icalCount={}; for(const u of UNITS) icalCount[u.orp]=(s.icals[u.orp]||[]).length;
        return res.status(200).json({targets:s.targets,knobs:KNOBS,auto_sync:s.auto_sync,overrides:s.overrides||{},icalCount}); }
      if(req.method==="POST"){ if((req.headers["x-app-password"]||"")!==(process.env.APP_PASSWORD||"")) return res.status(401).json({error:"unauthorized"});
        let b=req.body; if(typeof b==="string"){try{b=JSON.parse(b);}catch{return res.status(400).json({error:"bad json"});}}
        const cur=await getState(); const p={};
        if(b&&b.targets)p.targets=b.targets; if(b&&typeof b.auto_sync==="boolean")p.auto_sync=b.auto_sync; if(b&&b.icals)p.icals=b.icals;
        if(b&&b.overrideSet){ const o={...(cur.overrides||{})}; o[b.overrideSet.property_id+"|"+b.overrideSet.date]=Math.round(Math.max(OV_MIN,Math.min(OV_MAX,Number(b.overrideSet.amount)))); p.overrides=o; }
        if(b&&b.overrideClear){ const o={...(cur.overrides||{})}; delete o[b.overrideClear.property_id+"|"+b.overrideClear.date]; p.overrides=o; }
        const n=await setState(p); if(redis&&b.icals) await redis.del("parkside:booked"); return res.status(200).json({ok:true,auto_sync:n.auto_sync}); }
      return res.status(405).json({error:"GET or POST"});
    }
    if(action==="occupancy"){
      const st=await getState(); const booked=await getBooked(st,today,days, !(req.query&&req.query.fresh==="1"));
      const agg=buildAgg(booked,today,days); const learned=await getLearned();
      const start=new Date(today+"T00:00:00Z"); const monthTotal={};
      for(let i=0;i<days;i++){ const d=new Date(start); d.setUTCDate(d.getUTCDate()+i); const mk=d.toISOString().slice(0,7); monthTotal[mk]=(monthTotal[mk]||0)+1; }
      const months=Object.keys(monthTotal).sort(); const byUnit={};
      for(const u of UNITS){ const dates=Object.keys(booked.byUnit[u.orp]); const mc={}; for(const ds of dates){const mk=ds.slice(0,7); mc[mk]=(mc[mk]||0)+1;}
        const monthly={}; for(const mk of months) monthly[mk]=Math.round(100*((mc[mk]||0)/monthTotal[mk])); byUnit[u.orp]={booked:dates,monthly}; }
      const pace={};
      for(const mk of months){ const lead=monthLead(mk+"-15",today); const tgt=st.targets[parseInt(mk.slice(5))]; const pa=agg.poolAgg[mk]||[{b:0,t:0},{b:0,t:0}];
        const mk2=(dt,dn,tv)=>{ const act=pa[dt].t?Math.round(100*pa[dt].b/pa[dt].t):0; const exp=Math.round(100*tv*paceFrac(lead,dn,learned)); return {act,exp,status:act>=exp?"ahead":"behind"}; };
        pace[mk]={wknd:mk2(1,"weekend",tgt.we), wkdy:mk2(0,"weekday",tgt.wd)}; }
      return res.status(200).json({units:UNITS.map(u=>({orp:u.orp,name:u.name})),months,byUnit,pace,paceLearn:{weekend:learned.weekend.n||0,weekday:learned.weekday.n||0,blendWeight:Math.min(0.8,((learned.weekend.n||0)+(learned.weekday.n||0))/600).toFixed(2)},totalBooked:booked.total,channels:booked.channels});
    }
    if(action==="logs"){
      if((req.headers["x-app-password"]||"")!==(process.env.APP_PASSWORD||"")) return res.status(401).json({error:"unauthorized"});
      const snap=(redis&&await redis.get("parkside:snap"))||{}; const events=(redis&&await redis.get("parkside:events"))||[]; const learned=buildLearnedPace(events);
      return res.status(200).json({snapshotCells:Object.keys(snap).length, eventCount:events.length, learnedPace:learned, recentEvents:events.slice(-15)});
    }
    if(action==="preview"){
      let b=req.body; if(typeof b==="string"){try{b=JSON.parse(b);}catch{b={};}}
      const st=await getState(); const targets=(b&&b.targets)||st.targets; const sig=await getSignal(); const learned=await getLearned();
      let occ; if(b&&typeof b.mockOcc==="number") occ={hasData:true,mock:b.mockOcc};
      else { const bk=await getBooked(st,today,days); occ={hasData:bk.total>0, agg:buildAgg(bk,today,days)}; }
      const rates=compute(sig,targets,today,today,days,occ,st.overrides,learned); const amts=rates.map(r=>r.amount);
      return res.status(200).json({mode:"PREVIEW",wrote:false,count:rates.length,coldStart:!occ.hasData,min:Math.min(...amts),max:Math.max(...amts),avg:Math.round(amts.reduce((a,c)=>a+c,0)/amts.length),overrideCount:rates.filter(r=>r.overridden).length,rates});
    }
    if(action==="run"){
      const okAuth=((req.headers["authorization"]||"")==="Bearer "+(process.env.CRON_SECRET||"__x")) || ((req.headers["x-app-password"]||"")===(process.env.APP_PASSWORD||"__x"));
      if(!okAuth) return res.status(401).json({error:"unauthorized"});
      const st=await getState(); const sig=await getSignal(); const booked=await getBooked(st,today,days,false); const learned=await getLearned();
      const occ={hasData:booked.total>0, agg:buildAgg(booked,today,days)};
      const rates=compute(sig,st.targets,today,today,days,occ,st.overrides,learned);
      const logged=await logPhase1(rates,booked,today);
      if(!st.auto_sync) return res.status(200).json({mode:"COMPUTED_NO_SYNC",auto_sync:false,computed:rates.length,wrote:false,bookedNights:booked.total,logged,note:"auto-sync OFF — nothing written"});
      const r=await pushOwnerRez(rates); return res.status(r.ownerrezOk?200:502).json({mode:"LIVE_SYNC",auto_sync:true,bookedNights:booked.total,logged,overrides:rates.filter(x=>x.overridden).length,...r});
    }
    res.status(400).json({error:"unknown action"});
  }catch(e){ res.status(500).json({error:String(e.message||e)}); }
};
