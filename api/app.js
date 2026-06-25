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
const WEEKEND_DAYS=[5,6];
const UNIT_PREM={486891:1.14,486912:1.10,486917:1.08,486911:1.035}; // quality premium as a multiplier on the seasonal base
const MODEL={UPSPAN:0.20,DOWNSPAN:0.30,MAXUP:0.45,MAXDOWN:0.22,SCAR_FAR:0.55,SCAR_NEAR:0.35,SCAR_GAIN:1.0,SCAR_CAP:0.40,UNIT_GAIN:0.40,UNIT_CAP:0.12,MULT_MIN:0.65,MULT_MAX:1.95,PEAK_MULT:1.30,PEAK_CEIL:300};
const SENS=[[0,1.0],[14,0.95],[30,0.85],[60,0.65],[90,0.52],[120,0.45],[180,0.30],[270,0.20],[365,0.15]]; // how hard we react to pace, by lead days
const GAP_SEED={1:0.25,2:0.15,3:0.10}; // seed orphan-gap discount depth by run length (weekday); weekend gaps get x0.4
const KNOBS={weekendDays:WEEKEND_DAYS,...MODEL};
function median(a){a=a.slice().sort((x,y)=>x-y);const n=a.length;return n?(n%2?a[(n-1)/2]:(a[n/2-1]+a[n/2])/2):0;}
// Seed booking-pace curve = fraction of FINAL bookings on the books by `lead` days out (leisure STR).
const PACE_SEED={ // expected fraction of FINAL bookings already on the books by `lead` days out.
  // Back-loaded for this drive-to glamping resort: bulk of bookings land inside 45 days; rare beyond 90 (so a
  // far-out empty night reads as ~ON pace, not behind). Steep ramp inside 45 up to the target by the stay night.
  weekend:[[0,1],[7,.85],[14,.72],[21,.62],[30,.50],[45,.35],[60,.22],[90,.12],[120,.08],[180,.05],[270,.03],[365,.02]],
  weekday:[[0,1],[7,.82],[14,.68],[21,.57],[30,.45],[45,.30],[60,.18],[90,.10],[120,.07],[180,.04],[270,.025],[365,.015]]
};
const KB_SEED={format:"",items:[
  {topic:"Check-in time",a:"4:00 PM"},{topic:"Checkout time",a:"11:00 AM"},
  {topic:"WiFi network & password",a:""},{topic:"Parking",a:""},
  {topic:"Address & directions",a:""},{topic:"Resort amenities (Parkside Resort)",a:""},
  {topic:"Tepee amenities (in-unit)",a:""},{topic:"Pet policy",a:""},
  {topic:"Smoking policy",a:""},{topic:"Max occupancy",a:""},
  {topic:"Heating / air conditioning",a:""},{topic:"Trash & recycling",a:""},
  {topic:"Quiet hours",a:""},{topic:"Early check-in / late checkout",a:""},
  {topic:"Cancellation policy",a:""},{topic:"Emergency / who to contact",a:""}
]};
const DEFAULTS={targets:SEED_TARGETS,auto_sync:false,overrides:{},kb:KB_SEED,messaging_enabled:false};
const OWNERREZ_ICAL={486910:"https://app.ownerrez.com/feeds/ical/8f39d35971614fe68f65c2d60ebee98a",486911:"https://app.ownerrez.com/feeds/ical/8b443e66b91d42f78312c1b96456e721",486912:"https://app.ownerrez.com/feeds/ical/c11b9bdcccd0407b94a471ec1d4bf184",486913:"https://app.ownerrez.com/feeds/ical/6b7aadd1089a4545acfd76d4896cd1f4",486891:"https://app.ownerrez.com/feeds/ical/a803006016a94e429b22c4af21655c6e",486914:"https://app.ownerrez.com/feeds/ical/a6a81900436e48538ca68c999084a00f",486915:"https://app.ownerrez.com/feeds/ical/a33c27437b734216b0f153e4d112673b",486916:"https://app.ownerrez.com/feeds/ical/2fc1ac9ea2a744708fe515fec9a45543",486917:"https://app.ownerrez.com/feeds/ical/b5e770592bfe401c93c472df3ca912e1",486918:"https://app.ownerrez.com/feeds/ical/5706333006cf4e34a1ed058c9f3a695a"}; // OwnerRez availability/blocks = single occupancy source
const SKEY="parkside:state";

