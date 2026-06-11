// Parkside Tepees — pricing control backend (single function, routes on ?action).
//   ?action=preview  -> compute calendar, NEVER writes (supports body.targets, body.mockOcc for testing)
//   ?action=state    -> GET settings (open) / POST settings+overrides (needs x-app-password)
//   ?action=run      -> daily cron + manual sync; writes to OwnerRez ONLY if auto_sync ON
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
const KNOBS={weekendDays:[5,6],upGain:.8,downGain:.8,maxRaise:.40,maxCut:.30};
const DEFAULTS={targets:SEED_TARGETS,knobs:KNOBS,auto_sync:false,learned:{raiseFactor:1},overrides:{}};
const SKEY="parkside:state";

async function getState(){ if(!redis) return JSON.parse(JSON.stringify(DEFAULTS)); const s=await redis.get(SKEY); return {...JSON.parse(JSON.stringify(DEFAULTS)),...(s||{})}; }
async function setState(p){ const cur=await getState(); const next={...cur,...p}; if(redis) await redis.set(SKEY,next); return next; }

function targetFor(d,t){ const m=t[d.getUTCMonth()+1]; return KNOBS.weekendDays.includes(d.getUTCDay())?m.we:m.wd; }
// Revenue-max held to target, compared DIRECTLY (actual vs target):
//   actual >= target -> raise toward ceiling (bounded +maxRaise)
//   actual <  target -> discount toward floor (bounded -maxCut)
//   no occupancy data at all (cold start) -> NEUTRAL: price at market (mult 1.0), never floor blindly
function controllerMult(target,occ,hasData,learned){
  if(!hasData) return 1.0;
  const gap=occ-target; const rf=(learned&&learned.raiseFactor)||1;
  return gap>=0 ? 1+Math.min(KNOBS.upGain*gap*rf,KNOBS.maxRaise) : 1+Math.max(KNOBS.downGain*gap,-KNOBS.maxCut);
}
function clampRound(p){ return Math.round(Math.max(FLOOR,Math.min(CEIL,p))); }
function signalFallback(sig,ds){ const k=Object.keys(sig); if(!k.length)return 0; const d=new Date(ds+"T00:00:00Z"),mo=d.getUTCMonth(),dw=d.getUTCDay();
  const med=a=>{a=a.slice().sort((x,y)=>x-y);const n=a.length;return n?(n%2?a[(n-1)/2]:(a[n/2-1]+a[n/2])/2):0;};
  let s=k.filter(x=>{const e=new Date(x+"T00:00:00Z");return e.getUTCMonth()===mo&&e.getUTCDay()===dw;}).map(x=>sig[x]); if(s.length)return med(s);
  s=k.filter(x=>new Date(x+"T00:00:00Z").getUTCDay()===dw).map(x=>sig[x]); if(s.length)return med(s);
  return med(k.map(x=>sig[x])); }