async function getState(){ if(!redis) return JSON.parse(JSON.stringify(DEFAULTS)); const s=await redis.get(SKEY); return {...JSON.parse(JSON.stringify(DEFAULTS)),...(s||{})}; }
async function setState(p){ const cur=await getState(); const next={...cur,...p}; delete next.icals; if(redis) await redis.set(SKEY,next); return next; }
const isWe=d=>KNOBS.weekendDays.includes(d.getUTCDay());
function targetFor(d,t){ const m=t[d.getUTCMonth()+1]; return isWe(d)?m.we:m.wd; }
function monthLead(ds,today){ const first=new Date(ds.slice(0,7)+"-01T00:00:00Z"); const t=new Date(today+"T00:00:00Z"); return Math.max(0,Math.round((first-t)/86400000)); }
function curMonthStart(today){ return today.slice(0,8)+"01"; }
function daysBetween(a,b){ return Math.round((new Date(b+"T00:00:00Z")-new Date(a+"T00:00:00Z"))/86400000); }
// Whole-month occupancy MEASUREMENT: aggregate booked nights over the FULL current calendar month (1st..end),
// not just today..end-of-month. poolAgg/unitAgg are whole-month; nightPool/gaps stay forward-only (rates only on future nights).
async function getOccData(st, today, days, useCache){
  const ms=curMonthStart(today); const daysMS=days+daysBetween(ms,today);
  const booked=await getBooked(st, ms, daysMS, useCache);
  const occAgg=buildAgg(booked, ms, daysMS);
  const fwdAgg=buildAgg(booked, today, days);
  const agg={ poolAgg:occAgg.poolAgg, unitAgg:occAgg.unitAgg, nightPool:fwdAgg.nightPool, gaps:fwdAgg.gaps };
  return { booked, agg, monthStart:ms, daysMS };
}
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
  if(useCache&&redis){ const c=await redis.get("parkside:booked2"); if(c&&(Date.now()-c.ts)<3600000) return {byUnit:c.byUnit,total:c.total,channels:c.channels}; }
  const out={}; for(const u of UNITS)out[u.orp]={};
  const s=new Date(start+"T00:00:00Z"); const end=new Date(s); end.setUTCDate(end.getUTCDate()+days); let total=0; const channels={};
  for(const u of UNITS){ const urls=[OWNERREZ_ICAL[u.orp]].filter(Boolean); channels[u.orp]=0;
    for(const url of urls){ try{ const r=await fetch(url,{headers:{"User-Agent":"parkside-control/1.0"}}); if(!r.ok) continue; const t=await r.text(); channels[u.orp]++;
      for(const [a,c] of parseIcs(t)){ let d=new Date(a.slice(0,4)+"-"+a.slice(4,6)+"-"+a.slice(6,8)+"T00:00:00Z"); const e=new Date(c.slice(0,4)+"-"+c.slice(4,6)+"-"+c.slice(6,8)+"T00:00:00Z");
        for(;d<e;d.setUTCDate(d.getUTCDate()+1)){ if(d>=s&&d<end){ const k=d.toISOString().slice(0,10); if(!out[u.orp][k]){out[u.orp][k]=true; total++;} } } }
    }catch{} } }
  if(redis) await redis.set("parkside:booked2",{ts:Date.now(),byUnit:out,total,channels}); return {byUnit:out,total,channels};
}
function buildAgg(booked,start,days){
  const s=new Date(start+"T00:00:00Z"); const unitAgg={},poolAgg={},nightPool={}; for(const u of UNITS)unitAgg[u.orp]={};
  for(let i=0;i<days;i++){ const d=new Date(s); d.setUTCDate(d.getUTCDate()+i); const ds=d.toISOString().slice(0,10); const mk=ds.slice(0,7); const dt=isWe(d)?1:0; let nb=0;
    if(!poolAgg[mk])poolAgg[mk]=[{b:0,t:0},{b:0,t:0}];
    for(const u of UNITS){ if(!unitAgg[u.orp][mk])unitAgg[u.orp][mk]=[{b:0,t:0},{b:0,t:0}];
      unitAgg[u.orp][mk][dt].t++; poolAgg[mk][dt].t++; if(booked.byUnit[u.orp][ds]){ unitAgg[u.orp][mk][dt].b++; poolAgg[mk][dt].b++; nb++; } }
    nightPool[ds]=nb/UNITS.length; }
  // Per-unit orphan/short-gap detection: maximal runs of OPEN nights trapped (booked on BOTH sides) within the horizon.
  const gaps={}; for(const u of UNITS)gaps[u.orp]={};
  const dsAt=i=>{const d=new Date(s);d.setUTCDate(d.getUTCDate()+i);return d.toISOString().slice(0,10);};
  for(const u of UNITS){ const B=x=>!!booked.byUnit[u.orp][x]; let i=0;
    while(i<days){ if(B(dsAt(i))){i++;continue;} let j=i; const run=[]; while(j<days&&!B(dsAt(j))){run.push(dsAt(j));j++;}
      const trapped = i>0 && B(dsAt(i-1)) && j<days && B(dsAt(j)); const runLen=run.length;
      const hasWeekend=run.some(x=>WEEKEND_DAYS.includes(new Date(x+"T00:00:00Z").getUTCDay()));
      if(trapped && runLen<=3){ for(const x of run) gaps[u.orp][x]={runLen,hasWeekend}; }
      i=j; } }
  return {unitAgg,poolAgg,nightPool,gaps};
}
// Bounded, lead-scaled adjustment ON TOP of the seasonal base (=PriceLabs signal x unit premium).
// delta = how far ahead/behind the pace trajectory we are. sens(lead) shrinks the reaction far out
// (a date that is naturally empty 6 months out is NOT "behind"). Ahead -> premium; behind -> discount.
// scar = extra premium as the pool genuinely fills. Returns a multiplier centered on 1.0.
function paceMult(poolOcc,exp,lead,premScale){ // pace lever (ahead/behind trajectory). premScale (learned) scales the UPSIDE only.
  premScale=premScale||1; const sens=interp(SENS,lead); const delta=poolOcc-exp;
  let adj = delta>=0 ? Math.min(1,delta/MODEL.UPSPAN)*MODEL.MAXUP*premScale : -Math.min(1,(-delta)/MODEL.DOWNSPAN)*MODEL.MAXDOWN;
  return 1+adj*sens;
}
// Night-level scarcity: how full the WHOLE resort is for this specific night (our portfolio edge). premScale (learned) scales the cap.
function scarMult(nightOcc,lead,premScale){ premScale=premScale||1; const sens=interp(SENS,lead); const thr=MODEL.SCAR_FAR-(MODEL.SCAR_FAR-MODEL.SCAR_NEAR)*sens; return Math.min(MODEL.SCAR_CAP*premScale,Math.max(0,nightOcc-thr)*MODEL.SCAR_GAIN)*sens; }
// Orphan / short-gap discount multiplier from a (possibly learned) depth map gapD by run length; weekend anchor -> x0.4 (easier to fill).
function gapGm(runLen,hasWeekend,gapD){ const d=(gapD&&gapD[runLen]!=null)?gapD[runLen]:(GAP_SEED[runLen]||0); return 1-d*(hasWeekend?0.4:1); }
function compute(signalMap,targets,today,startDate,days,occ,overrides,learned){
  const start=new Date(startDate+"T00:00:00Z"); const out=[]; overrides=overrides||{}; learned=learned||{};
  const ps=learned.premScale||1; const uPrem=learned.unitPrem||{}; const gapD=learned.gapD||GAP_SEED;
  const sv=Object.values(signalMap).filter(v=>v>0); const peakThr=(sv.length?median(sv):FLOOR)*MODEL.PEAK_MULT; // peak nights = top of the year
  const poolCache={};
  for(let i=0;i<days;i++){ const d=new Date(start); d.setUTCDate(d.getUTCDate()+i); const ds=d.toISOString().slice(0,10); const mk=ds.slice(0,7); const mo=d.getUTCMonth()+1; const we=isWe(d); const dt=we?1:0; const dtN=we?"weekend":"weekday";
    let sig=signalMap[ds]; if(sig==null) sig=signalFallback(signalMap,ds); const peak=sig>=peakThr; const ceil=peak?MODEL.PEAK_CEIL:CEIL;
    const lead=Math.max(0,Math.round((d-start)/86400000)); // EXACT days from today to THIS stay night -> continuous, per-day pace
    let poolOcc=0,exp=0;
    if(occ.hasData&&occ.mock==null){ const ck=mk+"|"+dt; if(poolCache[ck]===undefined){ const pa=occ.agg.poolAgg[mk]&&occ.agg.poolAgg[mk][dt]; poolCache[ck]=pa&&pa.t?pa.b/pa.t:0; } poolOcc=poolCache[ck];
      const tg=we?targets[mo].we:targets[mo].wd; exp=tg*paceFrac(lead,dtN,learned); }
    for(const u of UNITS){ const key=u.orp+"|"+ds; let amount,overridden=false,orphan=false,gapLen=0,baseOut=0;
      if(overrides[key]!=null){ amount=Math.round(Math.max(OV_MIN,Math.min(OV_MAX,Number(overrides[key])))); overridden=true; baseOut=amount; }
      else { const prem=uPrem[u.orp]||UNIT_PREM[u.orp]||1.0; const base=sig*prem; baseOut=Math.round(base);
        if(!occ.hasData){ amount=Math.max(FLOOR,Math.min(ceil,Math.round(base))); }
        else if(occ.mock!=null){ const tg=we?targets[mo].we:targets[mo].wd; const e2=tg*paceFrac(lead,dtN,learned); let m=paceMult(occ.mock,e2,lead,ps)+scarMult(occ.mock,lead,ps); if(peak)m=Math.max(1,m); m=Math.max(MODEL.MULT_MIN,Math.min(MODEL.MULT_MAX,m)); amount=Math.max(FLOOR,Math.min(ceil,Math.round(base*m))); }
        else { const g=occ.agg.gaps&&occ.agg.gaps[u.orp]&&occ.agg.gaps[u.orp][ds]; let m;
          if(g){ orphan=true; gapLen=g.runLen; m=paceMult(poolOcc,exp,lead,ps)*gapGm(g.runLen,g.hasWeekend,gapD); } // orphan: discount to fill; OVERRIDE scarcity premium & per-unit bump
          else { m=paceMult(poolOcc,exp,lead,ps)+scarMult((occ.agg.nightPool&&occ.agg.nightPool[ds])||0,lead,ps);
            const ua=occ.agg.unitAgg[u.orp][mk]&&occ.agg.unitAgg[u.orp][mk][dt]; const unitOcc=ua&&ua.t?ua.b/ua.t:0; const sens=interp(SENS,lead);
            let un=(unitOcc-poolOcc)*MODEL.UNIT_GAIN*sens; un=Math.max(-MODEL.UNIT_CAP,Math.min(MODEL.UNIT_CAP,un)); m=m*(1+un); } // gentle per-unit scarcity
          if(peak)m=Math.max(1,m); // peak nights never discounted below seasonal market base (peak wins over orphan)
          m=Math.max(MODEL.MULT_MIN,Math.min(MODEL.MULT_MAX,m));
          amount=Math.max(FLOOR,Math.min(ceil,Math.round(base*m))); } }
      out.push({property_id:u.orp,unit:u.name,date:ds,amount,currency:"USD",overridden,orphan,base:baseOut,gapLen}); } }
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
  const snap={}; // [price, bookedFlag, gapLen, premBucket, unit]
  for(const r of rates){ const d=new Date(r.date+"T00:00:00Z"); if(d<start||d>=lim) continue;
    const bk=booked.byUnit[r.property_id][r.date]?1:0; const base=r.base||r.amount; const pb=r.amount>base*1.05?"prem":(r.amount<base*0.95?"disc":"neu");
    snap[r.property_id+"|"+r.date]=[r.amount,bk,r.gapLen||0,pb,r.property_id]; }
  const prev=(await redis.get("parkside:snap"))||{}; const events=[];
  // Hazard-rate learning store: per night that was OPEN at the last snapshot, count it as one exposure-day;
  // if it flipped to booked since, count a booking. Bucketed by unit / gap-length / premium-state.
  const L=(await redis.get("parkside:learn"))||{}; L.unit=L.unit||{}; L.gap=L.gap||{}; L.prem=L.prem||{};
  const inc=(o,k,fld)=>{const kk=String(k);o[kk]=o[kk]||{open:0,book:0};o[kk][fld]++;};
  for(const k in prev){ const p=prev[k]; if(!Array.isArray(p)||p[1]!==0) continue; // was OPEN -> one exposure-day
    const gapLen=p[2]||0, pb=p[3]||"neu", unit=p[4]!=null?p[4]:Number(k.split("|")[0]);
    inc(L.unit,unit,"open"); inc(L.gap,gapLen,"open"); inc(L.prem,pb,"open");
    const cur=snap[k]; if(cur&&cur[1]===1){ inc(L.unit,unit,"book"); inc(L.gap,gapLen,"book"); inc(L.prem,pb,"book");
      const date=k.split("|")[1]; const night=new Date(date+"T00:00:00Z"); const lead=Math.round((night-start)/86400000); const dow=night.getUTCDay();
      events.push({unit:Number(unit),date,priceShown:p[0],lead,daytype:[5,6].includes(dow)?"weekend":"weekday",observed:today}); } }
  if(events.length){ const log=(await redis.get("parkside:events"))||[]; await redis.set("parkside:events",log.concat(events).slice(-5000)); }
  await redis.set("parkside:learn",L); await redis.set("parkside:snap",snap); return events.length;
}
// Derive ALL learned levers from accumulated outcomes, each blended with its seed by a confidence weight.
// With no data every lever == its seed, so behaviour is unchanged until outcomes accrue.
function deriveLearned(events,L){
  const pace=buildLearnedPace(events); L=L||{}; const U=L.unit||{},G=L.gap||{},P=L.prem||{};
  // (a) UNIT PREMIUMS from relative booking hazard (a unit that books faster than the resort mean earns a higher premium)
  const unitPrem={},unitDetail={}; let tb=0,to=0; for(const u of UNITS){const sx=U[u.orp]||{open:0,book:0}; tb+=sx.book; to+=sx.open;}
  const meanH=to>0?tb/to:0;
  for(const u of UNITS){ const seed=UNIT_PREM[u.orp]||1.0; const sx=U[u.orp]||{open:0,book:0}; let eff=seed,df=1,w=0;
    if(meanH>0&&sx.open>0){ const h=sx.book/sx.open; df=Math.max(0.7,Math.min(1.4,h/meanH)); w=Math.min(0.6,sx.book/(sx.book+60)); eff=seed*(1+w*(df-1)); }
    eff=Math.max(0.85,Math.min(1.30,eff)); unitPrem[u.orp]=eff; unitDetail[u.orp]={name:u.name,seed,eff:Number(eff.toFixed(3)),book:sx.book,open:sx.open,w:Number(w.toFixed(2))}; }
  // (b) ORPHAN-GAP DISCOUNT DEPTH from orphan vs normal hazard (if discounted orphans still under-fill, deepen the cut)
  const gapD={},gapDetail={}; const norm=G[0]||{open:0,book:0}; const hN=norm.open>0?norm.book/norm.open:0;
  for(const len of [1,2,3]){ const seed=GAP_SEED[len]; const sx=G[len]||{open:0,book:0}; let eff=seed,factor=1,w=0;
    if(hN>0&&sx.open>0){ const h=sx.book/sx.open; const ratio=h>0?h/hN:0.01; factor=Math.max(0.5,Math.min(2,1/Math.max(ratio,0.01))); w=Math.min(0.6,sx.open/(sx.open+200)); eff=seed*(1+w*(factor-1)); }
    eff=Math.max(0.02,Math.min(0.5,eff)); gapD[len]=eff; gapDetail[len]={seed,eff:Number(eff.toFixed(3)),book:sx.book,open:sx.open,w:Number(w.toFixed(2))}; }
  // (c) PREMIUM AGGRESSIVENESS scale from premium vs neutral hazard (if premium nights still book, push harder; if they stall, ease off)
  let premScale=1.0,premW=0,premRatio=null; const PR=P.prem||{open:0,book:0},NE=P.neu||{open:0,book:0};
  if(PR.open>0&&NE.open>0){ const hP=PR.book/PR.open,hNe=NE.book/NE.open; if(hNe>0){ premRatio=hP/hNe; premW=Math.min(0.5,(PR.open+NE.open)/((PR.open+NE.open)+400)); premScale=Math.max(0.7,Math.min(1.3,1+premW*(premRatio-0.85))); } }
  return {weekend:pace.weekend,weekday:pace.weekday,unitPrem,gapD,premScale,
    detail:{unit:unitDetail,gap:gapDetail,prem:{scale:Number(premScale.toFixed(3)),w:Number(premW.toFixed(2)),ratio:premRatio==null?null:Number(premRatio.toFixed(2)),premOpen:PR.open,neuOpen:NE.open}}};
}
async function getLearned(){ const ev=(redis&&await redis.get("parkside:events"))||[]; const L=(redis&&await redis.get("parkside:learn"))||{}; return deriveLearned(ev,L); }

function monthList(today,days){ const start=new Date(today+"T00:00:00Z"); const set={}; for(let i=0;i<days;i++){const d=new Date(start);d.setUTCDate(d.getUTCDate()+i); set[d.toISOString().slice(0,7)]=1;} return Object.keys(set).sort(); }
function computePace(poolAgg,targets,learned,today,months){ const pace={};
  for(const mk of months){ const lead=monthLead(mk+"-15",today); const tgt=targets[parseInt(mk.slice(5))]; const pa=poolAgg[mk]||[{b:0,t:0},{b:0,t:0}];
    const f=(dt,dn,tv)=>{const act=pa[dt].t?Math.round(100*pa[dt].b/pa[dt].t):0; const exp=Math.round(100*tv*paceFrac(lead,dn,learned)); return {act,exp,status:act>=exp?"ahead":"behind"};};
    pace[mk]={wknd:f(1,"weekend",tgt.we),wkdy:f(0,"weekday",tgt.wd)}; }
  return pace; }
// ===== Guest-messaging send path (added) =====
const APOLOGY="I'm sorry, I don't know the answer to that. Let me check with a manager and I'll get back to you soon.";
async function sendGuestReply(enabled, bookingId, body){
  if(!enabled) return {sent:false, staged:true, reason:"messaging toggle OFF (preview/test mode)"};
  const tok=process.env.OWNERREZ_OAUTH_TOKEN;
  if(!tok) return {sent:false, staged:true, reason:"no OWNERREZ_OAUTH_TOKEN (create OwnerRez OAuth app + Grant Access To Me)"};
  if(!bookingId) return {sent:false, staged:true, reason:"no booking_id (no inbound guest thread / no connected channel yet)"};
  try{ const r=await fetch("https://api.ownerrez.com/v2/messages",{method:"POST",
      headers:{Authorization:"Bearer "+tok,"Content-Type":"application/json","User-Agent":"parkside-control/1.0"},
      body:JSON.stringify({booking_id:bookingId, body})});
    const t=await r.text(); return {sent:r.ok, status:r.status, body:t.slice(0,200)}; }
  catch(e){ return {sent:false, error:String(e.message||e)}; }
}
// ===== Configurable SMS provider (replaces the old hardcoded Twilio / "Willow" path) =====
// Fully env-driven so the owner can drop in the NEW number + ANY provider with no code change:
//   SMS_PROVIDER      "twilio" | "none"   (default "none" => staged; nothing is actually sent)
//   SMS_FROM_NUMBER   new outbound number, E.164   (falls back to legacy TWILIO_FROM)
//   SMS_VICTOR_NUMBER Victor's approval number, E.164  (falls back to legacy VICTOR_PHONE)
//   twilio creds:     SMS_TWILIO_SID + SMS_TWILIO_TOKEN  (fall back to TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN)
// Add another provider by extending the switch below — the rest of the app calls sendSms().
function smsProvider(){ return String(process.env.SMS_PROVIDER||"none").toLowerCase().trim(); }
function smsFrom(){ return process.env.SMS_FROM_NUMBER||process.env.TWILIO_FROM||""; }
function victorNumber(){ return process.env.SMS_VICTOR_NUMBER||process.env.VICTOR_PHONE||""; }
function smsConfigured(){ const p=smsProvider(); if(p==="none"||!p) return false; if(!smsFrom()) return false;
  if(p==="twilio") return !!((process.env.SMS_TWILIO_SID||process.env.TWILIO_ACCOUNT_SID)&&(process.env.SMS_TWILIO_TOKEN||process.env.TWILIO_AUTH_TOKEN));
  return false; }
async function sendSms(to, body){
  const provider=smsProvider(), from=smsFrom();
  if(provider==="none"||!provider) return {sent:false, staged:true, reason:"SMS_PROVIDER not set (configure SMS_PROVIDER + SMS_FROM_NUMBER + creds to go live)"};
  if(!to) return {sent:false, staged:true, reason:"no destination number"};
  if(!from) return {sent:false, staged:true, reason:"SMS_FROM_NUMBER not set"};
  if(provider==="twilio"){
    const sid=process.env.SMS_TWILIO_SID||process.env.TWILIO_ACCOUNT_SID, auth=process.env.SMS_TWILIO_TOKEN||process.env.TWILIO_AUTH_TOKEN;
    if(!sid||!auth) return {sent:false, staged:true, reason:"twilio creds missing (SMS_TWILIO_SID/SMS_TWILIO_TOKEN)"};
    try{ const r=await fetch("https://api.twilio.com/2010-04-01/Accounts/"+sid+"/Messages.json",{method:"POST",
        headers:{Authorization:"Basic "+Buffer.from(sid+":"+auth).toString("base64"),"Content-Type":"application/x-www-form-urlencoded"},
        body:new URLSearchParams({From:from,To:to,Body:body})});
      return {sent:r.ok, status:r.status, provider:"twilio"}; }
    catch(e){ return {sent:false, error:String(e.message||e)}; }
  }
  return {sent:false, staged:true, reason:"unknown SMS_PROVIDER '"+provider+"'"};
}
// Text Victor for approvals/escalations (staged until the provider is configured).
async function smsVictor(enabled, text){
  if(!enabled) return {sent:false, staged:true, reason:"messaging toggle OFF (preview/test mode)"};
  return sendSms(victorNumber(), text);
}