async function getSignal(){
  if(redis){ const c=await redis.get("parkside:signal"); if(c&&c.day===new Date().toISOString().slice(0,10)) return c.map; }
  const key=process.env.PRICELABS_API_KEY; if(!key) throw new Error("PRICELABS_API_KEY not set");
  const id=process.env.PRICELABS_REF_ID||"486915", pms=process.env.PRICELABS_REF_PMS||"ownerrez";
  const t=new Date(), e=new Date(); e.setDate(e.getDate()+365);
  const r=await fetch("https://api.pricelabs.co/v1/listing_prices",{method:"POST",headers:{"X-API-Key":key,"Content-Type":"application/json"},body:JSON.stringify({listings:[{id,pms,dateFrom:t.toISOString().slice(0,10),dateTo:e.toISOString().slice(0,10),reason:false}]})});
  const data=await r.json(); const rows=(data[0]&&data[0].data)||[]; const map={};
  for(const x of rows){ if(x.date&&!x.booking_status&&!x.unbookable&&x.price>0) map[x.date.slice(0,10)]=Math.round(x.price); }
  if(redis) await redis.set("parkside:signal",{day:new Date().toISOString().slice(0,10),map});
  return map;
}
// Returns {fn, total}: fn(ds,we)->occ fraction; total = booked unit-nights found (0 => cold start)
async function getOccupancy(start,days){
  const user=process.env.OWNERREZ_API_USER, token=process.env.OWNERREZ_API_TOKEN; if(!user||!token) return {fn:()=>0,total:0};
  const auth="Basic "+Buffer.from(`${user}:${token}`).toString("base64"); const W=21,WE=[5,6];
  const s=new Date(start+"T00:00:00Z"); const booked={}; let total=0;
  try{ for(const u of UNITS){
    const url=`https://api.ownerrez.com/v2/bookings?property_ids=${u.orp}&since_utc=${s.toISOString().slice(0,10)}&include_cancelled=false&limit=500`;
    const r=await fetch(url,{headers:{Authorization:auth,Accept:"application/json"}}); if(!r.ok) continue;
    const j=await r.json(); const items=Array.isArray(j)?j:(j.items||j.bookings||j.data||[]);
    for(const b of items){ const ci=new Date(((b.arrival||b.checkIn||b.arrival_date||"")+"").slice(0,10)+"T00:00:00Z"), co=new Date(((b.departure||b.checkOut||b.departure_date||"")+"").slice(0,10)+"T00:00:00Z");
      if(isNaN(ci)||isNaN(co))continue; for(let d=new Date(ci);d<co;d.setUTCDate(d.getUTCDate()+1)){ booked[u.orp+"|"+d.toISOString().slice(0,10)]=true; total++; } }
  } }catch{ return {fn:()=>0,total:0}; }
  const fn=(ds,we)=>{ const c=new Date(ds+"T00:00:00Z"); let b=0,t=0; for(let o=-W;o<=W;o++){ const d=new Date(c); d.setUTCDate(d.getUTCDate()+o);
    if(WE.includes(d.getUTCDay())!==we)continue; const k=d.toISOString().slice(0,10); for(const u of UNITS){t++; if(booked[u.orp+"|"+k])b++;} } return t?b/t:0; };
  return {fn,total};
}
async function getBookedByUnit(start,days){
  const out={}; for(const u of UNITS) out[u.orp]={};
  const user=process.env.OWNERREZ_API_USER,token=process.env.OWNERREZ_API_TOKEN; if(!user||!token) return out;
  const auth="Basic "+Buffer.from(`${user}:${token}`).toString("base64");
  const s=new Date(start+"T00:00:00Z"); const end=new Date(s); end.setUTCDate(end.getUTCDate()+days);
  try{ for(const u of UNITS){
    const url=`https://api.ownerrez.com/v2/bookings?property_ids=${u.orp}&since_utc=${s.toISOString().slice(0,10)}&include_cancelled=false&limit=500`;
    const r=await fetch(url,{headers:{Authorization:auth,Accept:"application/json"}}); if(!r.ok) continue;
    const j=await r.json(); const items=Array.isArray(j)?j:(j.items||j.bookings||j.data||[]);
    for(const b of items){ const ci=new Date(((b.arrival||b.checkIn||b.arrival_date||"")+"").slice(0,10)+"T00:00:00Z"), co=new Date(((b.departure||b.checkOut||b.departure_date||"")+"").slice(0,10)+"T00:00:00Z");
      if(isNaN(ci)||isNaN(co))continue; for(let d=new Date(Math.max(ci,s));d<co&&d<end;d.setUTCDate(d.getUTCDate()+1)) out[u.orp][d.toISOString().slice(0,10)]=true; }
  } }catch{}
  return out;
}
function compute(signalMap,targets,learned,today,startDate,days,occInfo,overrides){
  const start=new Date(startDate+"T00:00:00Z"); const out=[]; const hasData=(occInfo.total||0)>0; overrides=overrides||{};
  for(let i=0;i<days;i++){ const d=new Date(start); d.setUTCDate(d.getUTCDate()+i); const ds=d.toISOString().slice(0,10);
    const we=KNOBS.weekendDays.includes(d.getUTCDay()); const tg=targetFor(d,targets); const occ=occInfo.fn(ds,we);
    let sig=signalMap[ds]; if(sig==null) sig=signalFallback(signalMap,ds);
    for(const u of UNITS){
      const key=u.orp+"|"+ds; let amount, overridden=false;
      if(overrides[key]!=null){ amount=Math.round(Math.max(OV_MIN,Math.min(OV_MAX,Number(overrides[key])))); overridden=true; }
      else { amount=clampRound((sig+u.offset)*controllerMult(tg,occ,hasData,learned)); }
      out.push({property_id:u.orp,unit:u.name,date:ds,amount,currency:"USD",overridden});
    }
  } return out;
}
function validate(es){ const ok=[]; for(const e of es){ const pid=Number(e.property_id), amt=Number(e.amount);
  if(Number.isInteger(pid)&&/^\d{4}-\d{2}-\d{2}$/.test(e.date)&&amt>=OV_MIN&&amt<=OV_MAX&&e.currency==="USD") ok.push({property_id:pid,date:e.date,amount:Math.round(amt),currency:"USD"}); } return ok; }
async function pushOwnerRez(es){ const user=process.env.OWNERREZ_API_USER,token=process.env.OWNERREZ_API_TOKEN; if(!user||!token) throw new Error("missing OWNERREZ creds");
  const ok=validate(es); if(!ok.length) throw new Error("no valid entries"); const auth="Basic "+Buffer.from(`${user}:${token}`).toString("base64");
  const r=await fetch(ENDPOINT,{method:"PATCH",headers:{Authorization:auth,"Content-Type":"application/json","User-Agent":"parkside-control/1.0"},body:JSON.stringify(ok)});
  const t=await r.text(); return {status:r.status,sent:ok.length,ownerrezOk:r.ok,body:t.slice(0,200)}; }