// ===== Approval queue + knowledge-base matching (human-in-the-loop messaging) =====
const AQKEY="parkside:approvals", INQKEY="parkside:inquiries";
async function getApprovals(){ return (redis&&await redis.get(AQKEY))||[]; }
async function setApprovals(list){ if(redis) await redis.set(AQKEY, list.slice(-500)); return list; }
function normQ(x){ return String(x||"").toLowerCase().replace(/[^a-z0-9]+/g," ").trim(); }

// Deterministic auto-approve matcher: map a guest question to a KB topic; if that
// topic has a saved (non-empty) answer, it's a known/high-confidence answer.
const TOPIC_SYNONYMS=[
  {topic:"Checkout time", kw:["checkout","check out","check-out","leave by","what time .*out"]},
  {topic:"Check-in time", kw:["check in","check-in","checkin","arrive","arrival time","what time .*in"]},
  {topic:"WiFi network & password", kw:["wifi","wi-fi","internet","wireless","network password"]},
  {topic:"Parking", kw:["parking","park the car","where .*park"]},
  {topic:"Address & directions", kw:["address","directions","how .*get there","where .*located","gps"]},
  {topic:"Pet policy", kw:["pet","pets","dog","dogs","cat","animal"]},
  {topic:"Smoking policy", kw:["smoke","smoking","vape","cigarette"]},
  {topic:"Max occupancy", kw:["occupancy","how many .*people","how many .*guests","sleep","capacity","max guests"]},
  {topic:"Heating / air conditioning", kw:["heat","heating","air conditioning","a c","ac unit","cold at night","temperature"]},
  {topic:"Quiet hours", kw:["quiet hours","noise","too loud","quiet time"]},
  {topic:"Early check-in / late checkout", kw:["early check","late checkout","late check-out","early arrival","check in early"]},
  {topic:"Cancellation policy", kw:["cancel","cancellation","refund","get my money back"]},
  {topic:"Resort amenities (Parkside Resort)", kw:["amenities","pool","hot tub","resort","activities","lazy river","water park"]},
  {topic:"Trash & recycling", kw:["trash","garbage","recycle","recycling","dumpster"]},
  {topic:"Emergency / who to contact", kw:["emergency","who do i contact","help line","phone number to call"]},
];
function kbAutoMatch(kb, question){
  const q=" "+normQ(question)+" "; const items=(kb&&kb.items)||[];
  const findItem=t=>items.find(i=>normQ(i.topic)===normQ(t));
  for(const m of TOPIC_SYNONYMS){
    for(const k of m.kw){ const re=new RegExp("\\b"+k.replace(/\s+/g,"\\s+")+"\\b","i");
      if(re.test(q)){ const it=findItem(m.topic); if(it&&String(it.a||"").trim()) return {topic:m.topic, answer:String(it.a).trim(), confidence:0.9}; } }
  }
  // Fallback: every significant token of a KB topic appears in the question.
  for(const it of items){ if(!String(it.a||"").trim()) continue;
    const tks=normQ(it.topic).split(" ").filter(w=>w.length>3);
    if(tks.length&&tks.every(w=>q.indexOf(" "+w)>=0)) return {topic:it.topic, answer:String(it.a).trim(), confidence:0.75}; }
  return null;
}
// KB-grounded AI draft (same policy as the ai_draft action). Returns {inKb, answer}.
async function aiDraftAnswer(kb, question){
  const key=process.env.ANTHROPIC_API_KEY; if(!key) return {inKb:false, answer:"", noKey:true};
  const facts=((kb&&kb.items)||[]).filter(i=>i&&i.a&&String(i.a).trim()).map(i=>"- "+i.topic+": "+i.a).join("\n");
  const sys="You are the guest-messaging assistant for Parkside Tepees (glamping tepees at Parkside Resort, Pigeon Forge TN). "
    +"You have NO knowledge except the KNOWN INFO list below. Decide if KNOWN INFO DIRECTLY and FULLY answers the question. "
    +"NEVER guess or infer. Reply with ONLY a JSON object: {\"in_kb\": true|false, \"answer\": \"...\"}. "
    +"If in_kb is false, answer MUST be \"\". If true, 1-2 short warm sentences, 'we/us'. \n\nKNOWN INFO:\n"+(facts||"(none saved yet)");
  try{ const r=await fetch("https://api.anthropic.com/v1/messages",{method:"POST",headers:{"x-api-key":key,"anthropic-version":"2023-06-01","content-type":"application/json"},body:JSON.stringify({model:"claude-haiku-4-5-20251001",max_tokens:400,temperature:0,system:sys,messages:[{role:"user",content:String(question)}]})});
    const j=await r.json(); if(!r.ok) return {inKb:false, answer:"", error:JSON.stringify(j).slice(0,200)};
    let text=((j.content&&j.content[0]&&j.content[0].text)||"").trim();
    try{ const m=text.match(/\{[\s\S]*\}/); const o=JSON.parse(m?m[0]:text); return {inKb:o.in_kb===true, answer:String(o.answer||"").trim()}; }
    catch{ return {inKb:false, answer:""}; }
  }catch(e){ return {inKb:false, answer:"", error:String(e.message||e)}; }
}
// Decide a queued approval item: YES -> send to guest + learn into KB; NO -> reject.
async function decideApproval(id, decision, overrideAnswer){
  if(!id) return {ok:false, error:"no id"};
  const list=await getApprovals(); const it=list.find(x=>x.id===id);
  if(!it) return {ok:false, error:"item not found: "+id};
  if(it.status!=="pending") return {ok:false, error:"already "+it.status, item:it};
  const st=await getState(); const enabled=!!st.messaging_enabled;
  if(decision==="yes"||decision==="approve"){
    const answer=(overrideAnswer&&overrideAnswer.trim())||it.proposed||"";
    if(!answer) return {ok:false, error:"no answer to send (proposed was empty — supply an answer)"};
    const guestSend=await sendGuestReply(enabled, it.booking_id, answer);
    const kb=st.kb||JSON.parse(JSON.stringify(KB_SEED)); kb.items=kb.items||[];
    const nt=normQ(it.question); const existing=nt?kb.items.find(x=>normQ(x.topic)===nt):null;
    if(existing) existing.a=answer; else kb.items.push({topic:it.question.slice(0,60), a:answer, src:"approved"});
    await setState({kb});
    it.status="approved"; it.answer=answer; it.decidedAt=new Date().toISOString();
    await setApprovals(list);
    return {ok:true, decision:"approved", id, guestSend, sent:guestSend.sent===true, learned:true};
  }
  it.status="rejected"; it.decidedAt=new Date().toISOString(); await setApprovals(list);
  return {ok:true, decision:"rejected", id};
}

module.exports=async(req,res)=>{
  try{
    const action=(req.query&&req.query.action)||""; const today=new Date().toISOString().slice(0,10), days=365;
    if(action==="state"){
      if(req.method==="GET"){ const s=await getState(); const icalCount={}; for(const u of UNITS) icalCount[u.orp]=OWNERREZ_ICAL[u.orp]?1:0;
        return res.status(200).json({targets:s.targets,knobs:KNOBS,auto_sync:s.auto_sync,overrides:s.overrides||{},icalCount,occupancySource:'ownerrez',kb:s.kb||KB_SEED,messaging_enabled:!!s.messaging_enabled}); }
      if(req.method==="POST"){ if((req.headers["x-app-password"]||"")!==(process.env.APP_PASSWORD||"")) return res.status(401).json({error:"unauthorized"});
        let b=req.body; if(typeof b==="string"){try{b=JSON.parse(b);}catch{return res.status(400).json({error:"bad json"});}}
        const cur=await getState(); const p={};
        if(b&&b.targets)p.targets=b.targets; if(b&&typeof b.auto_sync==="boolean")p.auto_sync=b.auto_sync; if(b&&b.kb)p.kb=b.kb; if(b&&typeof b.messaging_enabled==="boolean")p.messaging_enabled=b.messaging_enabled;
        if(b&&b.overrideSet){ const o={...(cur.overrides||{})}; o[b.overrideSet.property_id+"|"+b.overrideSet.date]=Math.round(Math.max(OV_MIN,Math.min(OV_MAX,Number(b.overrideSet.amount)))); p.overrides=o; }
        if(b&&b.overrideClear){ const o={...(cur.overrides||{})}; delete o[b.overrideClear.property_id+"|"+b.overrideClear.date]; p.overrides=o; }
        const n=await setState(p); if(redis) await redis.del("parkside:booked2"); return res.status(200).json({ok:true,auto_sync:n.auto_sync,messaging_enabled:!!n.messaging_enabled}); }
      return res.status(405).json({error:"GET or POST"});
    }
    if(action==="occupancy"){
      const st=await getState(); const learned=await getLearned();
      const od=await getOccData(st,today,days, !(req.query&&req.query.fresh==="1"));
      const booked=od.booked; const wmStart=od.monthStart; const daysMS=od.daysMS;
      const start=new Date(wmStart+"T00:00:00Z"); const monthTotal={};
      for(let i=0;i<daysMS;i++){ const d=new Date(start); d.setUTCDate(d.getUTCDate()+i); const mk=d.toISOString().slice(0,7); monthTotal[mk]=(monthTotal[mk]||0)+1; }
      const months=Object.keys(monthTotal).sort(); const byUnit={};
      for(const u of UNITS){ const dates=Object.keys(booked.byUnit[u.orp]); const mc={}; for(const ds of dates){const mk=ds.slice(0,7); mc[mk]=(mc[mk]||0)+1;}
        const monthly={}; for(const mk of months) monthly[mk]=Math.round(100*((mc[mk]||0)/monthTotal[mk])); byUnit[u.orp]={booked:dates,monthly}; }
      const pace=computePace(od.agg.poolAgg, st.targets, learned, today, months);
      return res.status(200).json({units:UNITS.map(u=>({orp:u.orp,name:u.name})),months,byUnit,pace,paceLearn:{weekend:learned.weekend.n||0,weekday:learned.weekday.n||0,blendWeight:Math.min(0.8,((learned.weekend.n||0)+(learned.weekday.n||0))/600).toFixed(2)},totalBooked:booked.total,channels:booked.channels});
    }
    if(action==="logs"){
      if((req.headers["x-app-password"]||"")!==(process.env.APP_PASSWORD||"")) return res.status(401).json({error:"unauthorized"});
      const snap=(redis&&await redis.get("parkside:snap"))||{}; const events=(redis&&await redis.get("parkside:events"))||[]; const learned=await getLearned();
      return res.status(200).json({snapshotCells:Object.keys(snap).length, eventCount:events.length,
        learned:{paceEvents:{weekend:learned.weekend.n||0,weekday:learned.weekday.n||0},unitPrem:learned.detail.unit,gapDiscount:learned.detail.gap,premiumScale:learned.detail.prem},
        recentEvents:events.slice(-15)});
    }
    if(action==="preview"){
      let b=req.body; if(typeof b==="string"){try{b=JSON.parse(b);}catch{b={};}}
      const st=await getState(); const targets=(b&&b.targets)||st.targets; const sig=await getSignal(); const learned=await getLearned();
      let occ; if(b&&typeof b.mockOcc==="number") occ={hasData:true,mock:b.mockOcc};
      else { const od=await getOccData(st,today,days,true); occ={hasData:od.booked.total>0, agg:od.agg}; }
      const rates=compute(sig,targets,today,today,days,occ,st.overrides,learned); const amts=rates.map(r=>r.amount);
      const pace = occ.agg ? computePace(occ.agg.poolAgg, targets, learned, today, monthList(today,days)) : null;
      const paceLearn={weekend:learned.weekend.n||0,weekday:learned.weekday.n||0,blendWeight:Math.min(0.8,((learned.weekend.n||0)+(learned.weekday.n||0))/600).toFixed(2)};
      return res.status(200).json({mode:"PREVIEW",wrote:false,count:rates.length,coldStart:!occ.hasData,min:Math.min(...amts),max:Math.max(...amts),avg:Math.round(amts.reduce((a,c)=>a+c,0)/amts.length),overrideCount:rates.filter(r=>r.overridden).length,pace,paceLearn,rates});
    }
    if(action==="run"){
      const okAuth=((req.headers["authorization"]||"")==="Bearer "+(process.env.CRON_SECRET||"__x")) || ((req.headers["x-app-password"]||"")===(process.env.APP_PASSWORD||"__x"));
      if(!okAuth) return res.status(401).json({error:"unauthorized"});
      const st=await getState(); const sig=await getSignal(); const learned=await getLearned();
      const od=await getOccData(st,today,days,false); const booked=od.booked;
      const occ={hasData:booked.total>0, agg:od.agg};
      const rates=compute(sig,st.targets,today,today,days,occ,st.overrides,learned);
      const logged=await logPhase1(rates,booked,today);
      if(!st.auto_sync) return res.status(200).json({mode:"COMPUTED_NO_SYNC",auto_sync:false,computed:rates.length,wrote:false,bookedNights:booked.total,logged,note:"auto-sync OFF — nothing written"});
      const r=await pushOwnerRez(rates); return res.status(r.ownerrezOk?200:502).json({mode:"LIVE_SYNC",auto_sync:true,bookedNights:booked.total,logged,overrides:rates.filter(x=>x.overridden).length,...r});
    }
        if(action==="ai_draft"){
      if((req.headers["x-app-password"]||"")!==(process.env.APP_PASSWORD||"")) return res.status(401).json({error:"unauthorized"});
      let b=req.body; if(typeof b==="string"){try{b=JSON.parse(b);}catch{b={};}}
      const question=(b&&b.question)||""; const bookingId=(b&&b.booking_id)||null;
      const key=process.env.ANTHROPIC_API_KEY; if(!key) return res.status(200).json({needKey:true,error:"ANTHROPIC_API_KEY not set on the server yet"});
      const st=await getState(); const kb=st.kb||KB_SEED; const enabled=!!st.messaging_enabled;
      const facts=(kb.items||[]).filter(i=>i&&i.a&&String(i.a).trim()).map(i=>"- "+i.topic+": "+i.a).join("\n");
      const sys="You are the guest-messaging assistant for Parkside Tepees (glamping tepees at Parkside Resort, Pigeon Forge TN). "
        +"You have NO knowledge except the KNOWN INFO list below. "
        +"Decide if KNOWN INFO DIRECTLY and FULLY answers the guest's question. "
        +"NEVER guess, infer, combine facts to deduce a new fact, or fall back on what is typical for rentals "
        +"(pets, smoking, parking, wifi, occupancy, early/late checkout, hot tub, amenities, anything). If it is not explicitly stated, it is NOT known. "
        +"Reply with ONLY a JSON object, no other text: {\"in_kb\": true|false, \"answer\": \"...\"}. "
        +"If in_kb is false, answer MUST be \"\". If true, write answer in 1-2 short sentences — warm, friendly, like Gavin's Airbnb messages, 'we/us', an occasional emoji ok, NO long sign-off — using ONLY KNOWN INFO. "
        +"\n\nKNOWN INFO:\n"+(facts||"(none saved yet)");
      try{
        const r=await fetch("https://api.anthropic.com/v1/messages",{method:"POST",headers:{"x-api-key":key,"anthropic-version":"2023-06-01","content-type":"application/json"},body:JSON.stringify({model:"claude-haiku-4-5-20251001",max_tokens:400,temperature:0,system:sys,messages:[{role:"user",content:String(question)}]})});
        const j=await r.json(); if(!r.ok) return res.status(200).json({error:"Anthropic API error",detail:JSON.stringify(j).slice(0,300)});
        let text=((j.content&&j.content[0]&&j.content[0].text)||"").trim();
        let inKb=false, answer="";
        try{ const m=text.match(/\{[\s\S]*\}/); const o=JSON.parse(m?m[0]:text); inKb=o.in_kb===true; answer=String(o.answer||"").trim(); }catch{ inKb=false; answer=""; }
        if(!inKb || !answer){
          const victorSms=await smsVictor(enabled, "Parkside escalation — guest asked: "+String(question).slice(0,300)+(bookingId?(" (booking "+bookingId+")"):""));
          const guestSend=await sendGuestReply(enabled, bookingId, APOLOGY);
          return res.status(200).json({escalate:true, escalatedTo:"Victor", draft:APOLOGY, victorSms, guestSend, sent:guestSend.sent===true});
        }
        const guestSend=await sendGuestReply(enabled, bookingId, answer);
        return res.status(200).json({escalate:false, draft:answer, guestSend, sent:guestSend.sent===true});
      }
      catch(e){ return res.status(200).json({error:"request failed: "+String(e.message||e)}); }
    }
            if(action==="confirm_test"){
      if((req.headers["x-app-password"]||"")!==(process.env.APP_PASSWORD||"")) return res.status(401).json({error:"unauthorized"});
      let b=req.body; if(typeof b==="string"){try{b=JSON.parse(b);}catch{b={};}}
      const ctx=(b&&b.context)||b||{};
      const stage=(String(ctx.stage||"1")==="2")?2:1;
      const name=String(ctx.guest_name||"").trim();
      const guestMsg=String(ctx.guest_message||"").trim();
      const unit=String(ctx.unit||"").trim();
      const checkin=String(ctx.checkin||"").trim();
      const checkout=String(ctx.checkout||"").trim();
      const channel=String(ctx.channel||"").trim().toLowerCase();
      const bookingRef=String(ctx.booking_ref||ctx.booking_id||"").trim();
      const API_CHANNELS=["airbnb","vrbo","booking","booking.com","direct"];
      const looksBlock = /^orb/i.test(bookingRef) || ["ical","block","blocked","brightside"].includes(channel) || (channel!=="" && !API_CHANNELS.includes(channel));
      if(looksBlock){ return res.status(200).json({excluded:true, sent:false, dryRun:true, stage, reason:"Excluded: iCal 'Blocked-Off Time' / non-API channel. Confirmation messages fire only on real API-channel guest bookings (Airbnb / Vrbo / Booking.com) — never on Brightside iCal blocks."}); }
      const SLUG={"bear claw":"bear-claw","flyin' horse":"flyin-horse","flyin horse":"flyin-horse","mustang manor":"mustang-manor","soaring dreams":"soaring-dreams","arrowhead":"arrowhead","sunset stampede":"sunset-stampede","buffalo run":"buffalo-run","scarlet antler":"scarlet-antlers","scarlet antlers":"scarlet-antlers","cub house":"cub-house","flyin' free":"flyin-free","flyin free":"flyin-free"};
      const slug = SLUG[unit.toLowerCase()] || unit.toLowerCase().replace(/['’]/g,"").replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"");
      const ref = bookingRef || ("TEST-"+Date.now().toString(36));
      const key=process.env.ANTHROPIC_API_KEY; if(!key) return res.status(200).json({needKey:true,error:"ANTHROPIC_API_KEY not set on the server yet"});
      const isAirbnb = channel==="airbnb";
      let link=null, linkType, linkPending=false, autoConfirm=false, sys;
      if(stage===1){
        if(isAirbnb){
          const tmpl=process.env.OWNERREZ_EMAIL_URL||process.env.OWNERREZ_CLEANUP_URL||"";
          if(tmpl){ link = tmpl.indexOf("{REF}")>=0 ? tmpl.split("{REF}").join(encodeURIComponent(ref)) : tmpl; }
          else { link="‹OwnerRez email-provision link — pending API resolution›"; linkPending=true; }
          linkType="ownerrez_email";
          sys="You write ONE warm booking-confirmation message for Parkside Tepees (glamping tepees inside Parkside Resort, Pigeon Forge TN), sent right when an AIRBNB booking is CONFIRMED. Airbnb does not share the guest's email, so we must collect it. "
            +"Voice: warm, friendly, gracious — like Gavin's Airbnb messages. Open with 'Hi "+(name||"[Guest]")+",'. Say 'we/us'. An occasional emoji is fine. ~3-5 short sentences. "
            +"Personalize using the guest's own words when provided. Thank them for booking "+(unit||"their tepee")+(checkin?(" for "+checkin+(checkout?(" to "+checkout):"")):"")+". "
            +"Ask them to use the secure link to provide their email address so we can finalize the booking (OwnerRez will then send their confirmation). Put the link on its own line as the EXACT token ###LINK###. "
            +"Do NOT mention a rental agreement, the guidebook, or check-in details — this message is ONLY to collect their email. STRICT: stay-related only. Never mention marketing, mailing lists, off-platform booking, direct-booking discounts, reviews-for-reward, or any off-platform payment; never ask to move communication off-platform beyond this stay-related step. Output ONLY the message text.";
        } else {
          autoConfirm=true; linkType="auto_confirm";
          sys="You write ONE warm booking-confirmation message for Parkside Tepees (glamping tepees inside Parkside Resort, Pigeon Forge TN), sent when a "+(channel||"direct")+" booking is CONFIRMED. We ALREADY have the guest's email from this channel, so NO link and NO guest action are needed. "
            +"Voice: warm, friendly, gracious — like Gavin's Airbnb messages. Open with 'Hi "+(name||"[Guest]")+",'. Say 'we/us'. An occasional emoji is fine. ~2-4 short sentences. "
            +"Personalize using the guest's own words when provided. Thank them for booking "+(unit||"their tepee")+(checkin?(" for "+checkin+(checkout?(" to "+checkout):"")):"")+" and confirm they're all set. "
            +"Do NOT include any link, and do NOT ask them to click or provide anything. Do NOT mention the guidebook or check-in details yet. STRICT: stay-related only. Never mention marketing, mailing lists, off-platform booking, direct-booking discounts, reviews-for-reward, or any off-platform payment. Output ONLY the message text.";
        }
      } else {
        const gbase=process.env.STAYDECK_GUIDE_BASE||"https://guide.parksidetepees.com";
        link = gbase+"/g/"+(slug||""); linkType="staydeck_guidebook";
        sys="You write ONE warm follow-up message for Parkside Tepees, sent ONLY AFTER OwnerRez has sent its confirmation and the guest has COMPLETED it (email on file, booking fully finalized by OwnerRez). "
          +"Voice: warm, friendly — like Gavin's Airbnb messages. Open with 'Hi "+(name||"[Guest]")+",'. Say 'we/us'. An occasional emoji is fine. ~3-5 short sentences. "
          +"Let them know they're all set, and share their digital guidebook for "+(unit||"their tepee")+" with check-in details, Wi-Fi, directions, and resort info. Put the guidebook link on its own line as the EXACT token ###LINK###. "
          +"STRICT: stay-related only. No marketing, mailing lists, off-platform booking, discounts, reviews-for-reward, or off-platform payment. Output ONLY the message text.";
      }
      const userParts=["Guest name: "+(name||"(unknown)"),"Unit: "+(unit||"(unknown)"),"Dates: "+(checkin||"?")+" to "+(checkout||"?"),"Channel: "+(channel||"(unknown)"),"Stage: "+stage,"What the guest said: "+(guestMsg||"(nothing provided)")];
      try{
        const r=await fetch("https://api.anthropic.com/v1/messages",{method:"POST",headers:{"x-api-key":key,"anthropic-version":"2023-06-01","content-type":"application/json"},body:JSON.stringify({model:"claude-haiku-4-5-20251001",max_tokens:400,temperature:0.4,system:sys,messages:[{role:"user",content:userParts.join("\n")}]})});
        const j=await r.json(); if(!r.ok) return res.status(200).json({error:"Anthropic API error",detail:JSON.stringify(j).slice(0,300)});
        let msg=((j.content&&j.content[0]&&j.content[0].text)||"").trim();
        if(link){ if(msg.indexOf("###LINK###")===-1){ msg=msg+"\n\n"+link; } else { msg=msg.split("###LINK###").join(link); } }
        else { msg=msg.split("###LINK###").join("").trim(); }
        msg=msg.replace(/\{BUFIXUP\}/gi, link||"");
        return res.status(200).json({dryRun:true, sent:false, excluded:false, stage, channel, linkType, link, linkPending, autoConfirm, message:msg});
      }catch(e){ return res.status(200).json({error:"request failed: "+String(e.message||e)}); }
    }
    if(action==="kb_learn"){
      if((req.headers["x-app-password"]||"")!==(process.env.APP_PASSWORD||"")) return res.status(401).json({error:"unauthorized"});
      let b=req.body; if(typeof b==="string"){try{b=JSON.parse(b);}catch{b={};}}
      const st=await getState(); const kb=st.kb||JSON.parse(JSON.stringify(KB_SEED)); kb.items=kb.items||[];
      const norm=x=>String(x||"").toLowerCase().replace(/[^a-z0-9]+/g," ").trim();
      function upsert(topic,answer,src){ topic=String(topic||"").trim(); answer=String(answer||"").trim(); if(!answer) return null;
        const nt=norm(topic); let it=nt?kb.items.find(x=>norm(x.topic)===nt):null;
        if(it){ const changed=(it.a||"")!==answer; it.a=answer; if(src)it.src=src; return changed?"updated":"unchanged"; }
        kb.items.push({topic:topic||answer.slice(0,40),a:answer,src:src||"learned"}); return "added"; }
      // Accept: {entries:[{topic|question, a|answer, src}]} OR a single {topic|question, a|answer} OR {question,answer} (Victor flow)
      const list = Array.isArray(b&&b.entries)?b.entries : ((b&&(b.topic||b.question))?[b]:[]);
      let added=0,updated=0,unchanged=0;
      for(const e of list){ const r=upsert(e.topic||e.question, (e.a!=null?e.a:e.answer), e.src); if(r==="added")added++; else if(r==="updated")updated++; else if(r==="unchanged")unchanged++; }
      if(b&&typeof b.format==="string"&&b.format.trim()) kb.format=b.format;
      await setState({kb});
      return res.status(200).json({ok:true,added,updated,unchanged,total:kb.items.length});
    }
    if(action==="explain"){
      const st=await getState(); const sig=await getSignal(); const learned=await getLearned();
      const booked=await getBooked(st,today,days); const agg=buildAgg(booked,today,days);
      const months=monthList(today,days); const avg=a=>a.length?Math.round(a.reduce((x,y)=>x+y,0)/a.length):null;
      const byMonth={};
      for(const mk of months){ const we=[],wd=[]; for(const d in sig){ if(d.slice(0,7)!==mk)continue; (isWe(new Date(d+"T00:00:00Z"))?we:wd).push(sig[d]); }
        byMonth[mk]={avgWd:avg(wd),avgWe:avg(we),minWd:wd.length?Math.min(...wd):null,maxWe:we.length?Math.max(...we):null}; }
      const allv=Object.values(sig);
      let breakdown=null;
      if(req.query&&req.query.date){ const ds=req.query.date; const u=UNITS.find(x=>String(x.orp)===String(req.query.unit))||UNITS[0]; const d=new Date(ds+"T00:00:00Z"); const we=isWe(d),dt=we?1:0,dtN=we?"weekend":"weekday",mk=ds.slice(0,7),mo=d.getUTCMonth()+1;
        let s=sig[ds]; const sigMissing=(s==null); if(s==null)s=signalFallback(sig,ds);
        const sv=Object.values(sig).filter(v=>v>0); const peakThr=(sv.length?median(sv):FLOOR)*MODEL.PEAK_MULT; const peak=s>=peakThr;
        const prem=(learned.unitPrem&&learned.unitPrem[u.orp])||UNIT_PREM[u.orp]||1.0; const ps=learned.premScale||1; const base=s*prem;
        const tg=we?st.targets[mo].we:st.targets[mo].wd; const lead=Math.max(0,Math.round((d-new Date(today+"T00:00:00Z"))/86400000)); const pf=paceFrac(lead,dtN,learned); const exp=tg*pf;
        const ua=agg.unitAgg[u.orp][mk]&&agg.unitAgg[u.orp][mk][dt], pa=agg.poolAgg[mk]&&agg.poolAgg[mk][dt];
        const unitOcc=ua&&ua.t?ua.b/ua.t:0, poolOcc=pa&&pa.t?pa.b/pa.t:0;
        const nightOcc=(agg.nightPool&&agg.nightPool[ds])||0; const g=agg.gaps&&agg.gaps[u.orp]&&agg.gaps[u.orp][ds];
        const sens=interp(SENS,lead); let scar=0,un=0,m;
        if(g){ m=paceMult(poolOcc,exp,lead,ps)*gapGm(g.runLen,g.hasWeekend,learned.gapD); } else { scar=scarMult(nightOcc,lead,ps); m=paceMult(poolOcc,exp,lead,ps)+scar; un=(unitOcc-poolOcc)*MODEL.UNIT_GAIN*sens; un=Math.max(-MODEL.UNIT_CAP,Math.min(MODEL.UNIT_CAP,un)); m=m*(1+un); }
        if(peak)m=Math.max(1,m); m=Math.max(MODEL.MULT_MIN,Math.min(MODEL.MULT_MAX,m));
        const final=Math.max(FLOOR,Math.min(peak?MODEL.PEAK_CEIL:CEIL,Math.round(base*m)));
        breakdown={unit:u.name,date:ds,daytype:dtN,signal:s,sigMissing,premium:prem,base:Math.round(base),peak,peakThr:Math.round(peakThr),target:tg,lead:lead,paceFrac:Number(pf.toFixed(3)),expected:Number(exp.toFixed(3)),poolOcc:Number(poolOcc.toFixed(3)),nightOcc:Number(nightOcc.toFixed(3)),unitOcc:Number(unitOcc.toFixed(3)),scar:Number(scar.toFixed(3)),orphan:g?{runLen:g.runLen,hasWeekend:g.hasWeekend,gm:Number(gapGm(g.runLen,g.hasWeekend,learned.gapD).toFixed(3))}:null,premScale:Number(ps.toFixed(3)),learnedPrem:Number(prem.toFixed(3)),sens:Number(sens.toFixed(2)),mult:Number(m.toFixed(3)),final}; }
      return res.status(200).json({refId:process.env.PRICELABS_REF_ID||"486915",sigDays:Object.keys(sig).length,sigMin:allv.length?Math.min(...allv):null,sigMax:allv.length?Math.max(...allv):null,sigAvg:avg(allv),byMonth,breakdown});
    }
    // ===== PUBLIC read-only booking roster — pulled live from OwnerRez (no auth) =====
    if(action==="bookings"){
      const orAuth=(()=>{ const tok=process.env.OWNERREZ_OAUTH_TOKEN; if(tok) return "Bearer "+tok;
        const u=process.env.OWNERREZ_API_USER, t=process.env.OWNERREZ_API_TOKEN; if(u&&t) return "Basic "+Buffer.from(u+":"+t).toString("base64"); return null; })();
      if(!orAuth) return res.status(200).json({configured:false, bookings:[], error:"OwnerRez credentials not set (OWNERREZ_OAUTH_TOKEN, or OWNERREZ_API_USER + OWNERREZ_API_TOKEN)"});
      const fresh=req.query&&req.query.fresh==="1";
      if(redis&&!fresh){ const c=await redis.get("parkside:bookings"); if(c&&(Date.now()-c.ts)<300000) return res.status(200).json({configured:true, cached:true, count:(c.list||[]).length, bookings:c.list}); }
      const ymd=d=>d.toISOString().slice(0,10);
      const now=new Date(); const from=new Date(now); from.setUTCDate(from.getUTCDate()-14); const to=new Date(now); to.setUTCDate(to.getUTCDate()+365);
      const pids=UNITS.map(u=>u.orp).join(",");
      const H={Authorization:orAuth,"Content-Type":"application/json","User-Agent":"parkside-control/1.0"};
      let url="https://api.ownerrez.com/v2/bookings?property_ids="+encodeURIComponent(pids)+"&from="+ymd(from)+"&to="+ymd(to)+"&limit=50";
      let items=[], pages=0;
      try{ while(url&&pages<30){ const r=await fetch(url,{headers:H}); if(!r.ok){ const t=await r.text();
            return res.status(200).json({configured:true, bookings:[], error:"OwnerRez bookings "+r.status, detail:t.slice(0,200)}); }
          const j=await r.json(); const arr=j.items||j.bookings||(Array.isArray(j)?j:[]); items=items.concat(arr||[]);
          let nxt=j.next_page_url||(j.next_page&&j.next_page.url)||null;
          if(nxt && !/^https?:\/\//i.test(nxt)) nxt="https://api.ownerrez.com"+(nxt[0]==="/"?"":"/")+nxt;
          url=nxt; pages++; }
      }catch(e){ return res.status(200).json({configured:true, bookings:[], error:String(e.message||e)}); }
      // Resolve guest contact for each unique guest_id (OwnerRez bookings carry guest_id, not inline contact).
      const unitName={}; for(const u of UNITS) unitName[u.orp]=u.name;
      const gidOf=b=> b && (b.guest_id||b.guestId||(b.guest&&b.guest.id)||null);
      const guestIds=[...new Set(items.map(gidOf).filter(Boolean))].slice(0,250);
      const guests={};
      const withTimeout=(pr,ms)=>Promise.race([pr, new Promise(res=>setTimeout(()=>res(null),ms))]);
      await Promise.all(guestIds.map(async gid=>{ try{
        const r=await withTimeout(fetch("https://api.ownerrez.com/v2/guests/"+gid,{headers:H}), 4000);
        if(r&&r.ok){ const gj=await withTimeout(r.json(),2000); if(gj) guests[gid]=gj; }
      }catch(e){} }));
      const gName=g=>{ if(!g) return ""; const n=((g.first_name||"")+" "+(g.last_name||"")).trim(); return n||g.name||""; };
      const gEmail=g=>{ if(!g) return ""; if(Array.isArray(g.email_addresses)&&g.email_addresses.length){ const e=g.email_addresses.find(x=>x.is_default)||g.email_addresses[0]; return e.address||e.email||""; } if(Array.isArray(g.emails)&&g.emails.length){ const e=g.emails[0]; return (typeof e==="string")?e:(e.address||""); } return g.email||""; };
      const gPhone=g=>{ if(!g) return ""; if(Array.isArray(g.phones)&&g.phones.length){ const p=g.phones.find(x=>x.is_default)||g.phones[0]; return p.number||p.phone||""; } return g.phone||""; };
      const list=(items||[]).map(b=>{ const g=guests[gidOf(b)];
          const unit=(b.property&&b.property.name)||unitName[b.property_id]||String(b.property_id||"");
          return { arrival:b.arrival||"", departure:b.departure||"",
            name:gName(g), email:gEmail(g), phone:gPhone(g),
            reference:b.title||"", unit, status:b.status||b.type||"" }; })
        .filter(x=>x.arrival);
      const tod=ymd(now);
      const upcoming=list.filter(x=>(x.departure||x.arrival)>=tod).sort((a,b)=>a.arrival<b.arrival?-1:(a.arrival>b.arrival?1:0));
      const past=list.filter(x=>(x.departure||x.arrival)<tod).sort((a,b)=>a.arrival>b.arrival?-1:(a.arrival<b.arrival?1:0));
      const out=upcoming.concat(past);
      if(redis) await redis.set("parkside:bookings",{ts:Date.now(),list:out});
      return res.status(200).json({configured:true, count:out.length, bookings:out});
    }

    // ===== (B) PUBLIC booking-inquiry capture — no auth =====
    if(action==="inquiry"){
      if(req.method!=="POST") return res.status(405).json({error:"POST"});
      let b=req.body; if(typeof b==="string"){try{b=JSON.parse(b);}catch{b={};}} b=b||{};
      const rec={ id:Date.now().toString(36)+Math.random().toString(36).slice(2,6),
        checkin:String(b.checkin||"").slice(0,40), checkout:String(b.checkout||"").slice(0,40),
        name:String(b.name||"").slice(0,120), email:String(b.email||"").slice(0,160),
        phone:String(b.phone||"").slice(0,40), message:String(b.message||"").slice(0,1000),
        ts:new Date().toISOString() };
      if(!rec.name && !rec.email && !rec.phone) return res.status(400).json({error:"please include a name, email, or phone"});
      const list=(redis&&await redis.get(INQKEY))||[]; list.push(rec); if(redis) await redis.set(INQKEY, list.slice(-2000));
      const st=await getState();
      const note=await smsVictor(!!st.messaging_enabled, "New booking inquiry — "+(rec.name||"?")+" "+(rec.checkin||"?")+" to "+(rec.checkout||"?")+" "+(rec.phone||rec.email||""));
      return res.status(200).json({ok:true, id:rec.id, victorNotify:note});
    }
    // VICTOR'S: list captured inquiries (password)
    if(action==="inquiries"){
      if((req.headers["x-app-password"]||"")!==(process.env.APP_PASSWORD||"")) return res.status(401).json({error:"unauthorized"});
      const list=(redis&&await redis.get(INQKEY))||[]; return res.status(200).json({inquiries:list.slice(-500).reverse()});
    }
    // ===== (D) Messaging approval pipeline =====
    // A guest question enters the pipeline: auto-approve if KB-known, else queue for Victor.
    if(action==="ask"){
      if((req.headers["x-app-password"]||"")!==(process.env.APP_PASSWORD||"")) return res.status(401).json({error:"unauthorized"});
      let b=req.body; if(typeof b==="string"){try{b=JSON.parse(b);}catch{b={};}} b=b||{};
      const question=String(b.question||"").trim(); const bookingId=b.booking_id||null;
      if(!question) return res.status(400).json({error:"no question"});
      const st=await getState(); const kb=st.kb||KB_SEED; const enabled=!!st.messaging_enabled;
      // AUTO-APPROVE: high-confidence KB match -> send now, never bother Victor.
      const match=kbAutoMatch(kb, question);
      if(match){ const guestSend=await sendGuestReply(enabled, bookingId, match.answer);
        return res.status(200).json({auto_approved:true, matchedTopic:match.topic, confidence:match.confidence, answer:match.answer, guestSend, sent:guestSend.sent===true}); }
      // UNKNOWN/low-confidence -> propose a KB-grounded AI draft and QUEUE for Victor.
      const draft=await aiDraftAnswer(kb, question);
      const proposed=(draft.inKb && draft.answer) ? draft.answer : "";
      const item={ id:Date.now().toString(36)+Math.random().toString(36).slice(2,6), question, proposed,
        booking_id:bookingId, status:"pending", ts:new Date().toISOString() };
      const list=await getApprovals(); list.push(item); await setApprovals(list);
      const sms=await smsVictor(enabled,
        "Parkside approval needed.\nQ: "+question.slice(0,250)+"\nProposed: "+(proposed||"(no KB answer — reply with one)")+"\nReply: YES "+item.id+"  or  NO "+item.id);
      return res.status(200).json({queued:true, id:item.id, proposed, victorSms:sms});
    }
    // VICTOR'S: view the approval queue (password). ?status=pending|approved|rejected|all
    if(action==="approvals"){
      if((req.headers["x-app-password"]||"")!==(process.env.APP_PASSWORD||"")) return res.status(401).json({error:"unauthorized"});
      const list=await getApprovals(); const status=(req.query&&req.query.status)||"pending";
      const out=status==="all"?list:list.filter(x=>x.status===status);
      return res.status(200).json({approvals:out.slice(-200).reverse(), counts:{pending:list.filter(x=>x.status==="pending").length, approved:list.filter(x=>x.status==="approved").length, rejected:list.filter(x=>x.status==="rejected").length}});
    }
    // VICTOR'S / manual decision (password): {id, decision:'yes'|'no', answer?}
    if(action==="approve"){
      if((req.headers["x-app-password"]||"")!==(process.env.APP_PASSWORD||"")) return res.status(401).json({error:"unauthorized"});
      let b=req.body; if(typeof b==="string"){try{b=JSON.parse(b);}catch{b={};}} b=b||{};
      const out=await decideApproval(String(b.id||""), String(b.decision||"").toLowerCase(), b.answer!=null?String(b.answer):null);
      return res.status(out.ok?200:400).json(out);
    }
    // PUBLIC provider webhook: Victor replies YES/NO via text. Provider-agnostic body parse.
    if(action==="sms_inbound"){
      let b=req.body; if(typeof b==="string"){ try{b=JSON.parse(b);}catch{ try{ b=Object.fromEntries(new URLSearchParams(b)); }catch{ b={}; } } } b=b||{};
      const from=String(b.From||b.from||b.source||"").trim();
      const body=String(b.Body||b.body||b.text||b.message||"").trim();
      const vn=victorNumber();
      if(vn && from && from.replace(/[^0-9]/g,"").slice(-10)!==vn.replace(/[^0-9]/g,"").slice(-10))
        return res.status(200).json({ignored:true, reason:"sender is not Victor's number"});
      const mYes=body.match(/^\s*(yes|y|approve)\b\s*([a-z0-9]+)?/i);
      const mNo=body.match(/^\s*(no|n|reject)\b\s*([a-z0-9]+)?/i);
      let decision=null, id=null;
      if(mYes){ decision="yes"; id=mYes[2]||null; } else if(mNo){ decision="no"; id=mNo[2]||null; }
      if(!decision) return res.status(200).json({ignored:true, reason:"reply was not YES/NO"});
      if(!id){ const list=await getApprovals(); const pend=list.filter(x=>x.status==="pending"); id=pend.length?pend[pend.length-1].id:null; }
      if(!id) return res.status(200).json({ignored:true, reason:"no pending item to decide"});
      const out=await decideApproval(id, decision, null);
      return res.status(200).json(out);
    }
    // Queryable KB so future response generation can pull approved answers.
    if(action==="kb_query"){
      const st=await getState(); const kb=st.kb||KB_SEED; const q=(req.query&&req.query.q)||"";
      const m=kbAutoMatch(kb, q);
      return res.status(200).json({query:q, match:m, knownTopics:(kb.items||[]).filter(i=>String(i.a||"").trim()).map(i=>i.topic)});
    }
    // Config visibility for the SMS provider (password) — never reveals secrets.
    if(action==="sms_status"){
      if((req.headers["x-app-password"]||"")!==(process.env.APP_PASSWORD||"")) return res.status(401).json({error:"unauthorized"});
      return res.status(200).json({provider:smsProvider(), configured:smsConfigured(), fromSet:!!smsFrom(), victorSet:!!victorNumber()});
    }

    res.status(400).json({error:"unknown action"});
  }catch(e){ res.status(500).json({error:String(e.message||e)}); }
};

module.exports.__model={compute,paceMult,scarMult,gapGm,deriveLearned,interp,SENS,MODEL,UNIT_PREM,GAP_SEED,signalFallback,buildLearnedPace,paceFrac,buildAgg,median};
module.exports.__msg={kbAutoMatch,normQ,smsProvider,smsConfigured,sendSms,decideApproval};