module.exports=async(req,res)=>{
  try{
    const action=(req.query&&req.query.action)||"";
    if(action==="state"){
      if(req.method==="GET"){ const s=await getState(); return res.status(200).json({targets:s.targets,knobs:s.knobs,auto_sync:s.auto_sync,overrides:s.overrides||{}}); }
      if(req.method==="POST"){ if((req.headers["x-app-password"]||"")!==(process.env.APP_PASSWORD||"")) return res.status(401).json({error:"unauthorized"});
        let b=req.body; if(typeof b==="string"){try{b=JSON.parse(b);}catch{return res.status(400).json({error:"bad json"});}}
        const cur=await getState(); const p={};
        if(b&&b.targets)p.targets=b.targets;
        if(b&&typeof b.auto_sync==="boolean")p.auto_sync=b.auto_sync;
        if(b&&b.overrideSet){ const o={...(cur.overrides||{})}; o[b.overrideSet.property_id+"|"+b.overrideSet.date]=Math.round(Math.max(OV_MIN,Math.min(OV_MAX,Number(b.overrideSet.amount)))); p.overrides=o; }
        if(b&&b.overrideClear){ const o={...(cur.overrides||{})}; delete o[b.overrideClear.property_id+"|"+b.overrideClear.date]; p.overrides=o; }
        const n=await setState(p); return res.status(200).json({ok:true,auto_sync:n.auto_sync,overrides:n.overrides||{}}); }
      return res.status(405).json({error:"GET or POST"});
    }
    if(action==="preview"){
      let b=req.body; if(typeof b==="string"){try{b=JSON.parse(b);}catch{b={};}}
      const st=await getState(); const targets=(b&&b.targets)||st.targets;
      const today=new Date().toISOString().slice(0,10), days=570;
      const sig=await getSignal();
      const occInfo=(b&&typeof b.mockOcc==="number")?{fn:()=>b.mockOcc,total:1}:await getOccupancy(today,days);
      const rates=compute(sig,targets,st.learned,today,today,days,occInfo,st.overrides);
      const amts=rates.map(r=>r.amount);
      return res.status(200).json({mode:"PREVIEW",wrote:false,count:rates.length,coldStart:(occInfo.total||0)===0,min:Math.min(...amts),max:Math.max(...amts),avg:Math.round(amts.reduce((a,c)=>a+c,0)/amts.length),overrideCount:rates.filter(r=>r.overridden).length,rates});
    }
    if(action==="run"){
      const okAuth=((req.headers["authorization"]||"")==="Bearer "+(process.env.CRON_SECRET||"__x")) || ((req.headers["x-app-password"]||"")===(process.env.APP_PASSWORD||"__x"));
      if(!okAuth) return res.status(401).json({error:"unauthorized"});
      const st=await getState(); const today=new Date().toISOString().slice(0,10), days=570;
      const sig=await getSignal(); const occInfo=await getOccupancy(today,days);
      const rates=compute(sig,st.targets,st.learned,today,today,days,occInfo,st.overrides);
      if(!st.auto_sync) return res.status(200).json({mode:"COMPUTED_NO_SYNC",auto_sync:false,computed:rates.length,wrote:false,note:"auto-sync OFF — nothing written"});
      const r=await pushOwnerRez(rates); return res.status(r.ownerrezOk?200:502).json({mode:"LIVE_SYNC",auto_sync:true,overrides:rates.filter(x=>x.overridden).length,...r});
    }
    if(action==="occupancy"){
      const today=new Date().toISOString().slice(0,10), days=570;
      const booked=await getBookedByUnit(today,days);
      const start=new Date(today+"T00:00:00Z"); const monthTotal={};
      for(let i=0;i<days;i++){ const d=new Date(start); d.setUTCDate(d.getUTCDate()+i); const mk=d.toISOString().slice(0,7); monthTotal[mk]=(monthTotal[mk]||0)+1; }
      const months=Object.keys(monthTotal).sort(); const byUnit={};
      for(const u of UNITS){ const dates=Object.keys(booked[u.orp]); const mc={}; for(const ds of dates){ const mk=ds.slice(0,7); mc[mk]=(mc[mk]||0)+1; }
        const monthly={}; for(const mk of months) monthly[mk]=Math.round(100*((mc[mk]||0)/monthTotal[mk])); byUnit[u.orp]={booked:dates,monthly}; }
      return res.status(200).json({units:UNITS.map(u=>({orp:u.orp,name:u.name})), months, byUnit, totalBooked:Object.values(booked).reduce((a,c)=>a+Object.keys(c).length,0)});
    }
    res.status(400).json({error:"unknown action"});
  }catch(e){ res.status(500).json({error:String(e.message||e)}); }
};
