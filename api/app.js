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
// ===== GLIDE-SLOPE pricing model (v1) — symmetric damped proportional controller on the seasonal-base multiplier.
// GAIN: a +/-0.30 occupancy gap vs pace -> ~+/-0.15 multiplier (stays inside the tight normal band 0.85..1.15).
//       larger gaps drift further but are hard-clamped to the night's floor/ceiling multipliers (FLOOR/base, ceil/base),
//       so the rate only nears the true floor/ceiling when occupancy is FAR off target. Symmetric: no upward bias.
// STEP: max change to the applied multiplier PER RUN (glideslope easing). NEAR/FAR define the emergent normal band.
const GS={GAIN:0.50, STEP:0.06, BAND_NEAR:0.15, USE_PACE_REF:true};
// LAST-MINUTE discount: nights within WINDOW days of check-in get an extra discount that scales with proximity AND
// how far BEHIND pace the month is (empty+imminent -> full MAX; full month -> ~0). Capped -> a nudge, not a fire-sale.
const LM={WINDOW:14, MAX:0.18};
// GLIDE-MODE orphan-gap discounting (separate from legacy GAP_SEED). Depth by run length (weekday);
// gaps that include a weekend night discount HALF as deep (easier to fill). 4+ nights: no gap discount.
// Application is gated behind redis flag parkside:gap_enabled so a deploy never auto-pushes gap prices.
const GAP_DISC={1:0.30, 2:0.18, 3:0.08};
const GAP_WEEKEND_FACTOR=0.5;
const GAP_RESET_MIN=Number(process.env.GAP_RESET_MIN||2); // min-stay restored to a night once it stops being a gap
// ===== Editable filter-strength knobs (manual tuning now; the learning system will drive these later).
// Defaults below == the current hardcoded behavior. Overrides persist in redis parkside:knobs and apply immediately.
const PACE_LEN_DEFAULT=365; // native horizon (days) the PACE_SEED ramp is authored over — the effective pacing-window length today
const GAP1_CAP=Number(process.env.GAP1_MAX_PUSH||125)||125; // one-night orphan gap hard cap ($) — applied in compute (panel+push) so it is consistent everywhere
const DEFAULT_KNOBS={
  GAIN:GS.GAIN, STEP:GS.STEP, BAND_NEAR:GS.BAND_NEAR,           // demand / glide controller (overall strength)
  farDemand:Number(process.env.FAR_DEMAND||0.15), // FAR-OUT demand strength: how strongly pace-vs-actual demand still adjusts price far out (where the near-term gap collapses), as a fraction. 0 = off, 0.15 = gentle (default). Bounded; near-term unaffected.
  paceLength:PACE_LEN_DEFAULT, // pacing-window horizon in DAYS — how far out the booking-pace ramp is defined; default = native PACE_SEED span (365d) so behavior is unchanged
  wResort:1.0, wUnit:0.0,   // demand split: blendedGap = wResort*resortGap + wUnit*unitGap (default = resort-only = today's behavior)
  gap1:GAP_DISC[1], gap2:GAP_DISC[2], gap3:GAP_DISC[3], gapWeekend:GAP_WEEKEND_FACTOR, // orphan-gap discounts
  lmMax:0.30, lmWindow:LM.WINDOW, lmSteep:1.5,                   // last-minute: PROXIMITY-driven, lm = lmMax × ((window−lead)/window)^lmSteep (perishable: still-open near check-in = real discount)
  floor:FLOOR, ceil:CEIL, saneMin:Number(process.env.SANE_MIN_PUSH||110) // clamp + push sanity
};
const KNOB_RANGES={ // [min,max,isInt] for validation
  GAIN:[0,2,false], farDemand:[0,1,false], STEP:[0.01,0.5,false], BAND_NEAR:[0.01,0.6,false],
  paceLength:[30,720,true],
  wResort:[0,2,false], wUnit:[0,2,false],
  gap1:[0,0.6,false], gap2:[0,0.6,false], gap3:[0,0.6,false], gapWeekend:[0,1,false],
  lmMax:[0,0.5,false], lmWindow:[0,60,true], lmSteep:[0.3,4,false],
  floor:[50,400,true], ceil:[100,1000,true], saneMin:[50,1000,true]
};
async function getKnobs(){ const o=(redis&&await redis.get("parkside:knobs"))||{}; const k={...DEFAULT_KNOBS};
  for(const key in DEFAULT_KNOBS){ if(o[key]!=null && isFinite(Number(o[key]))) k[key]=Number(o[key]); }
  if(k.ceil<k.floor) k.ceil=k.floor; if(k.saneMin<k.floor) k.saneMin=k.floor; // structural safety
  k.gap={1:k.gap1,2:k.gap2,3:k.gap3}; return k; }
function median(a){a=a.slice().sort((x,y)=>x-y);const n=a.length;return n?(n%2?a[(n-1)/2]:(a[n/2-1]+a[n/2])/2):0;}
// Seed booking-pace curve = fraction of FINAL bookings on the books by `lead` days out (leisure STR).
const PACE_SEED={ // expected fraction of FINAL bookings already on the books by `lead` days out.
  // lead 0 = 1.0 (by check-in you should be AT your saved target); stays ~1.0 the last few days, then ramps DOWN.
  // Back-loaded for this drive-to glamping resort: bulk of bookings inside ~45 days; far-out empty reads ~on pace.
  weekend:[[0,1],[4,.99],[10,.96],[14,.87],[21,.74],[30,.61],[45,.42],[60,.27],[90,.14],[120,.09],[180,.05],[270,.03],[365,.02]],
  weekday:[[0,1],[4,.99],[10,.95],[14,.86],[21,.71],[30,.57],[45,.38],[60,.24],[90,.13],[120,.08],[180,.04],[270,.025],[365,.015]]
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

let _memState=null;
async function getState(){ if(!redis) return {...JSON.parse(JSON.stringify(DEFAULTS)),...(_memState||{})}; const s=await redis.get(SKEY); return {...JSON.parse(JSON.stringify(DEFAULTS)),...(s||{})}; }
async function setState(p){ const cur=await getState(); const next={...cur,...p}; delete next.icals; if(redis) await redis.set(SKEY,next); else _memState={...(_memState||{}),...p}; return next; }
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
// paceLen = pacing-window length in days. The PACE_SEED ramp is authored over PACE_LEN_DEFAULT days; we rescale the
// lead axis by (PACE_LEN_DEFAULT/paceLen) so a LONGER paceLen stretches the ramp further out (pace builds earlier),
// a SHORTER one compresses it toward check-in. paceLen = PACE_LEN_DEFAULT (default) → eff==lead → identical to today.
function paceFrac(lead,dt,learned,paceLen){
  const L=(paceLen&&isFinite(paceLen)&&paceLen>0)?paceLen:PACE_LEN_DEFAULT;
  const eff=lead*(PACE_LEN_DEFAULT/L);
  const seed=interp(PACE_SEED[dt],eff);
  if(!learned||!learned[dt]||!learned[dt].n) return seed;
  const w=Math.min(0.8, learned[dt].n/300); return (1-w)*seed + w*interp(learned[dt].curve,eff); }
// Learn the pace curve from logged booking events: fraction of bookings made at lead >= X.
function buildLearnedPace(events){ const out={weekend:{n:0},weekday:{n:0}};
  for(const dt of ["weekend","weekday"]){ const leads=(events||[]).filter(e=>e.daytype===dt&&e.lead>=0).map(e=>e.lead); const n=leads.length;
    if(n){ out[dt]={n,curve:PACE_SEED[dt].map(p=>[p[0], leads.filter(l=>l>=p[0]).length/n])}; } } return out; }

function signalFallback(sig,ds){ const k=Object.keys(sig); if(!k.length)return 0; const d=new Date(ds+"T00:00:00Z"),mo=d.getUTCMonth(),dw=d.getUTCDay();
  const med=a=>{a=a.slice().sort((x,y)=>x-y);const n=a.length;return n?(n%2?a[(n-1)/2]:(a[n/2-1]+a[n/2])/2):0;};
  let s=k.filter(x=>{const e=new Date(x+"T00:00:00Z");return e.getUTCMonth()===mo&&e.getUTCDay()===dw;}).map(x=>sig[x]); if(s.length)return med(s);
  s=k.filter(x=>new Date(x+"T00:00:00Z").getUTCDay()===dw).map(x=>sig[x]); if(s.length)return med(s); return med(k.map(x=>sig[x])); }
async function getSignal(){
  if(redis){ const ov=await redis.get("parkside:signal_override"); if(ov!=null&&Number(ov)>0){ const v=Math.round(Number(ov)); const m={}; const _t=new Date(); for(let _i=0;_i<400;_i++){ const _d=new Date(_t); _d.setUTCDate(_d.getUTCDate()+_i); m[_d.toISOString().slice(0,10)]=v; } return m; } }
  if(redis){ const c=await redis.get("parkside:signal"); if(c&&c.day===new Date().toISOString().slice(0,10)&&c.map&&Object.keys(c.map).length) return c.map; }
  const key=process.env.PRICELABS_API_KEY; if(!key) throw new Error("PRICELABS_API_KEY not set");
  const id=process.env.PRICELABS_REF_ID||"486915", pms=process.env.PRICELABS_REF_PMS||"ownerrez";
  const t=new Date(), e=new Date(); e.setDate(e.getDate()+365);
  const r=await fetch("https://api.pricelabs.co/v1/listing_prices",{method:"POST",headers:{"X-API-Key":key,"Content-Type":"application/json"},body:JSON.stringify({listings:[{id,pms,dateFrom:t.toISOString().slice(0,10),dateTo:e.toISOString().slice(0,10),reason:false}]})});
  const data=await r.json(); const rows=(data[0]&&data[0].data)||[]; const map={};
  for(const x of rows){ if(x.date&&!x.booking_status&&!x.unbookable&&x.price>0) map[x.date.slice(0,10)]=Math.round(x.price); }
  if(redis && Object.keys(map).length) await redis.set("parkside:signal",{day:new Date().toISOString().slice(0,10),map}); return map;
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
// ===== Turnover / cleaning ground-truth (reservation boundaries from OwnerRez iCal) =====
// getBooked flattens nights; for "who needs a clean" we need reservation END dates (a checkout = a turnover clean).
async function getUnitEvents(useCache=true){
  if(useCache&&redis){ try{ const c=await redis.get("parkside:evcache"); if(c&&(Date.now()-c.ts)<3600000) return c.byUnit; }catch(e){} }
  const byUnit={};
  for(const u of UNITS){ byUnit[u.orp]=[]; const url=OWNERREZ_ICAL[u.orp]; if(!url) continue;
    try{ const r=await fetch(url,{headers:{"User-Agent":"parkside-control/1.0"}}); if(!r.ok) continue; const t=await r.text();
      for(const [a,c] of parseIcs(t)){ const st=a.slice(0,4)+"-"+a.slice(4,6)+"-"+a.slice(6,8); const en=c.slice(0,4)+"-"+c.slice(4,6)+"-"+c.slice(6,8); byUnit[u.orp].push([st,en]); }
    }catch(e){} }
  if(redis){ try{ await redis.set("parkside:evcache",{ts:Date.now(),byUnit}); }catch(e){} }
  return byUnit;
}
// Per date in [fromDate .. fromDate+days): which units are occupied that night, which CHECK OUT that day (=need a
// turnover clean), and which arrive. Date strings compare lexicographically (YYYY-MM-DD).
async function getTurnovers(fromDate,days,useCache=true){
  const byUnit=await getUnitEvents(useCache); const nameOf={}; for(const u of UNITS) nameOf[u.orp]=u.name;
  const out={}; const s=new Date(fromDate+"T00:00:00Z");
  for(let i=0;i<days;i++){ const d=new Date(s); d.setUTCDate(d.getUTCDate()+i); const ds=d.toISOString().slice(0,10);
    const occ=[],co=[],arr=[];
    for(const u of UNITS){ const nm=nameOf[u.orp]; for(const [st,en] of (byUnit[u.orp]||[])){
      if(st<=ds && ds<en && occ.indexOf(nm)<0) occ.push(nm);
      if(en===ds && co.indexOf(nm)<0) co.push(nm);
      if(st===ds && arr.indexOf(nm)<0) arr.push(nm); } }
    out[ds]={ occupied:occ, checkouts:co, arrivals:arr }; }
  return out;
}

function buildAgg(booked,start,days){
  const s=new Date(start+"T00:00:00Z"); const unitAgg={},poolAgg={},nightPool={}; for(const u of UNITS)unitAgg[u.orp]={};
  for(let i=0;i<days;i++){ const d=new Date(s); d.setUTCDate(d.getUTCDate()+i); const ds=d.toISOString().slice(0,10); const mk=ds.slice(0,7); const dt=isWe(d)?1:0; let nb=0;
    if(!poolAgg[mk])poolAgg[mk]=[{b:0,t:0},{b:0,t:0}];
    for(const u of UNITS){ if(!unitAgg[u.orp][mk])unitAgg[u.orp][mk]=[{b:0,t:0},{b:0,t:0}];
      unitAgg[u.orp][mk][dt].t++; poolAgg[mk][dt].t++; if(booked.byUnit[u.orp][ds]){ unitAgg[u.orp][mk][dt].b++; poolAgg[mk][dt].b++; nb++; } }
    nightPool[ds]=nb/UNITS.length; }
  // Per-unit orphan/short-gap detection: maximal runs of OPEN nights capped by a booking on the FAR side and
  // by a booking OR today (start of horizon) on the NEAR side — today is a hard wall (past nights can't be sold).
  const gaps={}; for(const u of UNITS)gaps[u.orp]={};
  const dsAt=i=>{const d=new Date(s);d.setUTCDate(d.getUTCDate()+i);return d.toISOString().slice(0,10);};
  for(const u of UNITS){ const B=x=>!!booked.byUnit[u.orp][x]; let i=0;
    while(i<days){ if(B(dsAt(i))){i++;continue;} let j=i; const run=[]; while(j<days&&!B(dsAt(j))){run.push(dsAt(j));j++;}
      const nearWall=(i===0)||B(dsAt(i-1)); // today (i===0) counts as a wall, same as a preceding booking
      const trapped = nearWall && j<days && B(dsAt(j)); const runLen=run.length;
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
      if(!overridden && gapLen===1 && amount>GAP1_CAP) amount=GAP1_CAP; // one-night orphan gap hard cap
      out.push({property_id:u.orp,unit:u.name,date:ds,amount,currency:"USD",overridden,orphan,base:baseOut,gapLen}); } }
  return out;
}
// ===== GLIDE-SLOPE controller (v1). Stateless of any LEARNED levers: uses ONLY seed UNIT_PREM + seed pace curve.
// Controls the multiplier applied to the seasonal base (=PriceLabs signal x seed unit premium).
//   ref   = target_occ x paceFrac(lead)        (where we SHOULD be by now; seed curve, so far-out empty months read "on pace")
//   gap   = ref - poolOcc                       (+ = behind/too empty -> discount;  - = ahead/too full -> premium)
//   desired = 1 - GAIN*gap                      (SYMMETRIC; +/-0.30 gap -> +/-0.15 mult = the tight 0.85..1.15 band)
//   last-minute (lead<=WINDOW): extra discount scaling with proximity x how-far-behind (empty+imminent only)
//   hard clamp to [FLOOR/base, ceil/base] so the rate nears the TRUE floor/ceiling only when occupancy is FAR off.
//   per RUN the APPLIED mult eases toward desired by at most STEP (glideslope). mode:"steady" returns the destination.
function glideRef(target,lead,dtN,learned){ return GS.USE_PACE_REF ? target*paceFrac(lead,dtN,learned) : target; }
function computeGlide(signalMap,targets,today,startDate,days,occ,overrides,gsState,opts){
  const start=new Date(startDate+"T00:00:00Z"); const t0=new Date(today+"T00:00:00Z"); const out=[]; overrides=overrides||{}; gsState=gsState||{}; opts=opts||{};
  const mode=opts.mode||"steady"; const gsNext={...gsState}; const applyGap=opts.applyGap===true;
  const K=opts.knobs||DEFAULT_KNOBS; // editable filter-strength knobs (defaults == prior hardcoded behavior)
  const sv=Object.values(signalMap).filter(v=>v>0); const peakThr=(sv.length?median(sv):K.floor)*MODEL.PEAK_MULT;
  const poolCache={};
  for(let i=0;i<days;i++){ const d=new Date(start); d.setUTCDate(d.getUTCDate()+i); const ds=d.toISOString().slice(0,10); const mk=ds.slice(0,7); const mo=d.getUTCMonth()+1; const we=isWe(d); const dt=we?1:0; const dtN=we?"weekend":"weekday";
    let sig=signalMap[ds]; if(sig==null) sig=signalFallback(signalMap,ds); const peak=sig>=peakThr; const ceil=peak?MODEL.PEAK_CEIL:K.ceil;
    const lead=Math.max(0,Math.round((d-t0)/86400000));
    // resort-level occupancy for this month + daytype (whole-month measurement)
    const ck=mk+"|"+dt; if(poolCache[ck]===undefined){ const pa=occ.agg&&occ.agg.poolAgg[mk]&&occ.agg.poolAgg[mk][dt]; poolCache[ck]=pa&&pa.t?pa.b/pa.t:0; }
    const poolOcc=occ.hasData?poolCache[ck]:null;
    // SAVED monthly occupancy targets are the single source of truth for the pace reference.
    const tRow=(targets&&targets[mo])||SEED_TARGETS[mo]; let target=we?tRow.we:tRow.wd;
    if(target==null||!isFinite(target)){ const sd=SEED_TARGETS[mo]; target=we?sd.we:sd.wd; } // fallback: never silently use a flat/zero target
    const pf=GS.USE_PACE_REF?paceFrac(lead,dtN,null,K.paceLength):1; const ref=target*pf; // pace-ref = saved target x deterministic booking-pace ramp (1.0 at lead 0 -> reaches the FULL saved target at check-in); ramp horizon = K.paceLength days
    const farW=Math.max(0,Math.min(1,1-pf)); // 0 near check-in, 1 far out
    // DEMAND is split: RESORT (whole-resort occ vs pace-ref) at night level; UNIT (this unit's own occ) inside the loop.
    // blendedGap = wResort*resortGap + wUnit*unitGap ; default wResort=1,wUnit=0 -> blendedGap == resortGap == today's behavior.
    let resortGap=null,lm=0;
    if(occ.hasData){ resortGap=Math.max(-1,Math.min(1,ref-poolOcc));
      // PROXIMITY-driven last-minute: a still-open night near check-in is perishable → real discount, independent of how far behind pace.
      if(lead<=K.lmWindow && K.lmWindow>0){ const prox=Math.pow(Math.max(0,(K.lmWindow-lead))/K.lmWindow, K.lmSteep!=null?K.lmSteep:1.5); lm=K.lmMax*prox; } }
    for(const u of UNITS){ const key=u.orp+"|"+ds; const gkey=u.orp+"|"+ds;                // FIX: per-night glide state (was per month+daytype -> all nights of a month collided into one glide slot)
      const prem=UNIT_PREM[u.orp]||1.0; const base=Math.round(sig*prem); const floorMult=K.floor/base, ceilMult=ceil/base;
      // UNIT demand: this unit's own occupancy vs the same pace-ref, then blend with resort demand.
      let unitOcc=null,unitGap=null,blendedGap=null,desiredBase=1,farDemandMult=1,_relDev=0;
      if(occ.hasData){ const ua=occ.agg.unitAgg&&occ.agg.unitAgg[u.orp]&&occ.agg.unitAgg[u.orp][mk]&&occ.agg.unitAgg[u.orp][mk][dt];
        unitOcc=ua&&ua.t?ua.b/ua.t:0; unitGap=Math.max(-1,Math.min(1,ref-unitOcc));
        blendedGap=K.wResort*resortGap + K.wUnit*unitGap;
        // FAR-OUT demand: near term the absolute gap above drives price; far out (farW->1) it collapses toward 0.
        // So add a PROPORTIONAL pace deviation (how far off pace, as a fraction of expected), applied GENTLY and ONLY
        // far out (xfarW x farDemand), bounded by floor/ceil. farDemand=0 -> off; near term farW~0 -> no effect (today's behavior).
        var _pref=Math.max(ref,0.06); _relDev=Math.max(-1,Math.min(1,(ref-(poolOcc||0))/_pref));
        farDemandMult=1 - K.GAIN*(K.farDemand||0)*farW*_relDev;
        desiredBase=(1-K.GAIN*blendedGap)*farDemandMult; }
      let amount,overridden=false,applied=null,desiredC=null,minNights=null,easedDemand=null;
      // per-unit orphan-gap lookup (forward-only detection from buildAgg): {runLen,hasWeekend}
      const gi=(occ.agg&&occ.agg.gaps&&occ.agg.gaps[u.orp])?occ.agg.gaps[u.orp][ds]:null;
      let gapTier=0,gapHasWe=false,gapDisc=0;
      if(gi){ gapTier=gi.runLen; gapHasWe=!!gi.hasWeekend; gapDisc=((K.gap&&K.gap[gapTier])||0)*(gapHasWe?K.gapWeekend:1); }
      const gapApplied=applyGap && gapDisc>0 && occ.hasData;
      // STACK: gap AND last-minute both apply, multiplicatively (the hard floor still bounds the result).
      const effDisc=gapApplied ? (1-(1-gapDisc)*(1-lm)) : lm; // total fractional discount, for reference
      const discSource=(effDisc<=0)?null:(gapApplied?(lm>0?"gap+last-minute (stacked)":"gap"):"last-minute");
      if(overrides[key]!=null){ amount=Math.round(Math.max(OV_MIN,Math.min(OV_MAX,Number(overrides[key])))); overridden=true; }
      else if(!occ.hasData){ amount=Math.max(K.floor,Math.min(ceil,base)); } // cold start: seasonal base only
      else {
        // Ease ONLY the slow-moving DEMAND multiplier (pace-based). Perishable discounts (last-minute, gap) apply
        // IMMEDIATELY on top — no step-easing — so a near-in still-open night actually gets the discount now.
        let demandTarget=desiredBase; if(peak) demandTarget=Math.max(1,demandTarget);
        desiredC=Math.max(floorMult,Math.min(ceilMult,demandTarget)); // demand target (pre-easing)
        const prev=(gsState[gkey]!=null)?gsState[gkey]:1.0;
        const step=Math.max(-K.STEP,Math.min(K.STEP,desiredC-prev)); const steppedDemand=Math.max(floorMult,Math.min(ceilMult,prev+step));
        gsNext[gkey]=steppedDemand; // gsState tracks the eased DEMAND mult only (perishable discounts never corrupt it)
        easedDemand=(mode==="step" && farW<0.5)?steppedDemand:desiredC; // far out (farW>=0.5): apply the stable far-out demand directly, no glide lag-swings
        let mult=easedDemand*(1-lm); // last-minute — immediate
        if(gapApplied){ mult=mult*(1-gapDisc); } // gap STACKS on top — also immediate (min-stay handled separately, below)
        applied=Math.max(floorMult,Math.min(ceilMult,mult));
        amount=Math.max(K.floor,Math.min(ceil,Math.round(base*applied)));
      }
      // HARD CAP: a single-night orphan gap (gapTier===1) is never priced above $GAP1_CAP — applied here so the
      // panel calendar, the breakdown, and the OwnerRez push all show the same capped price. Manual overrides untouched.
      let gap1Capped=false; const preCapAmount=amount;
      if(!overridden && gapTier===1 && amount>GAP1_CAP){ amount=GAP1_CAP; gap1Capped=true; }
      // Availability min-stay (decoupled from gap DISCOUNTING): an isolated single-night orphan gap (gapTier===1)
      // drops to a 1-night minimum so it can actually be booked; every other night keeps the 2-night minimum
      // (OwnerRez property default + the gap-reset pass restores 2 on nights that stop being single-night gaps).
      if(!overridden) minNights = (gapTier===1) ? 1 : null;
      out.push({property_id:u.orp,unit:u.name,date:ds,amount,currency:"USD",base,overridden,peak,minNights,gapApplied,gap1Capped,preCapAmount:Number(preCapAmount),
        gapTier,gapHasWeekend:gapHasWe,gapDisc:Number(gapDisc.toFixed(3)),effDisc:Number(effDisc.toFixed(3)),discSource,
        poolOcc:poolOcc==null?null:Number(poolOcc.toFixed(3)),unitOcc:unitOcc==null?null:Number(unitOcc.toFixed(3)),ref:Number(ref.toFixed(3)),
        savedTarget:Number(target.toFixed(3)),paceFrac:Number(pf.toFixed(3)),farW:Number(farW.toFixed(3)),farDemandMult:Number(farDemandMult.toFixed(3)),relDev:Number(_relDev.toFixed(3)),
        resortGap:resortGap==null?null:Number(resortGap.toFixed(3)),unitGap:unitGap==null?null:Number(unitGap.toFixed(3)),gap:blendedGap==null?null:Number(blendedGap.toFixed(3)),
        desiredBaseMult:occ.hasData?Number(desiredBase.toFixed(3)):null, easedDemandMult:easedDemand==null?null:Number(easedDemand.toFixed(3)), prem,
        lead,lm:Number(lm.toFixed(3)),desiredMult:desiredC==null?null:Number(desiredC.toFixed(3)),appliedMult:applied==null?null:Number(applied.toFixed(3))}); } }
  return {rates:out,gsNext};
}
function validate(es){ const ok=[]; for(const e of es){ const pid=Number(e.property_id), amt=Number(e.amount);
  if(Number.isInteger(pid)&&/^\d{4}-\d{2}-\d{2}$/.test(e.date)&&amt>=OV_MIN&&amt<=OV_MAX&&e.currency==="USD"){
    const o={property_id:pid,date:e.date,amount:Math.round(amt),currency:"USD"};
    const mn=Number(e.minNights); if(Number.isInteger(mn)&&mn>=1&&mn<=30) o.min_nights=mn; // only sent on gap nights / gap-resets; omitted elsewhere so OwnerRez keeps its own min-stay
    ok.push(o); } } return ok; }
async function pushOwnerRez(es,knobs){ const user=process.env.OWNERREZ_API_USER,token=process.env.OWNERREZ_API_TOKEN; if(!user||!token) throw new Error("missing OWNERREZ creds");
  const K=knobs||DEFAULT_KNOBS; const SANE_MIN=K.saneMin, HARD_FLOOR=K.floor; const _flagged=[]; const _capped=[];
  for(const _e of es){ let _amt=Math.round(Number(_e.amount)); const _base=Number(_e.base)||_amt;
    // gap nights are EXEMPT from the sane-min (deliberate orphan discount) but keep the hard FLOOR
    const _sane = _e.gapApplied ? HARD_FLOOR : Math.max(SANE_MIN,Math.round(_base*0.60));
    if(_amt<_sane){ _flagged.push({property_id:_e.property_id,date:_e.date,was:_amt,base:Math.round(_base),raisedTo:_sane}); _e.amount=_sane; _amt=_sane; }
    // HARD CAP: a ONE-NIGHT orphan gap can never push above $GAP1_CAP (default 125). gapTier=1 (glide) / gapLen=1 (legacy).
    // Manual overrides are left alone (deliberate human price).
    const _is1nightOrphan = !_e.overridden && (Number(_e.gapTier)===1 || Number(_e.gapLen)===1);
    if(_is1nightOrphan && _amt>GAP1_CAP){ _capped.push({property_id:_e.property_id,date:_e.date,was:_amt,cappedTo:GAP1_CAP}); _e.amount=GAP1_CAP; } }
  if(_flagged.length){ console.warn("[price-sanity] raised "+_flagged.length+" sub-min push prices to >=$"+SANE_MIN,JSON.stringify(_flagged.slice(0,40))); if(redis){ try{ await redis.set("parkside:sanity_flags",{ts:Date.now(),count:_flagged.length,sane_min:SANE_MIN,items:_flagged.slice(0,200)}); }catch(_x){} } }
  if(_capped.length){ console.warn("[price-sanity] capped "+_capped.length+" one-night-orphan prices to <=$"+GAP1_CAP,JSON.stringify(_capped.slice(0,40))); if(redis){ try{ await redis.set("parkside:sanity_gap1cap",{ts:Date.now(),count:_capped.length,cap:GAP1_CAP,items:_capped.slice(0,200)}); }catch(_x){} } }
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
function computePace(poolAgg,targets,learned,today,months,paceLen){ const pace={}; const t0=new Date(today+"T00:00:00Z");
  for(const mk of months){ const tgt=targets[parseInt(mk.slice(5))]; const pa=poolAgg[mk]||[{b:0,t:0},{b:0,t:0}];
    // ACCURATE expected = average of each night's OWN pace-ref (target × deterministic pacing at that date's lead),
    // not the whole month evaluated at the month-start lead. Split by daytype + a combined ALL-days figure that
    // reconciles exactly with the averaged "Current occupancy %" panel.
    const y=parseInt(mk.slice(0,4)), mo=parseInt(mk.slice(5,7)); const ndays=new Date(Date.UTC(y,mo,0)).getUTCDate();
    const expSum=[0,0], expCnt=[0,0];
    for(let dd=1; dd<=ndays; dd++){ const d=new Date(Date.UTC(y,mo-1,dd)); const dt=isWe(d)?1:0; const dtN=dt?"weekend":"weekday";
      const lead=Math.max(0,Math.round((d-t0)/86400000)); const tv=dt?tgt.we:tgt.wd; expSum[dt]+=tv*paceFrac(lead,dtN,null,paceLen); expCnt[dt]++; }
    const f=(dt)=>{ const act=pa[dt].t?Math.round(100*pa[dt].b/pa[dt].t):0; const exp=expCnt[dt]?Math.round(100*expSum[dt]/expCnt[dt]):0; return {act,exp,status:act>=exp?"ahead":"behind"}; };
    const ball=pa[0].b+pa[1].b, tall=pa[0].t+pa[1].t; const actAll=tall?Math.round(100*ball/tall):0;
    const expAll=(expCnt[0]+expCnt[1])?Math.round(100*(expSum[0]+expSum[1])/(expCnt[0]+expCnt[1])):0;
    pace[mk]={wknd:f(1),wkdy:f(0),all:{act:actAll,exp:expAll,status:actAll>=expAll?"ahead":"behind"}}; }
  return pace; }
// ===== SUGGESTIONS: the learning component PROPOSES knob changes. SUGGEST-ONLY — never auto-applies.
// Heuristics from occupancy-vs-target pace trend; each suggestion is clearly labelled with its basis + confidence.
function clampKnob(key,v){ const r=KNOB_RANGES[key]; if(!r) return v; v=Math.max(r[0],Math.min(r[1],Number(v))); return r[2]?Math.round(v):Number(v.toFixed(3)); }
// RECOMMENDED SETTINGS: for EVERY knob, a learning-recommended value + one-line basis. Suggest-only; adopting is Gavin's explicit per-knob choice.
const KNOB_ORDER=["GAIN","farDemand","paceLength","STEP","BAND_NEAR","wResort","wUnit","gap1","gap2","gap3","gapWeekend","lmMax","lmWindow","lmSteep","floor","ceil","saneMin"];
async function genRecommendations(today){
  const st=await getState(); const K=await getKnobs(); const learned=await getLearned();
  const od=await getOccData(st,today,365,true);
  const months=monthList(today,150); const pace=computePace(od.agg.poolAgg, st.targets, learned, today, months, K.paceLength);
  const upcoming=months.slice(0,6); let behindSum=0,cnt=0; const detail=[];
  for(const mk of upcoming){ const a=pace[mk]&&pace[mk].all; if(a&&a.exp>0){ behindSum+=(a.exp-a.act); cnt++; detail.push(mk.slice(5)+' '+a.act+'/'+a.exp); } }
  const avgBehind=cnt?Math.round(behindSum/cnt):0; // + = behind pace (need occupancy), − = ahead (capture revenue)
  const mag=Math.min(1, Math.abs(avgBehind)/12); const behind=avgBehind>0; // strength scales with how far off pace (full at 12+ pts)
  const paceWord=avgBehind>0?(avgBehind+' pts behind pace'):avgBehind<0?((-avgBehind)+' pts ahead of pace'):'on pace';
  const paceBasis='resort '+paceWord+' over next '+cnt+' months';
  const evN=(learned.weekend.n||0)+(learned.weekday.n||0); const gd=(learned.detail&&learned.detail.gap)||{};
  const rec={}; const hold=(key,why)=>({recommended:K[key], basis:why||'on pace — hold'});
  // Always-directional, graded lean toward the long-term goal: BEHIND pace → favor filling occupancy;
  // AHEAD → favor capturing revenue. favorFill=+1 raises the knob when behind; -1 raises it when ahead.
  const lean=(key, stepAtFull, favorFill, whyFill, whyProtect)=>{
    if(Math.abs(avgBehind)<2) return hold(key, paceBasis+' → on pace, hold');
    const sign=behind?favorFill:-favorFill; const val=clampKnob(key, K[key]+sign*stepAtFull*mag);
    if(Number(val)===Number(K[key])) return hold(key, paceBasis+' → already at its limit');
    return {recommended:val, basis:paceBasis+' → '+(behind?whyFill:whyProtect)}; };
  // gap depths: LEARNED fill-rate wins when there's data; otherwise lean by pace.
  for(const [key,len] of [["gap1",1],["gap2",2],["gap3",3]]){ const ld=gd[len];
    if(ld && ld.open>=40){ rec[key]={recommended:clampKnob(key,ld.eff), basis:'learned fill rate ('+ld.open+' exposure-days, '+ld.book+' booked)'}; }
    else rec[key]=lean(key,0.08,+1,'deepen gap discount to fill open nights','ease gap discount, protect rate'); }
  rec.lmMax=lean('lmMax',0.08,+1,'stronger last-minute to fill','lighter last-minute, hold rate');
  rec.GAIN=lean('GAIN',0.15,+1,'more demand reactivity to fill','less reactivity, steadier rate');
  rec.farDemand=lean('farDemand',0.08,+1,'stronger far-out pace response','gentler far-out response');
  rec.floor=lean('floor',15,-1,'lower floor so discounts can reach & fill','raise floor to capture demand');
  rec.ceil=(!behind && Math.abs(avgBehind)>=2)?{recommended:clampKnob('ceil',K.ceil+Math.round(20*mag)),basis:paceBasis+' → raise ceiling to capture peak demand'}:hold('ceil',paceBasis+' → hold ceiling');
  for(const key of KNOB_ORDER){ if(!rec[key]) rec[key]=hold(key); }
  const items=KNOB_ORDER.map(key=>({ knob:key, current:K[key], recommended:rec[key].recommended, basis:rec[key].basis, changed:Number(rec[key].recommended)!==Number(K[key]) }));
  const out={ ts:Date.now(), avgBehind, paceBasis, learnEvents:evN, items }; if(redis) await redis.set("parkside:recommendations",out); return out;
}
// ===== Guest-messaging send path (added) =====
const APOLOGY="I'm sorry, I don't know the answer to that. Let me check with a manager and I'll get back to you soon.";
let _memLastSend=null;
// HARD GUARD: a guest must ONLY ever receive a clean, AI-suggested reply.
// These strip/detect any internal approval-label or command artifact so it can
// NEVER reach a guest, no matter what upstream path called us.
function stripInternalArtifacts(s){
  s=String(s==null?"":s);
  s=s.replace(/\n*\s*Reply:\s*Q?\s*\d+\s*yes\b[\s\S]*$/i,"");   // trailing 'Reply: Q# yes | Q# no'
  s=s.replace(/\n*\s*Reply:\s*YES\s+\S+\s+or\s+NO\s+\S+[\s\S]*$/i,""); // trailing 'Reply: YES <id> or NO <id>'
  return s.trim();
}
function isInternalArtifact(s){
  s=String(s==null?"":s).trim();
  if(!s) return true;
  if(/reply:\s*q?\s*\d+\s*yes/i.test(s)) return true;                 // label reply-line
  if(/\bq\s*\d+\s*yes\b[\s\S]*\bq\s*\d+\s*no\b/i.test(s)) return true; // 'Q# yes ... Q# no'
  if(/parkside approval needed/i.test(s)) return true;                  // owner approval SMS
  if(/^\s*draft:\s/i.test(s)) return true;                            // owner 'Draft:' scaffold
  if(/^\s*q\s*\d+\b\s*[-\u2013]/i.test(s)) return true;              // 'Q37 - unit - name' header
  if(/^\s*(q\s*\d+|y|yes|n|no|ok|okay|send|approve|approved|reject|skip)\s*$/i.test(s)) return true; // bare command
  return false;
}
// Strip STRAY/unbalanced wrapping quotation marks the model occasionally leaves on a reply
// (e.g. it wrapped the whole message in quotes and only the closing one survived: ...for you.")
// Only removes a fully-wrapping matched pair or a single unbalanced edge quote; internal quotes are kept.
function tidyQuotes(s){
  s=String(s==null?"":s).trim();
  for(const pr of [['\"','\"'],['\u201C','\u201D']]){ const o=pr[0], c=pr[1];
    if(s.length>1 && s[0]===o && s[s.length-1]===c){ const inner=s.slice(1,-1);
      if(inner.indexOf(o)===-1 && inner.indexOf(c)===-1){ s=inner.trim(); break; } } }
  if(((s.match(/\"/g)||[]).length%2)===1 && s.endsWith('\"')) s=s.slice(0,-1).trim();   // lone unbalanced straight quote
  if(s.endsWith('\u201D') && s.indexOf('\u201C')===-1) s=s.slice(0,-1).trim();          // lone curly close-quote
  if(s.endsWith('\u2019') && s.indexOf('\u2018')===-1) s=s.slice(0,-1).trim();
  return s.trim();
}
async function sendGuestReply(enabled, ids, body){
  const cfg=await getNotifyConfig(); const tokenLen=(cfg.ownerrezOauth||"").length;
  // ==== GUEST-SEND HARD GUARD (single choke-point) ====
  body=stripInternalArtifacts(body);
  body=tidyQuotes(body);
  body=scrubContact(body); // defense-in-depth: strip any phone/email the channel would block, on EVERY guest send
  if(isInternalArtifact(body)){
    const rec={sent:false, blocked:true, staged:false, reason:"BLOCKED: body looked like an internal approval/label, not a guest reply \u2014 nothing was sent to the guest"};
    try{ if(cfg.smsUrl&&cfg.smsTo) await sendSmsGateway(cfg, "\u26A0\uFE0F Blocked a guest send that looked like an internal label/command. Nothing went to the guest."); }catch(e){}
    try{ if(redis) await redis.set("parkside:last_send", {ranAt:new Date().toISOString(), ...rec}); else _memLastSend={ranAt:new Date().toISOString(), ...rec}; }catch(e){}
    return rec;
  }
  const threadId=(ids&&typeof ids==="object")?(ids.threadId||ids.thread_id||null):null;
  const bookingId=(ids&&typeof ids==="object")?(ids.bookingId||ids.booking_id||null):(ids||null);
  let result;
  if(!enabled){ result={sent:false, staged:true, reason:"messaging toggle OFF (preview/test mode)"}; }
  else { const auth=await orAuthHeader();
    if(!auth){ result={sent:false, staged:true, reason:"no OwnerRez token (paste the OwnerRez OAuth token in Victor's → Email notifications)"}; }
    else if(!threadId && !bookingId){ result={sent:false, staged:true, reason:"no thread_id / booking_id (need an inbound thread to reply to)"}; }
    else {
      // OwnerRez send: POST /v2/messages with the thread_id (from the inbound webhook).
      const payload = threadId ? {thread_id:threadId, body} : {booking_id:bookingId, body};
      try{ const r=await fetch("https://api.ownerrez.com/v2/messages",{method:"POST",
          headers:{Authorization:auth,"Content-Type":"application/json","User-Agent":"parkside-control/1.0"},
          body:JSON.stringify(payload)});
        const t=await r.text(); result={sent:r.ok, status:r.status, via:(threadId?"thread_id":"booking_id"), body:t.slice(0,300)}; }
      catch(e){ result={sent:false, error:String(e.message||e)}; }
    }
  }
  // Persist the exact outcome so the owner/dev can see it in notify_status.lastSend.
  try{ const rec={ranAt:new Date().toISOString(), tokenLen, hasThread:!!threadId, hasBooking:!!bookingId, ...result};
       if(redis) await redis.set("parkside:last_send",rec); else _memLastSend=rec; }catch(e){}
  try{ if(result&&result.sent){ await appendThreadLog(threadId, bookingId, "out", body, ""); } }catch(e){}
  return result;
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
// Generic HTTP SMS gateway (e.g. an Android SMS-gateway app that exposes an HTTP send endpoint). Template uses {to}/{text}.
function fillSmsBody(tmpl, to, text){
  const j = String(tmpl||"").trim().charAt(0)==="{" || String(tmpl||"").trim().charAt(0)==="[";
  const t = j ? JSON.stringify(String(text)).slice(1,-1) : encodeURIComponent(String(text));
  const tv = j ? String(to) : encodeURIComponent(String(to));
  return String(tmpl||"").split("{text}").join(t).split("{to}").join(tv);
}
async function sendSmsGateway(cfg, text){
  const url=(cfg&&cfg.smsUrl)||""; if(!url) return {sent:false, staged:true, reason:"no SMS gateway URL set"};
  const to=(cfg&&cfg.smsTo)||""; if(!to) return {sent:false, staged:true, reason:"no SMS recipient number set"};
  const tmpl=(cfg&&cfg.smsBody)||'{"phone":"{to}","message":"{text}"}';
  let headers={"Content-Type": (String(tmpl).trim().charAt(0)==="{"?"application/json":"application/x-www-form-urlencoded")};
  try{ const hs=String((cfg&&cfg.smsHeaders)||"").trim(); if(hs){ if(hs.charAt(0)==="{"){ Object.assign(headers, JSON.parse(hs)); } else { hs.split(/\n+/).forEach(function(l){ const i=l.indexOf(":"); if(i>0) headers[l.slice(0,i).trim()]=l.slice(i+1).trim(); }); } } }catch(e){}
  if((cfg&&cfg.smsUser) && !Object.keys(headers).some(function(k){return k.toLowerCase()==="authorization";})){ headers["Authorization"]="Basic "+Buffer.from(String(cfg.smsUser)+":"+String(cfg.smsPass||"")).toString("base64"); }
  try{ const r=await fetch(url,{method:"POST",headers:headers,body:fillSmsBody(tmpl,to,text)});
    const t=await r.text(); return {sent:r.ok, status:r.status, provider:"gateway", body:String(t).slice(0,160)}; }
  catch(e){ return {sent:false, error:String(e.message||e)}; }
}
async function smsVictor(enabled, text){
  if(!enabled) return {sent:false, staged:true, reason:"messaging toggle OFF (preview/test mode)"};
  return sendSms(victorNumber(), text);
}

// ===== Email approval channel (Resend) — interim channel before SMS is live =====
const NCKEY="parkside:notify_config";
let _memNotify=null;
async function getNotifyRaw(){ return (redis?(await redis.get(NCKEY)):_memNotify)||{}; }
async function setNotifyRaw(c){ if(redis) await redis.set(NCKEY,c); else _memNotify=c; return c; }
// Merged notify config: Redis (set via Victor's UI) wins, env vars are the fallback.
async function getNotifyConfig(){ const c=await getNotifyRaw(); return {
  apiKey: (c.resendApiKey||process.env.RESEND_API_KEY||"").trim(),
  from:   (c.from||process.env.RESEND_FROM||"").trim(),
  to:     (c.victorEmail||process.env.VICTOR_EMAIL||"").trim(),
  to2:    (c.victorEmail2||process.env.VICTOR_EMAIL_2||"").trim(),
  scoreAlertEmails: (c.scoreAlertEmails||process.env.SCORE_ALERT_EMAILS||"").trim(),
  escalateMins: (function(){ var m=Number(c.escalateMins||process.env.ESCALATE_MINS||60); return (isFinite(m)&&m>0)?m:60; })(),
  secret: (c.approveSecret||process.env.APPROVE_LINK_SECRET||"").trim(),
  ownerrezOauth: (c.ownerrez_oauth_token||process.env.OWNERREZ_OAUTH_TOKEN||"").trim(),
  webhookUser: (c.webhook_user||process.env.OR_WEBHOOK_USER||"").trim(),
  webhookPass: (c.webhook_pass||process.env.OR_WEBHOOK_PASS||"").trim(),
  primaryChannel: ((c.primaryChannel||"email")==="sms")?"sms":"email",
  smsUrl: (c.smsGatewayUrl||process.env.SMS_GATEWAY_URL||"https://api.sms-gate.app/3rdparty/v1/messages").trim(),
  smsTo:  (c.smsTo||process.env.SMS_VICTOR_NUMBER||process.env.VICTOR_PHONE||"").trim(),
  smsBody: (c.smsBody||process.env.SMS_BODY_TEMPLATE||'{"textMessage":{"text":"{text}"},"phoneNumbers":["{to}"]}'),
  smsHeaders: (c.smsHeaders||process.env.SMS_HEADERS||""),
  smsUser: (c.smsUser||process.env.SMS_USER||"").trim(),
  smsPass: (c.smsPass||process.env.SMS_PASS||""),
}; }
let _memWh=null;
async function writeWhStatus(o){ const x={...o}; if(redis) await redis.set("parkside:wh_status",x); else _memWh=x; return x; }
async function getWhStatus(){ return (redis?await redis.get("parkside:wh_status"):_memWh)||null; }
// Auto-generate stable webhook Basic-auth creds so the owner just COPIES them into
// the OwnerRez OAuth app Webhooks section (no secret for the assistant to handle).
async function ensureWebhookCreds(){ const raw=await getNotifyRaw(); let changed=false;
  if(!raw.webhook_user){ raw.webhook_user="parkside"; changed=true; }
  if(!raw.webhook_pass){ raw.webhook_pass=("wh"+Math.random().toString(36).slice(2)+Math.random().toString(36).slice(2)).slice(0,28); changed=true; }
  if(changed) await setNotifyRaw(raw);
  return {user:raw.webhook_user, pass:raw.webhook_pass}; }
function appOrigin(req){ const h=(req&&req.headers)||{}; const host=h["x-forwarded-host"]||h.host; const proto=h["x-forwarded-proto"]||"https"; return host?(proto+"://"+host):""; }
function escHtml(x){ return String(x==null?"":x).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
async function resendSend({apiKey,from,to,subject,html}){
  if(!apiKey) return {sent:false, staged:true, reason:"Resend API key not set (add it in Victor's Email notifications card, or RESEND_API_KEY env)"};
  if(!from) return {sent:false, staged:true, reason:"From address not set"};
  if(!to) return {sent:false, staged:true, reason:"Victor email (To) not set"};
  try{ const r=await fetch("https://api.resend.com/emails",{method:"POST",headers:{Authorization:"Bearer "+apiKey,"Content-Type":"application/json"},body:JSON.stringify({from,to,subject,html})});
    const t=await r.text(); let detail=t.slice(0,300);
    try{ const j=JSON.parse(t); if(!r.ok && (j.message||j.error)) detail=j.message||j.error; }catch(e){}
    return {sent:r.ok, status:r.status, detail}; }
  catch(e){ return {sent:false, error:String(e.message||e)}; }
}
// ---- per-conversation message log (BOTH directions) ----
// OwnerRez GET /v2/messages is gated, so the engine keeps its own per-thread log of
// every inbound guest message AND every reply we send, keyed by thread (fallback booking).
let _memThreads={};
function threadKey(threadId, bookingId){ return threadId?("t:"+threadId):(bookingId?("b:"+bookingId):null); }
async function getThreadLog(threadId, bookingId){ var k=threadKey(threadId,bookingId); if(!k) return [];
  try{ return (redis?(await redis.get("parkside:thr:"+k)):_memThreads[k])||[]; }catch(e){ return []; } }
async function appendThreadLog(threadId, bookingId, dir, body, name){
  var k=threadKey(threadId,bookingId); if(!k) return;
  var b=String(body||"").slice(0,4000); if(!b) return;
  try{ var arr=(redis?(await redis.get("parkside:thr:"+k)):_memThreads[k])||[];
    if(dir==="out"){ for(var i=Math.max(0,arr.length-6);i<arr.length;i++){ if(arr[i]&&arr[i].d==="out"&&arr[i].b===b) return; } }
    arr.push({d:dir, b:b, t:new Date().toISOString(), n:String(name||"")}); arr=arr.slice(-120);
    if(redis) await redis.set("parkside:thr:"+k, arr); else _memThreads[k]=arr;
  }catch(e){}
}
// Render the full TWO-WAY conversation for the approval email. Prefers the per-thread
// log (true in/out history); falls back to reconstructing from approval items.
async function renderThread(item, approvals){
  function fmt(ts){ try{ return new Date(ts).toLocaleString("en-US",{month:"short",day:"numeric",hour:"numeric",minute:"2-digit"}); }catch(e){ return ""; } }
  function guestB(name,text,ts,isNew){ return '<div style="margin:8px 0;text-align:left">'
    +'<div style="font-size:11px;color:#94a3b8;margin:0 0 2px 0">'+escHtml(name||"Guest")+(isNew?" &middot; newest":"")+(ts?(" &middot; "+escHtml(fmt(ts))):"")+'</div>'
    +'<div style="display:inline-block;max-width:88%;background:'+(isNew?"#fef3c7":"#f1f5f9")+';border:1px solid '+(isNew?"#fcd34d":"#e2e8f0")+';border-radius:12px;padding:8px 12px;font-size:14px;color:#0f172a;white-space:pre-wrap">'+escHtml(text)+'</div></div>'; }
  function sentB(text,ts){ return '<div style="margin:8px 0;text-align:right">'
    +'<div style="font-size:11px;color:#94a3b8;margin:0 0 2px 0">You sent'+(ts?(" &middot; "+escHtml(fmt(ts))):"")+'</div>'
    +'<div style="display:inline-block;max-width:88%;background:#dcfce7;border:1px solid #86efac;border-radius:12px;padding:8px 12px;font-size:14px;color:#0f172a;white-space:pre-wrap;text-align:left">'+escHtml(text)+'</div></div>'; }
  var log=await getThreadLog(item.thread_id, item.booking_id);
  if(log && log.length){
    var lastIn=-1; for(var j=0;j<log.length;j++){ if(log[j].d==="in") lastIn=j; }
    var out="";
    for(var i=0;i<log.length;i++){ var m=log[i];
      if(m.d==="out") out+=sentB(m.b,m.t);
      else out+=guestB(m.n||item.guest_name,m.b,m.t,(i===lastIn && log.length>1)); }
    if(out) return out;
  }
  var key=item.thread_id||item.booking_id||null;
  var convo = key ? (approvals||[]).filter(function(x){return (x.thread_id||x.booking_id)===key;}).sort(function(a,b){return String(a.ts).localeCompare(String(b.ts));}) : [item];
  if(!convo.length) convo=[item];
  var multi=convo.length>1; var rows="";
  for(var c=0;c<convo.length;c++){ var it=convo[c]; var isNew=(it.id===item.id)&&multi;
    if(it.question) rows+=guestB(it.guest_name||item.guest_name,it.question,it.ts,isNew);
    if(it.status==="approved" && it.answer) rows+=sentB(it.answer,it.decidedAt||it.ts); }
  return rows||guestB(item.guest_name,item.question,item.ts,false);
}
// Build + send (or stage) the Victor approval email with Approve/Reject links.
async function sendVictorApprovalEmail(req, item, ctx){
  ctx=ctx||{};
  const cfg=await getNotifyConfig();
  const unit=ctx.unit||""; const guestName=ctx.guestName||"";
  const proposed=item.proposed||"";
  // SMS-only: text the owner the labeled approval. (Email channel removed.)
  if(cfg.smsUrl && cfg.smsTo){
    const _lbl=item.smsLabel||"Q?"; const _ctx=[unit,guestName].filter(Boolean).join(" - "); const _hist=(await getThreadLog(item.thread_id, item.booking_id)).filter(m=>m&&m.b).slice(-8); const _convo=_hist.length?_hist.map(m=>(m.d==="out"?"You: ":"Guest: ")+String(m.b).replace(/\s+/g," ").trim().slice(0,150)).join("\n\n"):("Guest: "+String(item.question||"").replace(/\s+/g," ").trim().slice(0,160)); const smsText=_lbl+(_ctx?(" - "+_ctx):"")+"\n"+_convo+"\n\nDraft: "+String(proposed||"(none)").replace(/\s+/g," ").trim().slice(0,300)+"\n\nReply: "+_lbl+" yes  |  "+_lbl+" no";
    const result=await sendSmsGateway(cfg, smsText);
    return {...result, channel:"sms", to:cfg.smsTo||null, subject:"(SMS)"};
  }
  return {sent:false, staged:true, reason:"SMS not configured", channel:"none"};
}
// Primary->secondary escalation: any approval still pending after escalateMins gets the
// SAME approval email (same suggested reply) re-sent ONCE to the backup contact.
async function sendApprovalEmail(req, item, toAddr, isEsc, opts){ opts=opts||{};
  const cfg=await getNotifyConfig();
  if(!toAddr || !cfg.apiKey || !cfg.from) return {sent:false, reason:"backup email not configured (need address, Resend key, From)"};
  const origin=(process.env.APP_PUBLIC_ORIGIN||"https://project-jvyw3.vercel.app"); const secret=cfg.secret;
  const base=origin+"/api/app?action=approve&id="+encodeURIComponent(item.id)+"&token="+encodeURIComponent(secret);
  const yes=base+"&decision=yes", no=base+"&decision=no";
  const editUrl=origin+"/api/app?action=edit_approval&id="+encodeURIComponent(item.id)+"&token="+encodeURIComponent(secret);
  const supplyUrl=origin+"/api/app?action=supply_fact&id="+encodeURIComponent(item.id)+"&token="+encodeURIComponent(secret)+"&to="+encodeURIComponent(toAddr||"");
  const unit=item.unit||""; const guestName=item.guest_name||""; const proposed=item.proposed||"";
  const esc2=(item.status==="escalated"); // waiting on a FACT from Victor (no draft to approve yet)
  let threadHtml=""; try{ threadHtml=await renderThread(item, await getApprovals()); }catch(e){}
  const subject=(esc2?"Guest question needs info":"Parkside approval needed")+(unit?(" - "+unit):""); // item: removed the "No text reply/2nd notice" concept — this system never escalates on non-response.
  const btn=(href,bg,label)=>'<a href="'+href+'" style="display:inline-block;background:'+bg+';color:#fff;text-decoration:none;font-weight:700;font-size:15px;padding:12px 22px;border-radius:8px;margin:6px 8px 6px 0">'+label+'</a>';
  const html='<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#0f172a">'
    +'' /* item: removed the "No response to the text within the time limit" banner — this system does not act on non-response */
    +'<h2 style="margin:0 0 8px">Guest message - approval needed</h2>'
    +(unit?'<div style="color:#64748b;font-size:13px">Unit: <b>'+escHtml(unit)+'</b></div>':'')
    +(guestName?'<div style="color:#64748b;font-size:13px">Guest: <b>'+escHtml(guestName)+'</b></div>':'')
    +'<div style="margin:14px 0 6px;font-size:12px;color:#64748b;text-transform:uppercase">Conversation</div>'
    +'<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:4px 12px">'+threadHtml+'</div>'
    +'<div style="margin:14px 0 6px;font-size:12px;color:#64748b;text-transform:uppercase">'+(esc2?"What happened":"Suggested reply")+'</div>'
    +(esc2
       ? '<div style="background:#fff8e1;border:1px solid #fcd34d;border-radius:10px;padding:10px 12px;font-size:14px;color:#0f172a">The assistant doesn’t have this answer yet. Click below and tell it the fact — it will write the full reply and send it to the guest. You don’t need to write the whole message.</div>'
         +'<div style="margin:18px 0">'+btn(supplyUrl,"#2563eb","Answer this — supply the fact")+'</div>'
         +'<p style="color:#94a3b8;font-size:12px">Type just the fact (e.g. “11pm” or “early check-in is $30”), review the reply, then send. Nothing goes to the guest until you confirm. It’s also gone to Victor by text. (Ref '+escHtml(item.id)+')</p></div>'
       : '<div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:10px 12px;font-size:14px;white-space:pre-wrap">'+(proposed?escHtml(proposed):'<i>No suggested reply</i>')+'</div>'
         +'<div style="margin:18px 0">'+btn(yes,"#16a34a","Approve & Send")+btn(editUrl,"#2563eb","Edit")+(opts.hideReject?"":btn(no,"#dc2626","Reject"))+'</div>'
         +'<p style="color:#94a3b8;font-size:12px">Approve sends this reply to the guest. Reject sends nothing. (Ref '+escHtml(item.id)+')</p></div>');
  const result=await resendSend({apiKey:cfg.apiKey, from:cfg.from, to:toAddr, subject, html});
  return {...result, to:toAddr, from:cfg.from, subject, escalation:isEsc};
}
// Backup-email escalation: any approval still pending after escalateMins (no text reply) gets emailed ONCE to the backup address.
async function escalateStaleApprovals(req){
  try{
    const cfg=await getNotifyConfig();
    if(!cfg.to2) return {escalated:0, reason:"no backup email set"};
    if(!cfg.apiKey||!cfg.from) return {escalated:0, reason:"backup email not configured (need Resend key + From)"};
    const now=Date.now();
    const windowMs=(cfg.escalateMins||60)*60*1000;                 // must be OLDER than this (past the answer timer)
    const maxAgeMs=Math.max(3*3600*1000, windowMs+3600*1000);       // but NEVER older than this — HARD recency guard, no backlog blast
    const cutoff=now-windowMs;
    const list=await getApprovals(); let changed=false; const done=[]; let neutralized=0;
    for(const it of list){
      if(!it) continue;
      // Only a genuinely-OPEN unknown-fact item (guest asked; we sent a holding; we still owe a real answer).
      if(it.status!=="escalated") continue;
      const t=Date.parse(it.primaryNotifiedAt||it.ts||"");
      if(!isFinite(t)) continue;
      // (1) HARD RECENCY GUARD: anything older than maxAge is BACKLOG — NEVER escalate. Mark it permanently
      // ineligible so the old backlog (days-old, already-handled records) can never blast the backup again.
      if((now-t) > maxAgeMs){ if(!it.backupAskSent){ it.backupAskSent=true; it.backupSkippedStale=true; changed=true; neutralized++; } continue; }
      if(it.backupAskSent) continue;                         // already asked once (permanent)
      if(t > cutoff) continue;                               // not past the answer timer yet
      // (2) ALREADY-REPLIED GUARD (timestamp-based — robust): HANDLED only if we sent the guest a real follow-up
      // AFTER the holding, detected by TIME (an outbound logged >2 min after this item was created). We do NOT
      // compare text: the holding is tidied/scrubbed before it is logged, so a text compare against firstProposed
      // MISFIRED and wrongly marked legit, still-open escalations as handled (that blocked Gavin's backup email).
      // The holding note is sent at creation time and is always within the 2-min window, so it never counts as a reply.
      let handled=false;
      try{ const _log=await getThreadLog(it.thread_id, it.booking_id);
        const _ht=Date.parse(it.primaryNotifiedAt||it.ts||"")||0;
        if(_ht){ for(const m of (_log||[])){ if(m && m.d==="out"){ const _mt=Date.parse(m.t||"")||0; if(_mt && _mt > _ht+120000){ handled=true; break; } } } }
      }catch(e){}
      if(handled){ it.backupAskSent=true; it.backupSkippedHandled=true; changed=true; continue; }
      // ATOMIC one-shot across concurrent sweeps (inbound webhooks + cron + dashboard load), 30-day expiry.
      let _first=true;
      try{ if(redis){ const _r=await redis.set("parkside:backup_ask:"+it.id, new Date().toISOString(), {nx:true, ex:30*24*3600}); _first=(_r!==null && _r!==false); } }catch(e){}
      if(!_first){ it.backupAskSent=true; changed=true; continue; }
      const r=await sendApprovalEmail(req, it, cfg.to2, false);   // clean "Guest question needs info" subject (first & only email)
      it.backupAskSent=true; it.escalatedTo2=true; it.escalatedTo2At=new Date().toISOString(); it.escalatedTo2Sent=!!(r&&r.sent===true);
      changed=true; done.push({id:it.id, sent:!!(r&&r.sent===true), to:cfg.to2});
    }
    if(changed) await setApprovals(list);
    return {escalated:done.length, neutralized:neutralized, maxAgeH:Math.round(maxAgeMs/3600000), mins:cfg.escalateMins, items:done};
  }catch(e){ return {error:String(e.message||e)}; }
}
// Auto-resolve: any approval still pending after 24h becomes Rejected (nothing sent to guest).
// Uses ts (queued time). Does NOT write the reject-KB — a timeout is not a judgment on the draft.
async function autoRejectStaleApprovals(req){
  try{
    const cutoff=Date.now()-24*60*60*1000;
    const list=await getApprovals(); let changed=false; const done=[];
    for(const it of list){
      // Only 'pending' (a drafted reply awaiting a yes) auto-rejects after 24h. Escalated items
      // (waiting on a fact from Victor) are LEFT OPEN on purpose so their Q# keeps piling up and
      // they stay visible until handled — the backup email nudges instead of auto-closing them.
      if(!it || it.status!=="pending") continue;
      const t=Date.parse(it.ts||it.primaryNotifiedAt||"");
      if(!isFinite(t) || t>cutoff) continue;
      it.status="rejected"; it.decidedAt=new Date().toISOString();
      it.rejectReason="Auto-rejected: no decision within 24 hours"; it.autoRejected=true;
      changed=true; done.push({id:it.id});
    }
    if(changed) await setApprovals(list);
    return {autoRejected:done.length, items:done};
  }catch(e){ return {error:String(e.message||e)}; }
}
function htmlPage(title, msg){
  return '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>'+escHtml(title)+'</title></head>'
    +'<body style="font-family:Arial,Helvetica,sans-serif;background:#0f1720;color:#e7eef6;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">'
    +'<div style="background:#16212e;border:1px solid #26354a;border-radius:12px;padding:28px 32px;max-width:420px;text-align:center">'
    +'<h1 style="margin:0 0 8px 0;font-size:22px">'+escHtml(title)+'</h1>'
    +'<p style="color:#9fb0c0;margin:0">'+escHtml(msg)+'</p></div></body></html>';
}
// ===== Victor daily verification-call reminder =====
// Victor is supposed to EITHER complete a daily verification phone call (logged in
// parkside:calllog with isVictor=true) OR have email verification turned on. If, on a
// MONITORED day (Wed-Sat, America/New_York), he did NEITHER, email him once that we could
// not verify. Never runs Sun/Mon/Tue. Guarded against double-send by a per-day dedup key.
async function victorVerifyConfig(){
  let v=null; try{ if(redis) v=await redis.get("parkside:victor_verify"); }catch(e){}
  v=v||{};
  // emailEnabled: Victor's "email verification is on" flag (env fallback VICTOR_EMAIL_VERIFY=1)
  const envOn=String(process.env.VICTOR_EMAIL_VERIFY||"").trim();
  return { emailEnabled: (v.emailEnabled===true) || envOn==="1" || envOn.toLowerCase()==="true" };
}
async function victorCalledOn(date){ // did Victor complete a verification call on this ET date?
  try{ if(!redis) return false; const log=(await redis.get("parkside:calllog"))||[];
    return log.some(c=>c && c.isVictor===true && String(c.date||"")===date); }catch(e){ return false; }
}
async function sendVictorVerifyReminderEmail(){
  const cfg=await getNotifyConfig();
  const to=cfg.to; // Victor's email (victorEmail / VICTOR_EMAIL)
  const subject="Parkside — verification system didn't confirm today";
  const html='<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#0f172a">'
    +'<h2 style="margin:0 0 10px">The verification system didn\u2019t confirm today</h2>'
    +'<p style="font-size:14px;line-height:1.5">Our verification system wasn\u2019t able to confirm today \u2014 it didn\u2019t receive a verification call, and email verification isn\u2019t switched on for your account yet.</p>'
    +'<p style="font-size:14px;line-height:1.5">Nothing to worry about. Whenever it\u2019s convenient, complete the verification call or switch on email verification, and the system will confirm you going forward. Thanks so much!</p>'
    +'<p style="color:#94a3b8;font-size:12px">Automated note from the Parkside engine.</p></div>';
  const result=await resendSend({apiKey:cfg.apiKey, from:cfg.from, to, subject, html});
  return {...result, to, subject};
}
// Core check — safe to call from a cron or heartbeat. Returns what it did.
// Victor's WORKING-DAY calendar: he works Wed-Sat (ET); Sun/Mon/Tue are OFF and
// not tracked. A full-day entry in his time-off tab (parkside:timeoff, kind
// "day") also means he is off that date. The monitoring system must NOT grade
// or send emails/alerts on days he is not supposed to be working.
async function isTimeOffDay(dateStr){
  try{ if(redis){ const raw=await redis.lrange("parkside:timeoff",0,-1);
    const items=(raw||[]).map(function(x){ try{ return typeof x==="string"?JSON.parse(x):x; }catch(e){ return null; } }).filter(Boolean);
    return items.some(function(t){ return t && t.date===dateStr && (t.kind==="day" || !t.kind); });
  } }catch(e){}
  return false;
}
// item MW-12: sum a date's RECORDED time off (full-day and/or partial hours) from parkside:timeoff.
async function timeOffForDate(dateStr){
  const out={fullDay:false, hours:0};
  try{ if(redis){ const raw=await redis.lrange("parkside:timeoff",0,-1);
    const items=(raw||[]).map(function(x){ try{ return typeof x==="string"?JSON.parse(x):x; }catch(e){ return null; } }).filter(Boolean);
    items.forEach(function(t){ if(!t||t.date!==dateStr) return; if(t.kind==="hours"){ const h=Number(t.hours); if(isFinite(h)&&h>0) out.hours+=h; } else { out.fullDay=true; } });
  } }catch(e){}
  if(out.hours>24) out.hours=24;
  return out;
}
// item MW-12: active %% measured ONLY over on-duty time. Recorded off-minutes are removed from the
// (idle) side of the denominator, so inactivity during recorded time off can never drag the ratio
// down. Pure + deterministic so it can be unit-tested. active stays; only the idle window shrinks.
function onDutyActivePct(activeMin, inactiveMin, offMin){
  const a=Math.max(0, Number(activeMin)||0), inact=Math.max(0, Number(inactiveMin)||0), off=Math.max(0, Number(offMin)||0);
  const adjInactive=Math.max(0, inact - off);
  const adjTracked=a + adjInactive;
  return { adjInactive:adjInactive, adjTracked:adjTracked, pct: adjTracked>0 ? Math.round(100*a/adjTracked) : (a>0?100:0) };
}
async function isWorkingDay(dateStr){
  const wd=etWeekday(dateStr+"T12:00:00Z");
  if(!(wd>=3 && wd<=6)) return false;             // Sun/Mon/Tue = off
  if(await isTimeOffDay(dateStr)) return false;   // full day off in his time-off tab
  return true;
}
async function runVictorVerifyReminder(nowIso){
  const iso=nowIso||new Date().toISOString();
  const date=etDate(iso); const wd=etWeekday(iso);
  // Only Wed(3)-Sat(6). Sun(0)/Mon(1)/Tue(2) are NOT monitored — never send.
  if(!(wd>=3 && wd<=6)) return {sent:false, skipped:"not a monitored day (Wed-Sat only)", date, weekday:wd};
  // Only send in the EVENING of a work day (>= 8pm ET) so it's a real end-of-day
  // check-in, never a midnight/start-of-day fire (which read as "Tuesday night").
  const hr=etHour(iso);
  if(hr<20) return {sent:false, skipped:"before the 8pm ET end-of-day window", date, weekday:wd, hour:hr};
  if(await isTimeOffDay(date)) return {sent:false, skipped:"time-off day (in his days-off tab)", date, weekday:wd};
  const cfg=await victorVerifyConfig();
  if(cfg.emailEnabled) return {sent:false, skipped:"email verification enabled", date};
  if(await victorCalledOn(date)) return {sent:false, skipped:"verification call completed", date};
  // Dedup: one reminder per day max.
  const dk="parkside:verify_reminder_sent:"+date;
  try{ if(redis){ const already=await redis.get(dk); if(already) return {sent:false, skipped:"already reminded today", date, at:already}; } }catch(e){}
  const _ef=await getEmailFlags(); if(_ef.verifyReminder===false){ console.log("[email_flags] verify reminder suppressed for "+date); return {sent:false, skipped:"verify-reminder email turned off (email_flags.verifyReminder=false)", date}; }
  const r=await sendVictorVerifyReminderEmail();
  try{ if(redis) await redis.set(dk, new Date().toISOString()); }catch(e){}
  return {sent:!!(r&&r.sent===true), date, weekday:wd, email:r};
}
// ===== Shared living to-do list (Gavin + Victor + engine all read/write one doc) =====
// Pure-Node .docx text extractor (no deps): read ZIP central directory -> inflate word/document.xml -> strip to text.
function docxToText(buf){
  const zlib=require('zlib');
  if(!Buffer.isBuffer(buf)) buf=Buffer.from(buf);
  let eocd=-1;
  for(let i=buf.length-22;i>=0 && i>buf.length-22-65536;i--){ if(buf.readUInt32LE(i)===0x06054b50){ eocd=i; break; } }
  if(eocd<0) throw new Error("not a .docx (no zip directory)");
  const cdOffset=buf.readUInt32LE(eocd+16); const cdCount=buf.readUInt16LE(eocd+10);
  let p=cdOffset, target=null;
  for(let n=0;n<cdCount;n++){
    if(buf.readUInt32LE(p)!==0x02014b50) break;
    const method=buf.readUInt16LE(p+10); const compSize=buf.readUInt32LE(p+20);
    const fnLen=buf.readUInt16LE(p+28); const exLen=buf.readUInt16LE(p+30); const cmLen=buf.readUInt16LE(p+32);
    const lho=buf.readUInt32LE(p+42); const name=buf.slice(p+46,p+46+fnLen).toString('utf8');
    if(name==='word/document.xml'){ target={method,compSize,lho}; break; }
    p=p+46+fnLen+exLen+cmLen;
  }
  if(!target) throw new Error("word/document.xml not found in the file");
  const lfn=buf.readUInt16LE(target.lho+26); const lex=buf.readUInt16LE(target.lho+28);
  const dataStart=target.lho+30+lfn+lex; const comp=buf.slice(dataStart, dataStart+target.compSize);
  let xml=(target.method===8 ? zlib.inflateRawSync(comp) : comp).toString('utf8');
  let t=xml.replace(/<w:tab\b[^>]*\/>/g,' ').replace(/<w:br\b[^>]*\/>/g,'\n').replace(/<\/w:p>/g,'\n')
    .replace(/<[^>]+>/g,'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&apos;/g,"'");
  return t.replace(/\r/g,'').replace(/[ \t]+\n/g,'\n').replace(/\n{3,}/g,'\n\n').trim().slice(0,20000);
}
async function fetchDocText(url){
  try{ let u=String(url||"").trim(); if(!u) return "";
    // Dropbox share link -> force direct download of the raw file
    if(/dropbox\.com/i.test(u)){ if(/[?&]dl=0\b/i.test(u)) u=u.replace(/([?&])dl=0\b/i,"$1dl=1"); else if(!/[?&]dl=1\b/i.test(u)) u+=(u.indexOf("?")>=0?"&":"?")+"dl=1"; }
    // Google Doc -> plain-text export (legacy)
    const m=u.match(/docs\.google\.com\/document\/d\/([A-Za-z0-9_-]+)/);
    if(m) u="https://docs.google.com/document/d/"+m[1]+"/export?format=txt";
    const r=await fetch(u,{redirect:"follow"}); if(!r||!r.ok) return "";
    const ab=await r.arrayBuffer(); const buf=Buffer.from(ab);
    // .docx (and any zip-based Office file) starts with the ZIP magic "PK"
    if(buf.length>=2 && buf[0]===0x50 && buf[1]===0x4b){ try{ return docxToText(buf); }catch(e){ return ""; } }
    let t=buf.toString("utf8");
    if(/<html|<!doctype/i.test(t.slice(0,300))){ t=t.replace(/<style[\s\S]*?<\/style>/gi," ").replace(/<script[\s\S]*?<\/script>/gi," ").replace(/<\/(p|div|h[1-6]|li|tr)>/gi,"\n").replace(/<[^>]+>/g," ").replace(/&nbsp;/g," ").replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&#39;/g,"'").replace(/&quot;/g,'"'); }
    return t.replace(/\r/g,"").replace(/[ \t]+\n/g,"\n").replace(/\n{3,}/g,"\n\n").trim().slice(0,20000);
  }catch(e){ return ""; }
}
async function getTodoDocUrl(){ try{ if(redis){ const u=await redis.get("parkside:todo_doc_url"); if(u) return String(u); } }catch(e){} return String(process.env.TODO_DOC_URL||""); }
async function getTodo(){
  const url=await getTodoDocUrl();
  if(url){
    try{ if(redis){ const c=await redis.get("parkside:todo_doc_cache"); if(c && c.url===url && (Date.now()-c.at)<600000) return {text:String(c.text||""), source:"doc", source_url:url, updated_at:new Date(c.at).toISOString()}; } }catch(e){}
    const text=await fetchDocText(url);
    try{ if(redis) await redis.set("parkside:todo_doc_cache",{url,text,at:Date.now()}); }catch(e){}
    return {text, source:"doc", source_url:url, updated_at:new Date().toISOString()};
  }
  try{ if(redis){ const t=await redis.get("parkside:todo"); if(t&&typeof t==="object") return {text:String(t.text||""), source:"stored", updated_at:t.updated_at||null, updated_by:t.updated_by||null}; if(typeof t==="string") return {text:t, source:"stored"}; } }catch(e){}
  return {text:"", source:"none"};
}
async function setTodo(text, by){ const doc={text:String(text||"").slice(0,20000), updated_at:new Date().toISOString(), updated_by:String(by||"").slice(0,40)}; try{ if(redis) await redis.set("parkside:todo", doc); }catch(e){} return doc; }
async function getBonus(){ try{ if(redis){ const b=await redis.get("parkside:bonus"); if(b&&typeof b==="object") return b; } }catch(e){} return {}; }
async function setBonus(o){ try{ if(redis) await redis.set("parkside:bonus", o); }catch(e){} return o; }
function bonusTerms(o){ const t=(o&&o._terms)||{}; return { revenueSharePct:(t.revenueSharePct!=null?Number(t.revenueSharePct):1), cleanRate:(t.cleanRate!=null?Number(t.cleanRate):5) }; }
// ===== Daily auto-grade + data-gap alert (recipients configurable in the panel / SCORE_ALERT_EMAILS) =====
function scoreAlertRecipients(cfg){
  const raw=(cfg&&cfg.scoreAlertEmails)||process.env.SCORE_ALERT_EMAILS||"";
  let list=String(raw).split(/[,;\s]+/).map(function(x){return x.trim();}).filter(Boolean);
  if(!list.length){ const g=(process.env.GAVIN_EMAIL||"").trim(), v=(cfg&&cfg.to)||""; list=[g,v].filter(Boolean); }
  return Array.from(new Set(list));
}
// ===== Configurable per-email recipients (Gavin tab) =====
// Each owner-facing email has a row {to:"a@b,c@d", victor:bool}. EMPTY config => identical to legacy behavior.
let _memER=null;
async function getEmailRecipients(){ try{ return (redis?(await redis.get("parkside:email_recipients")):_memER)||{}; }catch(e){ return {}; } }
async function setEmailRecipients(o){ if(redis) await redis.set("parkside:email_recipients",o); else _memER=o; return o; }
// ===== Master on/off flags for each automatic (non-guest) system email. DEFAULT TRUE so behavior is unchanged unless toggled off. =====
let _memEF=null;
const EMAIL_FLAG_DEFAULTS={gapAlert:true, monthlyReport:true, verifyReminder:true};
async function getEmailFlags(){ try{ const f=redis?(await redis.get("parkside:email_flags")):_memEF; if(f&&typeof f==="object") return Object.assign({}, EMAIL_FLAG_DEFAULTS, f); }catch(e){} return Object.assign({}, EMAIL_FLAG_DEFAULTS); }
async function setEmailFlags(o){ o=o||{}; const clean={ gapAlert:(o.gapAlert!==false), monthlyReport:(o.monthlyReport!==false), verifyReminder:(o.verifyReminder!==false) }; try{ if(redis) await redis.set("parkside:email_flags", clean); else _memEF=clean; }catch(e){} return clean; }
// ===== Master on/off for the daily AUTO-GRADER (Gavin's "Auto-grade on/off" toggle). DEFAULT TRUE so
// behavior is unchanged unless explicitly turned off. Backend-persisted (Redis) so OFF survives page
// refreshes / other devices AND the auto-grader itself respects it (localStorage alone did neither). =====
let _memAG=null;
async function getAutograde(){ try{ const v=redis?(await redis.get("parkside:autograde_enabled")):_memAG; if(v!==null&&v!==undefined) return !(v===false||v==="false"||v==="0"||v===0); }catch(e){} return true; }
async function setAutograde(on){ const en=(on!==false&&on!=="false"&&on!=="0"&&on!==0); try{ if(redis) await redis.set("parkside:autograde_enabled", en); else _memAG=en; }catch(e){} return en; }
const EMAIL_CATALOG=[
  {key:"gap_alert", name:"Daily data-gap alert", desc:"When the engine can't fully grade a day (missing WebWork, GPS, or Victor's report)."},
  {key:"monthly", name:"Monthly work report", desc:"Full month summary of Victor's grades, emailed on the 1st."},
];
function _splitAddrs(x){ return String(x||"").split(/[,;\s]+/).map(function(a){return a.trim();}).filter(Boolean); }
function resolveRecipients(er, key, cfg){
  var row=(er&&er[key])||{};
  if(row.enabled===false) return [];  // email turned OFF in the panel
  var list=[];
  if(typeof row.to==="string") list=_splitAddrs(row.to);
  if(row.victor && cfg && cfg.to) list.push(cfg.to);
  if(!list.length){ // legacy defaults - keep current behavior when unconfigured
    if(key==="gap_alert"||key==="monthly") list=scoreAlertRecipients(cfg);
    else if(key==="escalation") list=[cfg&&cfg.to2].filter(Boolean);
    else if(key==="verify") list=[cfg&&cfg.to].filter(Boolean);
  }
  return Array.from(new Set(list.filter(Boolean)));
}
async function sendScoreGapEmail(date, gaps, cfg){
  const to=resolveRecipients(await getEmailRecipients(), "gap_alert", cfg); if(!to.length) return {sent:false, reason:"no recipients configured (set them on the Gavin tab -> Report emails)"};
  const subject="Parkside — could not fully grade "+date+" (missing data) ⚠️";
  const html='<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#0f172a">'
    +'<h2 style="margin:0 0 10px">Daily grade incomplete for '+escHtml(date)+'</h2>'
    +'<p style="font-size:14px;line-height:1.5">The engine woke up to grade the day but could not gather every data set needed to verify the work. Missing:</p>'
    +'<ul style="font-size:14px;line-height:1.6">'+gaps.map(function(g){return "<li>"+escHtml(g)+"</li>";}).join("")+'</ul>'
    +'<p style="font-size:14px;line-height:1.5">Please review manually, or make sure the missing source is reporting: WebWork desktop app running, GPS tracking on, and Victor’s daily report submitted.</p>'
    +'<p style="color:#94a3b8;font-size:12px">Automated alert from the Parkside engine. Recipients are configurable (panel Email notifications / SCORE_ALERT_EMAILS).</p></div>';
  const r=await resendSend({apiKey:cfg.apiKey, from:cfg.from, to:to.join(","), subject, html});
  return Object.assign({}, r, {to});
}
// Grades YESTERDAY (ET, fully-complete day) when a report + data are present; otherwise emails Gavin+Victor about the gap.
async function runDailyScore(nowIso){
  const iso=nowIso||new Date().toISOString();
  const todayStr=etDate(iso);
  const y=new Date(todayStr+"T12:00:00Z"); y.setUTCDate(y.getUTCDate()-1);
  const date=y.toISOString().slice(0,10);
  const device="victor";
  const dk="parkside:daily_score_done:"+date;
  try{ if(redis){ const done=await redis.get(dk); if(done) return {skipped:"already handled", date, at:done}; } }catch(e){}
  if(!(await isWorkingDay(date))) return {skipped:"off day (Sun/Mon/Tue or in his time-off tab) — not graded, no alert", date};
  // Gavin's Auto-grade toggle (backend flag). When OFF, the auto-grader drafts no grade for the day.
  // Early return (before dk is marked done) so flipping it back ON lets the day grade normally.
  if(!(await getAutograde())) return {skipped:"auto-grade turned off (Gavin toggle) — no grade drafted", date};
  const cfg=await getNotifyConfig();
  const hours=await wwHoursForDate(date); const screen=await wwScreenActivity(date); const zones=await gpsZoneSummary(device,date);
  let report=""; try{ if(redis) report=(await redis.get("parkside:report:"+date))||""; }catch(e){}
  const gaps=[];
  if(!report||!String(report).trim()) gaps.push("Victor’s daily report (what he said he did) — nothing on file");
  if(!hours.available && !(screen&&screen.available)) gaps.push("WebWork data (hours + screen activity) — desktop app may not be running");
  if(!zones || zones.points===0) gaps.push("GPS location data — tracking may be off");
  let result;
  if(gaps.length){ const _ef=await getEmailFlags(); let email; if(_ef.gapAlert===false){ console.log("[email_flags] gap alert suppressed for "+date); email={sent:false, skipped:"gap-alert email turned off (email_flags.gapAlert=false)"}; } else { email=await sendScoreGapEmail(date, gaps, cfg); } result={date, graded:false, gaps, email}; }
  else { const out=await scoreDay(date, device); result={date, graded:!out.error, score:out, gaps:[]}; }
  try{ if(redis) await redis.set(dk, new Date().toISOString()); }catch(e){}
  return result;
}
// ===== Gavin's manual grades (ground truth) + in-context learning =====
async function buildDaySnapshot(date, device){
  const hours=await wwHoursForDate(date); const zones=await gpsZoneSummary(device||"victor",date); const screen=await wwScreenActivity(date);
  let report=""; try{ if(redis) report=(await redis.get("parkside:report:"+date))||""; }catch(e){}
  const bz=(zones&&zones.byZoneMin)||{};
  const hs=hours.available?(hours.hours+"h, "+hours.active_pct+"% active"):"no WebWork hours";
  const gs=(zones.on_site_min||0)+"/"+(zones.total_min||0)+" min on-site (office "+(bz.office||0)+", tepees "+(bz.tepees||0)+", maint "+(bz.maintenance||0)+", resort "+(bz.resort||0)+", off "+(bz.off||0)+")";
  const ss=screen.available?(screen.entries+" segs, "+screen.active_min+" active min"+(screen.avg_activity_pct!=null?(", "+screen.avg_activity_pct+"% activity"):"")+(screen.top_activities&&screen.top_activities.length?("; top "+screen.top_activities.slice(0,4).map(function(a){return a.label+"("+a.min+"m)";}).join(", ")):"")):"no screen activity";
  return { hours_summary:hs, gps_summary:gs, screen_summary:ss, report_excerpt:String(report).slice(0,600) };
}
async function getGavinGradeExamples(limit){
  let dates=[]; try{ if(redis){ const z=await redis.zrange("parkside:grades_index",0,-1); dates=(z||[]).slice().reverse().slice(0,limit||8); } }catch(e){}
  const out=[]; for(const d of dates){ try{ const g=await redis.get("parkside:grade:"+d); if(g&&g.grade!=null) out.push(g); }catch(e){} }
  return out;
}
// ===== Weekly + Monthly work reports (Victor sees weekly in his tab; monthly emailed to Gavin+Victor) =====
function etDateAddDays(dateStr, n){ const d=new Date(dateStr+"T12:00:00Z"); d.setUTCDate(d.getUTCDate()+n); return d.toISOString().slice(0,10); }
function weekStartMonday(dateStr){ const d=new Date(dateStr+"T12:00:00Z"); const dow=d.getUTCDay(); const diff=(dow===0?-6:1-dow); d.setUTCDate(d.getUTCDate()+diff); return d.toISOString().slice(0,10); }
function weekdayName(dateStr){ try{ return new Date(dateStr+"T12:00:00Z").toLocaleDateString("en-US",{weekday:"long",timeZone:"UTC"}); }catch(e){ return ""; } }
function monthLastDay(month){ const a=month.split("-"); const y=Number(a[0]), m=Number(a[1]); const d=new Date(Date.UTC(y,m,0)); return d.toISOString().slice(0,10); }
async function buildWeeklyReport(weekStart){
  const days=[]; let sum=0, graded=0, scored=0;
  for(let i=0;i<7;i++){ const date=etDateAddDays(weekStart,i);
    let score=null, grade=null; try{ if(redis){ score=await redis.get("parkside:score:"+date); grade=await redis.get("parkside:grade:"+date); } }catch(e){}
    const ownerG=!!(grade&&grade.grade!=null);
    const g = ownerG ? Number(grade.grade) : (score&&score.productivity_score!=null?Number(score.productivity_score):null);
    const src = ownerG ? "owner" : (score?"ai":null);
    const expl = (grade&&grade.note)? String(grade.note) : (score&&score.summary?String(score.summary):"");
    if(g!=null){ sum+=g; graded++; } if(score) scored++;
    days.push({ date, weekday:weekdayName(date), grade:(g!=null?Math.round(g):null), source:src, owner_graded:ownerG, explanation:expl, truth:(score&&score.truth_score!=null?Math.round(score.truth_score):null), hours:(score&&score.hours_worked!=null?score.hours_worked:null) });
  }
  return { weekStart, weekEnd:etDateAddDays(weekStart,6), days, avgGrade:(graded?Math.round(sum/graded):null), gradedDays:graded, scoredDays:scored };
}
async function weeklyNarrative(rep, force){
  const key=process.env.ANTHROPIC_API_KEY; if(!key) return null;
  if(!rep.days.some(function(d){return d.grade!=null;})) return null;
  const cacheKey="parkside:weekly_ai:"+rep.weekStart;
  if(!force){ try{ if(redis){ const c=await redis.get(cacheKey); if(c && c.gradedDays===rep.gradedDays && c.text) return c.text; } }catch(e){} }
  const lines=rep.days.map(function(d){ return d.date+" ("+d.weekday+"): "+(d.grade!=null?(d.grade+"/100"+(d.source==="owner"?" [owner-graded]":"")):"no grade")+(d.explanation?(" — "+d.explanation):""); }).join("\n");
  const sys="You write a short, constructive WEEKLY work summary addressed directly to Victor (maintenance/operations at a glamping resort). Honest but encouraging and specific. Cover: how the week went overall, which days were strong and why, which were weak or need improvement and where to focus. 3-5 short sentences, plain paragraph (no JSON, no lists).";
  try{ const r=await fetch("https://api.anthropic.com/v1/messages",{method:"POST",headers:{"x-api-key":key,"anthropic-version":"2023-06-01","content-type":"application/json"},body:JSON.stringify({model:"claude-haiku-4-5-20251001",max_tokens:400,temperature:0.3,system:sys,messages:[{role:"user",content:"Week of "+rep.weekStart+" to "+rep.weekEnd+". Average grade: "+(rep.avgGrade!=null?(rep.avgGrade+"/100"):"n/a")+".\nDaily grades:\n"+lines}]})});
    const j=await r.json(); if(!r.ok) return null; const text=((j.content&&j.content[0]&&j.content[0].text)||"").trim();
    try{ if(redis&&text) await redis.set(cacheKey,{text,gradedDays:rep.gradedDays}); }catch(e){}
    return text||null;
  }catch(e){ return null; }
}
async function buildMonthlyReport(month){
  const first=month+"-01"; const last=monthLastDay(month); const firstMon=weekStartMonday(first);
  const weeks=[];
  for(let i=0;i<6;i++){ const ws=etDateAddDays(firstMon,i*7); const we=etDateAddDays(ws,6);
    if(ws>last) break;
    if(we>=first && ws<=last){ const rep=await buildWeeklyReport(ws); rep.narrative=await weeklyNarrative(rep,false); weeks.push(rep); } }
  return { month, weeks };
}
function monthlyReportHtml(mr){
  let body='<div style="font-family:Arial,Helvetica,sans-serif;max-width:640px;margin:0 auto;color:#0f172a">'
    +'<h2 style="margin:0 0 6px">Victor — Monthly Work Report</h2>'
    +'<div style="color:#475569;margin-bottom:14px">'+escHtml(mr.month)+'</div>';
  if(!mr.weeks.length) body+='<p>No graded days this month yet.</p>';
  for(const w of mr.weeks){
    body+='<div style="border:1px solid #e2e8f0;border-radius:10px;padding:12px 14px;margin-bottom:12px">'
      +'<div style="font-weight:700;margin-bottom:4px">Week of '+escHtml(w.weekStart)+' – '+escHtml(w.weekEnd)+(w.avgGrade!=null?(' · avg '+w.avgGrade+'/100'):'')+'</div>';
    if(w.narrative) body+='<div style="font-size:13px;color:#334155;margin-bottom:8px">'+escHtml(w.narrative)+'</div>';
    body+='<table style="width:100%;border-collapse:collapse;font-size:13px">';
    for(const d of w.days){ const g=(d.grade==null?'—':d.grade+'/100'); body+='<tr><td style="padding:3px 0;color:#475569;white-space:nowrap">'+escHtml(d.weekday.slice(0,3))+' '+escHtml(d.date.slice(5))+'</td><td style="padding:3px 8px;font-weight:600;white-space:nowrap">'+g+'</td><td style="padding:3px 0;color:#64748b">'+escHtml(d.explanation||'')+'</td></tr>'; }
    body+='</table></div>';
  }
  body+='<p style="color:#94a3b8;font-size:12px">Automated monthly report from the Parkside engine.</p></div>';
  return body;
}
async function sendMonthlyReport(month, cfg){
  cfg=cfg||await getNotifyConfig();
  const to=resolveRecipients(await getEmailRecipients(), "monthly", cfg); if(!to.length) return {sent:false, reason:"no recipients configured (set them on the Gavin tab -> Report emails)"};
  const mr=await buildMonthlyReport(month);
  const html=monthlyReportHtml(mr);
  const subject="Parkside — Victor monthly work report ("+month+")";
  const r=await resendSend({apiKey:cfg.apiKey, from:cfg.from, to:to.join(","), subject, html});
  return Object.assign({}, r, {to, month, weeks:mr.weeks.length});
}
async function runMonthlyReportIfDue(nowIso){
  const today=etDate(nowIso||new Date().toISOString());
  if(!/-01$/.test(today)) return {skipped:"not the 1st", today};
  const d=new Date(today+"T12:00:00Z"); d.setUTCDate(0); const prev=d.toISOString().slice(0,7);
  const dk="parkside:monthly_sent:"+prev;
  try{ if(redis){ const done=await redis.get(dk); if(done) return {skipped:"already sent", prev, at:done}; } }catch(e){}
  const _ef=await getEmailFlags(); if(_ef.monthlyReport===false){ console.log("[email_flags] monthly report suppressed for "+prev); return {skipped:"monthly-report email turned off (email_flags.monthlyReport=false)", prev}; }
  const r=await sendMonthlyReport(prev, null);
  try{ if(redis) await redis.set(dk, new Date().toISOString()); }catch(e){}
  return {month:prev, email:r};
}
function editPageHtml(it, token, unit, guestName, errMsg){
  const action='/api/app?action=edit_approval&id='+encodeURIComponent(it.id)+'&token='+encodeURIComponent(token||'');
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Write the reply</title></head>'
    +'<body style="font-family:-apple-system,Arial,Helvetica,sans-serif;background:#0f1720;color:#e7eef6;margin:0;padding:16px">'
    +'<div style="max-width:560px;margin:0 auto">'
    +'<h1 style="font-size:20px;margin:6px 0 12px 0">Write the reply</h1>'
    +(unit?'<div style="color:#9fb0c0;font-size:13px">Unit: <b style="color:#e7eef6">'+escHtml(unit)+'</b></div>':'')
    +(guestName?'<div style="color:#9fb0c0;font-size:13px">Guest: <b style="color:#e7eef6">'+escHtml(guestName)+'</b></div>':'')
    +'<div style="background:#16212e;border:1px solid #26354a;border-radius:10px;padding:12px 14px;margin:12px 0">'
    +'<div style="color:#9fb0c0;font-size:12px;margin-bottom:4px">Guest asked</div>'
    +'<div style="font-size:15px">'+escHtml(it.question)+'</div></div>'
    +(errMsg?'<div style="color:#f87171;font-size:13px;margin:6px 0">'+escHtml(errMsg)+'</div>':'')
    +'<form method="POST" action="'+action+'">'
    +'<label style="color:#9fb0c0;font-size:12px">Your reply to the guest</label>'
    +'<textarea name="answer" style="width:100%;min-height:160px;font-size:16px;padding:12px;border-radius:10px;border:1px solid #26354a;background:#0c141d;color:#e7eef6;box-sizing:border-box;margin-top:6px">'+escHtml(it.proposed||"")+'</textarea>'
    +'<button type="submit" style="width:100%;margin-top:12px;background:#16a34a;color:#fff;border:none;border-radius:10px;padding:15px;font-size:17px;font-weight:700">Send reply to guest</button>'
    +'</form>'
    +'<p style="color:#64748b;font-size:12px;margin-top:10px">Sending replies to the guest via OwnerRez and saves this exact answer so similar questions suggest it next time. (Ref '+escHtml(it.id)+')</p>'
    +'</div></body></html>';
}
// item RES: RESERVATIONS/front-desk FACT-SUPPLY pages. The email links here for an UNKNOWN-fact escalation:
// they type just the fact, the model writes the full guest reply, they review and send. Same design as
// Victor's "Q# <fact>" flow, routed through decideApproval so it can never double-send with Victor.
function supplyFactFormHtml(it, token, errMsg){
  const action='/api/app?action=supply_fact&id='+encodeURIComponent(it.id)+'&token='+encodeURIComponent(token||'');
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Answer the guest</title></head>'
    +'<body style="font-family:-apple-system,Arial,Helvetica,sans-serif;background:#0f1720;color:#e7eef6;margin:0;padding:16px">'
    +'<div style="max-width:560px;margin:0 auto">'
    +'<h1 style="font-size:20px;margin:6px 0 4px 0">A guest needs an answer</h1>'
    +'<div style="color:#9fb0c0;font-size:13px;margin-bottom:12px">Tell us the fact and the assistant writes the full reply and sends it — you don’t need to write the whole message.</div>'
    +(it.guest_name?'<div style="color:#9fb0c0;font-size:13px">Guest: <b style="color:#e7eef6">'+escHtml(it.guest_name)+'</b></div>':'')
    +(it.unit?'<div style="color:#9fb0c0;font-size:13px">Unit: <b style="color:#e7eef6">'+escHtml(it.unit)+'</b></div>':'')
    +'<div style="background:#16212e;border:1px solid #26354a;border-radius:10px;padding:12px 14px;margin:12px 0">'
    +'<div style="color:#9fb0c0;font-size:12px;margin-bottom:4px;text-transform:uppercase">Guest asked</div>'
    +'<div style="font-size:16px">'+escHtml(it.question||"")+'</div></div>'
    +(errMsg?'<div style="color:#f87171;font-size:13px;margin:6px 0">'+escHtml(errMsg)+'</div>':'')
    +'<form method="POST" action="'+action+'">'
    +'<input type="hidden" name="step" value="draft">'
    +'<label style="color:#9fb0c0;font-size:13px">What should we tell them? <span style="color:#64748b">(just the fact — e.g. “11pm” or “early check-in is $30”)</span></label>'
    +'<textarea name="fact" autofocus style="width:100%;min-height:90px;font-size:16px;padding:12px;border-radius:10px;border:1px solid #26354a;background:#0c141d;color:#e7eef6;box-sizing:border-box;margin-top:6px" placeholder="Enter the answer / fact"></textarea>'
    +'<button type="submit" style="width:100%;margin-top:12px;background:#2563eb;color:#fff;border:none;border-radius:10px;padding:15px;font-size:17px;font-weight:700">Submit this fact</button>'
    +'</form>'
    +'<p style="color:#64748b;font-size:12px;margin-top:10px">You’ll see the full reply before it goes to the guest. Nothing is sent until you confirm. (Ref '+escHtml(it.id)+')</p>'
    +'</div></body></html>';
}
function supplyFactReviewHtml(it, token, fact, draft, errMsg){
  const action='/api/app?action=supply_fact&id='+encodeURIComponent(it.id)+'&token='+encodeURIComponent(token||'');
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Review & send</title></head>'
    +'<body style="font-family:-apple-system,Arial,Helvetica,sans-serif;background:#0f1720;color:#e7eef6;margin:0;padding:16px">'
    +'<div style="max-width:560px;margin:0 auto">'
    +'<h1 style="font-size:20px;margin:6px 0 12px 0">Review the reply</h1>'
    +'<div style="background:#16212e;border:1px solid #26354a;border-radius:10px;padding:12px 14px;margin:12px 0">'
    +'<div style="color:#9fb0c0;font-size:12px;margin-bottom:4px;text-transform:uppercase">Guest asked</div>'
    +'<div style="font-size:15px">'+escHtml(it.question||"")+'</div></div>'
    +(errMsg?'<div style="color:#f87171;font-size:13px;margin:6px 0">'+escHtml(errMsg)+'</div>':'')
    +'<form method="POST" action="'+action+'">'
    +'<input type="hidden" name="step" value="send">'
    +'<input type="hidden" name="fact" value="'+escHtml(String(fact||"")).replace(/"/g,'&quot;')+'">'
    +'<label style="color:#9fb0c0;font-size:13px">This will be sent to the guest (edit if needed):</label>'
    +'<textarea name="answer" style="width:100%;min-height:150px;font-size:16px;padding:12px;border-radius:10px;border:1px solid #26354a;background:#0c141d;color:#e7eef6;box-sizing:border-box;margin-top:6px">'+escHtml(draft||"")+'</textarea>'
    +'<button type="submit" style="width:100%;margin-top:12px;background:#16a34a;color:#fff;border:none;border-radius:10px;padding:15px;font-size:17px;font-weight:700">Send to guest</button>'
    +'</form>'
    +'<p style="color:#64748b;font-size:12px;margin-top:10px">Sends this reply to the guest via OwnerRez. (Ref '+escHtml(it.id)+')</p>'
    +'</div></body></html>';
}

// ===== Approval queue + knowledge-base matching (human-in-the-loop messaging) =====
const AQKEY="parkside:approvals", INQKEY="parkside:inquiries";
let _memApprovals=[];
async function getApprovals(){ return redis?((await redis.get(AQKEY))||[]):_memApprovals; }
async function setApprovals(list){ const trimmed=list.slice(-500); if(redis) await redis.set(AQKEY, trimmed); else _memApprovals=trimmed; return list; }
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
// ===== Separate, HIGH-WEIGHT "approved bank" (Q&A Victor physically approved) =====
// Stored apart from the editable KB and checked FIRST by the matcher.
const KBAKEY="parkside:kb_approved";
let _memApprovedBank=[];
let _memRejected=[];
async function getApprovedBank(){ return redis?((await redis.get(KBAKEY))||[]):_memApprovedBank; }
async function setApprovedBank(list){ const t=list.slice(-1000); if(redis) await redis.set(KBAKEY,t); else _memApprovedBank=t; return t; }
const _STOP=new Set("a an the is are am do does did can could would will to of for our your my we you i it at on in and or but please hi hello hey there this that what whats when where how who why be been was were as with about".split(" "));
function _toks(s){ return normQ(s).split(" ").filter(w=>w&&!_STOP.has(w)); }
function _jaccard(a,b){ const A=new Set(a),B=new Set(b); if(!A.size||!B.size) return 0; let i=0; for(const x of A) if(B.has(x)) i++; return i/(A.size+B.size-i); }
const APPROVED_THRESHOLD=0.82; // auto-send only at/above this similarity to an approved Q
async function approvedBankMatch(question){
  const bank=await getApprovedBank(); const qn=normQ(question); const qt=_toks(question);
  let best=null;
  for(const e of bank){ if(!e||!String(e.a||"").trim()) continue;
    const conf = (normQ(e.q)===qn) ? 1.0 : _jaccard(qt,_toks(e.q));
    if(!best||conf>best.confidence) best={answer:String(e.a).trim(), matchedQuestion:e.q, confidence:conf}; }
  return best;
}
async function upsertApprovedBank(question, answer){
  const bank=await getApprovedBank(); const qn=normQ(question);
  const ex=bank.find(e=>normQ(e.q)===qn);
  if(ex){ ex.a=answer; ex.ts=new Date().toISOString(); } else bank.push({id:Date.now().toString(36)+Math.random().toString(36).slice(2,6), q:question, a:answer, ts:new Date().toISOString()});
  await setApprovedBank(bank); return bank.length;
}
async function orAuthHeader(){ const cfg=await getNotifyConfig(); if(cfg.ownerrezOauth) return "Bearer "+cfg.ownerrezOauth;
  const u=process.env.OWNERREZ_API_USER,t=process.env.OWNERREZ_API_TOKEN; if(u&&t) return "Basic "+Buffer.from(u+":"+t).toString("base64"); return null; }
function orBasicHeader(){ const u=process.env.OWNERREZ_API_USER,t=process.env.OWNERREZ_API_TOKEN; return (u&&t)?("Basic "+Buffer.from(u+":"+t).toString("base64")):null; }
async function orOauthHeader(){ const cfg=await getNotifyConfig(); return cfg.ownerrezOauth?("Bearer "+cfg.ownerrezOauth):null; }
// Endpoint-agnostic OwnerRez fetch: try the preferred auth, fall back to the OTHER on
// 401/403/405. The OAuth "Grant Access To Me" token works for messaging but is rejected
// (401 Invalid token) by /v2/bookings + /v2/guests, which need the Basic PAT — and vice
// versa. This uses whichever actually works per endpoint. prefer: "oauth" | "basic".
async function orFetch(url, opts){ opts=opts||{}; const baseHeaders=opts.headers||{};
  const oauth=await orOauthHeader(); const basic=orBasicHeader();
  const order=(opts.prefer==="basic")?[["basic",basic],["oauth",oauth]]:[["oauth",oauth],["basic",basic]];
  let last=null;
  for(const [name,a] of order){ if(!a) continue;
    const r=await fetch(url,{...opts, headers:{...baseHeaders, Authorization:a}});
    if(r.status!==401 && r.status!==403 && r.status!==405){ r._authUsed=name; return r; }
    last=r;
  }
  return last; }

let _memPollStatus=null, _memPollLast=0;
async function writePollStatus(o){ const s={...o, ranAt:new Date().toISOString()}; if(redis) await redis.set("parkside:poll_status",s); else _memPollStatus=s; return s; }
async function getPollStatus(){ return (redis?await redis.get("parkside:poll_status"):_memPollStatus)||null; }
// Pull recent OwnerRez messages and feed NEW inbound guest ones into the pipeline.
async function runPollMessages(req){
  // Inbound now arrives via OwnerRez webhook (thread_message -> action=or_message_inbound).
  // GET /v2/messages is not readable (405), so polling is disabled to stop the noise.
  return await writePollStatus({ok:true, polled:0, disabled:true, note:"inbound via OwnerRez webhook (thread_message); GET /v2/messages polling disabled"});
  /* eslint-disable no-unreachable */
  const auth=await orAuthHeader();
  if(!auth) return await writePollStatus({ok:false, polled:0, error:"OwnerRez token not set (paste the OwnerRez OAuth token in Victor's → Email notifications, or set OWNERREZ_OAUTH_TOKEN / OWNERREZ_API_USER+TOKEN)"});
  const H={Authorization:auth,"Content-Type":"application/json","User-Agent":"parkside-control/1.0"};
  const sinceIso=new Date(Date.now()-1000*60*60*24).toISOString(); // last 24h window
  let items=[];
  try{ const r=await fetch("https://api.ownerrez.com/v2/messages?since_utc="+encodeURIComponent(sinceIso),{headers:H});
    if(!r.ok){ const t=await r.text(); return await writePollStatus({ok:false, polled:0, status:r.status, error:"OwnerRez messages "+r.status, detail:t.slice(0,200), note:"OwnerRez Messaging API is gated: GET /v2/messages + message webhooks require (1) an OAuth app token (NOT a Personal Access Token) with messaging scope, and (2) a Messaging API partnership agreement (email partnerhelp@ownerrez.com, subject 'Messaging API Access'). A 405 here means the current token/app lacks that access."}); }
    const j=await r.json(); items=j.items||j.messages||(Array.isArray(j)?j:[]); }
  catch(e){ return await writePollStatus({ok:false, polled:0, error:String(e.message||e)}); }
  const seenArr=(redis&&await redis.get("parkside:msg_seen"))||[]; const seen=new Set(seenArr);
  const isInbound=m=>{ const d=String(m.direction||m.type||m.sender_type||"").toLowerCase();
    if(/out|sent|host|owner|staff|me\b/.test(d)) return false;
    if(/in|recv|received|guest|traveler|customer/.test(d)) return true;
    if(m.is_from_guest===true||m.from_guest===true||m.incoming===true) return true;
    return true; }; // default: treat unknown as inbound (de-duped, so worst case one extra email)
  let processed=0, queued=0, autoSent=0, skipped=0;
  for(const m of items){ const mid=String(m.id||m.message_id||m.guid||""); if(!mid||seen.has(mid)){ continue; }
    seen.add(mid);
    if(!isInbound(m)){ skipped++; continue; }
    const question=String(m.body||m.message||m.content||m.text||"").trim(); if(!question){ skipped++; continue; }
    try{ const out=await processGuestQuestion(req,{question, bookingId:m.booking_id||m.bookingId||null, source:"ownerrez_poll"});
      processed++; if(out.auto_approved) autoSent++; else if(out.queued) queued++; }
    catch(e){ /* keep going */ }
  }
  if(redis) await redis.set("parkside:msg_seen", Array.from(seen).slice(-5000));
  return await writePollStatus({ok:true, polled:items.length, processed, queued, autoSent, skipped,
    sampleKeys: items[0]?Object.keys(items[0]):null,
    sampleDirection: items[0]?(items[0].direction||items[0].type||items[0].sender_type||null):null });
}
// Throttled wrapper so any page load can safely drive intake (>=60s apart).
async function maybePollMessages(req){
  const now=Date.now(); const last=(redis?(await redis.get("parkside:poll_last")):_memPollLast)||0;
  if(now-last<60000) return null;
  if(redis) await redis.set("parkside:poll_last",now); else _memPollLast=now;
  try{ return await runPollMessages(req); }catch(e){ return {ok:false, error:String(e.message||e)}; }
}

// Shared intake pipeline for EVERY guest question (manual ask, OwnerRez poll, webhook).
//  - APPROVED BANK match >= threshold -> auto-send to guest, no human, no email.
//  - otherwise -> propose an answer (bank near-match -> KB synonym -> AI draft) and
//    EMAIL Victor with Approve/Reject links. Nothing is sent to the guest until Approve.
// Strict human-approval mode. Default ON: NOTHING auto-sends; even a high-confidence
// approved-bank/KB match is used only to PRE-FILL the suggested reply in the email.
// Toggle off later via env REQUIRE_APPROVAL_ALL=false or notify_config.requireApprovalAll=false.
async function requireApprovalAll(){ const raw=await getNotifyRaw();
  if(typeof raw.requireApprovalAll==="boolean") return raw.requireApprovalAll;
  return String(process.env.REQUIRE_APPROVAL_ALL||"true").toLowerCase()!=="false"; }
// Auto-message mode: when ON, the engine SENDS replies itself (known->answer, unknown->holding + escalate to Victor) instead of staging every reply for approval.
async function autoMessageOn(){ const raw=await getNotifyRaw(); if(typeof raw.autoMessage==="boolean") return raw.autoMessage; return String(process.env.AUTO_MESSAGE||"false").toLowerCase()==="true"; }
// Pending "learned facts" — new facts are queued here for human review; they are NOT used in messaging until approved into the KB.
let _memPendingFacts=[];
async function getPendingFacts(){ try{ return (redis?(await redis.get("parkside:pending_facts")):_memPendingFacts)||[]; }catch(e){ return []; } }
async function setPendingFacts(a){ if(redis) await redis.set("parkside:pending_facts",a); else _memPendingFacts=a; return a; }
async function addPendingFact(o){ o=o||{}; try{ const list=await getPendingFacts(); const nq=normQ(o.q||o.topic||""); let rec=nq?list.find(x=>x&&x.status==="pending"&&normQ(x.q||x.topic||"")===nq):null; const now=new Date().toISOString();
  if(rec){ rec.a=String(o.a||"").slice(0,1500); if(o.topic) rec.topic=String(o.topic).slice(0,80); rec.source=o.source||rec.source; rec.at=now; }
  else { list.push({ id:Date.now().toString(36)+Math.random().toString(36).slice(2,6), q:String(o.q||"").slice(0,300), topic:String(o.topic||o.q||"").slice(0,80), a:String(o.a||"").slice(0,1500), source:o.source||"", status:"pending", at:now }); }
  await setPendingFacts(list.slice(-300)); }catch(e){} }

async function processGuestQuestion(req, p){
  const question=String(p.question||"").trim(); if(!question) return {error:"no question"};
  const bookingId=p.bookingId||null, unit=p.unit||"", guestName=p.guestName||"", threadId=p.threadId||p.thread_id||null;
  const st=await getState(); const enabled=!!st.messaging_enabled; const kb=st.kb||KB_SEED;
  const auto=await autoMessageOn();
  const history=await getThreadLog(threadId, bookingId);
  const hasHistory=(history||[]).some(function(m){ return m && m.d==="out"; }); // have we already messaged this guest?
  await appendThreadLog(threadId, bookingId, "in", question, guestName);
  // COMPLAINT HANDOFF MUTE: once a complaint has handed this thread to a human, the engine sends NO further
  // auto-response to the guest for ANY subsequent message on the thread (the inbound is logged above for the
  // human's context; but no reply, no holding, no pleasantry logic, no new escalation text/email). The human
  // handles everything after the first complaint. Persists for the rest of the conversation (no auto-clear).
  try{ const _mk=threadKey(threadId, bookingId); if(_mk && redis){ const _muted=await redis.get("parkside:complaint_mute:"+_mk); if(_muted){ return {complaint_muted:true, no_guest_reply:true, question, since:_muted}; } } }catch(e){}
  // item B: obvious pleasantry/acknowledgment ("ok", "thanks", "sounds good", a thumbs-up, ...) -> NO reply,
  // NO escalation (logged above for the record). Deterministic so the clear cases never vary. Also stops us
  // from forwarding a bare "thanks" to Victor when an escalation is open.
  if(isObviousPleasantry(question)){ return {no_response_needed:true, pleasantry:true, question}; }
  const draft=await aiDraftAnswer(kb, question, guestName, await getApprovedBank(), history);
  // Skip messages the AI classifies as pure acknowledgment (no question / no actionable content).
  if(draft && draft.needs_response===false){ return {no_response_needed:true, question}; }
  // If this thread already has an OPEN escalation (a manager is already handling it), do NOT
  // send another "checking with my manager" holding. Stay quiet to the guest and just forward
  // the new message to the manager on the text thread so they can respond.
  if(auto){
    const _al=await getApprovals();
    const _open=_al.find(it=>it && it.status==="escalated" && ((threadId&&it.thread_id===threadId)||(bookingId&&String(it.booking_id)===String(bookingId))));
    if(_open){
      const _now=new Date().toISOString();
      // STALE-CONTEXT FIX: a follow-up guest message BEFORE Victor answers must UPDATE the open escalation's
      // stored context, so when he replies the drafted answer reflects the LATEST full ask (message #1 + the
      // follow-up) rather than only the first message. The two-way transcript already has every message; we
      // fold the new one into the open item's question and re-notify Victor with the full recent thread.
      if(!_open.firstQuestion) _open.firstQuestion=_open.question||"";
      _open.question=String((_open.question?(_open.question+"\n\n[Follow-up from guest] "):"")+question).slice(-2000);
      _open.ts=_now; _open.lastGuestMsgAt=_now;
      await setApprovals(_al);
      const vsms=await sendVictorEscalationSms(req, _open, {complaint:!!_open.complaint, followup:true, newMsg:question});
      return {forwarded_to_manager:true, no_guest_reply:true, id:_open.id, victorSms:vsms, question};
    }
  }
  const knownFull=(draft.known==="full");
  const isComplaint=!!(draft&&draft.complaint);
  let proposed=isComplaint?holdingMessage(guestName,true,hasHistory):(draft.answer||holdingMessage(guestName,false,hasHistory));
  const list=await getApprovals();
  const _lbl=await nextSmsLabel();
  const item={ id:Date.now().toString(36)+Math.random().toString(36).slice(2,6), question, proposed, escalate:(!knownFull||isComplaint), complaint:isComplaint,
    unit, guest_name:guestName, booking_id:bookingId, thread_id:threadId, source:p.source||"manual", ts:new Date().toISOString(),
    smsLabel:_lbl, smsCode:mkSmsCode(), firstProposed:proposed, primaryNotifiedAt:new Date().toISOString() };
  if(!auto){
    // Legacy (auto-message OFF): stage every reply for approval; text Victor to approve/deny.
    item.status="pending"; list.push(item); await setApprovals(list);
    const victorEmail=await sendVictorApprovalEmail(req, item, {unit, guestName});
    return {queued:true, mode:"approval", id:item.id, proposed, escalate:!knownFull, victorEmail};
  }
  if(knownFull && !isComplaint){
    // AUTO-MESSAGE: it fully knows the answer -> send the composed reply to the guest now.
    const guestSend=await sendGuestReply(enabled, {threadId, bookingId}, proposed);
    item.status="answered"; item.answer=proposed; item.auto=true; item.decidedAt=new Date().toISOString(); item.guestSend=guestSend;
    list.push(item); await setApprovals(list);
    await addPendingFact({ q:question, a:proposed, source:"auto_answer" }); // queue Q->A for KB review (not auto-added)
    return {auto_answered:true, sent:guestSend.sent===true, id:item.id, proposed, guestSend};
  }
  // item #1 PARTIAL: the engine HAS a KB-grounded answer (draft.answer already includes what it knows
  // plus a short "I'll confirm the rest" line). SEND that real answer to the guest instead of overwriting
  // it with the generic holding note, and STILL text Victor for the unknown part so the promised follow-up
  // happens. Only genuine unknowns ("none") and complaints fall through to the generic holding below.
  if(draft.known==="partial" && !isComplaint && draft.answer && String(draft.answer).trim()){
    const guestSend=await sendGuestReply(enabled, {threadId, bookingId}, proposed);
    item.status="escalated"; item.partialAnswered=true; item.holdingSent=false;
    item.answer=proposed; item.answeredToGuest=(guestSend.sent===true);
    list.push(item); await setApprovals(list);
    const vsms=await sendVictorEscalationSms(req, item, {unit, guestName, partial:true});
    return {partial_answered:true, escalated:true, sent:(guestSend.sent===true), id:item.id, victorSms:vsms};
  }
  // Genuinely unknown ("none") OR a complaint: send the generic holding, then text Victor.
  const hold=holdingMessage(guestName, isComplaint, hasHistory);
  const guestSend=await sendGuestReply(enabled, {threadId, bookingId}, hold);
  item.status="escalated"; item.proposed=hold; item.holdingSent=(guestSend.sent===true);
  list.push(item); await setApprovals(list);
  const vsms=await sendVictorEscalationSms(req, item, {unit, guestName, complaint:isComplaint});
  // A COMPLAINT follows the SAME escalation channel flow as any unknown-fact item: serious holding to the guest +
  // SMS to Victor now, then (item stays status "escalated") the ONE 60-min backup email to to2 via the sweep only
  // if it is still unanswered. NO simultaneous/immediate primary email.
  // COMPLAINT HANDOFF: mark the thread MUTED so the first serious holding is the LAST auto-message — every later
  // guest message on this thread is handled by the human, with no further auto-reply or per-message escalation.
  if(isComplaint){ try{ const _mk=threadKey(threadId, bookingId); if(_mk && redis){ await redis.set("parkside:complaint_mute:"+_mk, new Date().toISOString()); } }catch(e){} }
  return {escalated:true, complaint:isComplaint, holding_sent:guestSend.sent===true, id:item.id, victorSms:vsms, complaintMuted:isComplaint};
}
// item: clip a quoted message to <= max chars WITHOUT cutting mid-word — break on the last whitespace and add
// an ellipsis. Prevents the escalation SMS context from ending mid-token ("...arrival instructi").
function clipWords(s, max){
  s=String(s||"").replace(/\s+/g," ").trim();
  if(s.length<=max) return s;
  var cut=s.slice(0, max);
  var sp=cut.lastIndexOf(" ");
  if(sp > Math.floor(max*0.5)) cut=cut.slice(0, sp);        // break on whitespace, never mid-word
  cut=cut.replace(/[\s.,;:!?\u2013\u2014\-]+$/,"");        // trim trailing space/punctuation
  return cut+"\u2026";                                       // add ellipsis
}
async function sendVictorEscalationSms(req, item, ctx){
  ctx=ctx||{};
  const cfg=await getNotifyConfig();
  if(!(cfg.smsUrl&&cfg.smsTo)) return {sent:false, reason:"SMS not configured"};
  const unit=ctx.unit||item.unit||""; const guestName=ctx.guestName||item.guest_name||"";
  const lbl=item.smsLabel||"Q?";
  const _hist=(await getThreadLog(item.thread_id, item.booking_id)).filter(m=>m&&m.b).slice(-5);
  // Show each recent turn's text IN FULL — no per-message clipping/ellipsis (Gavin wants complete context).
  const _line=function(m){ return (m.d==="out"?"Us: ":"Guest: ")+String(m.b).replace(/\s+/g," ").trim(); };
  let _convo=_hist.length?_hist.map(_line).join("\n\n"):("Guest: "+String(item.question||"").replace(/\s+/g," ").trim());
  // Safety ONLY: if the total context is very large, drop the OLDEST whole turns — never clip a shown message.
  if(_hist.length>1){ let _t=_hist.slice(); while(_convo.length>3000 && _t.length>1){ _t=_t.slice(1); _convo=_t.map(_line).join("\n\n"); } }
  const _ctx=[unit,guestName].filter(Boolean).join(" - ");
  if(ctx.followup){
    const _nm=String(ctx.newMsg||item.question||"").replace(/\s+/g," ").trim();
    const _ft=lbl+(_ctx?(" - "+_ctx):"")+" \u2014 the guest sent ANOTHER message:\n\""+_nm+"\"\n\nFull recent conversation:\n"+_convo+"\n\nTo answer, text: "+lbl+" then the fact.";
    try{ return await sendSmsGateway(cfg, _ft); }catch(e){ return {sent:false, error:String(e.message||e)}; }
  }
  const _isComp=!!(ctx.complaint||item.complaint);
  const _mid=_isComp?"I told the guest I'm sorry and a manager will follow up.":(ctx.partial?"I answered what I could and told the guest I'd confirm the rest.":"I told the guest I'd check with a manager.");
  const _tag=_isComp?" (COMPLAINT)":(ctx.partial?" (partial \u2014 needs the rest)":" (escalated)");
  const text=(_isComp?"\u26A0 COMPLAINT \u2014 a manager should reply personally.\n":"")+lbl+(_ctx?(" - "+_ctx):"")+_tag+"\n"+_convo+"\n\n"+_mid+" To answer, text: "+lbl+" then the fact.";
  try{ return await sendSmsGateway(cfg, text); }catch(e){ return {sent:false, error:String(e.message||e)}; }
}

function scrubContact(text){
  if(!text) return text;
  var t=String(text);
  t=t.replace(/\(?\+?\d[\d\s().\-]{7,}\d\)?/g, function(m){ var d=m.replace(/\D/g,""); return (d.length>=10 && d.length<=15)?" ":m; });
  t=t.replace(/[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g," ");
  t=t.replace(/[ \t]{2,}/g," ").replace(/\s+([.,!?;:])/g,"$1").replace(/\(\s*\)/g,"").trim();
  return t;
}
function holdingMessage(guestName, complaint, hasHistory){ const f=String(guestName||"").trim().split(/\s+/)[0];
  // GREETING RULE: only greet with "Hi there" on a genuine FIRST contact with an unknown name. In an ONGOING
  // thread (hasHistory) with no name, skip the generic greeting entirely and just make the statement.
  const hi = f ? ("Hi "+f+(complaint?", ":"! ")) : (hasHistory ? "" : (complaint?"Hi there, ":"Hi there! "));
  if(complaint) return hi+"I\u2019m so sorry for the trouble \u2014 that\u2019s truly not the experience we want you to have. I\u2019m getting my manager involved right now and we\u2019ll get right back to you shortly.";
  // item #7 (APPROVED by Gavin): a STATEMENT that it's going to the manager, with NO question back to the guest.
  return hi+"Thanks for reaching out \u2014 I\u2019m checking with my manager on this and will follow up with you shortly."; }
// GREETING RULE (deterministic): once we are in an active thread, strip a leading "Hi/Hey/Hello [name]!,\u2014"
// greeting from a composed reply so we never re-greet ("Hi there... Hi there..."). Never returns empty.
function stripLeadGreeting(text){
  var t=String(text||"");
  var stripped=t.replace(/^\s*(hi|hey|hello)(\s+there)?(\s+[A-Za-z][A-Za-z'\-]*)?\s*[!,.\u2013\u2014-]+\s*/i, "");
  stripped=stripped.trim();
  return stripped ? (stripped.charAt(0).toUpperCase()+stripped.slice(1)) : t.trim();
}
// item #2/#3: short, friendly FIRST-CONTACT greeting for a no-message inquiry (no question posed, kept brief).
function firstContactGreeting(guestName){ const f=String(guestName||"").trim().split(/\s+/)[0];
  return "Hi "+(f||"there")+"! Thanks so much for reaching out about Parkside Tepees \uD83C\uDFD5\uFE0F We\u2019d love to host you \u2014 let me know if there\u2019s anything I can help with for your stay!"; }
// item B: obvious pleasantries / acknowledgments (no question, no problem) get NO reply. This is a NARROW,
// conservative fast-path (short filler-only messages) so we never depend on model variance for the clear cases;
// anything not caught here still goes to the AI classifier, which prefers escalate-over-ignore when unsure.
function isObviousPleasantry(text){
  var raw=String(text||"").trim();
  if(!raw) return true;                                   // empty
  if(/\?/.test(raw)) return false;                        // any question mark -> not pure filler
  var letters=raw.toLowerCase().replace(/[^a-z\s]/g," ").replace(/\s+/g," ").trim();
  if(!letters){ return /[\u{1F000}-\u{1FAFF}\u2600-\u27BF\u2764\uFE0F\u{1F44D}]/u.test(raw) || /^[\s\p{P}]+$/u.test(raw); } // emoji/punctuation only (e.g. a thumbs-up)
  var words=letters.split(" ").filter(Boolean);
  if(words.length>4) return false;                        // keep it to short acknowledgments only
  if(/\b(cancel|refund|leak|leaking|broke|broken|late|early|help|need|issue|problem|dirty|bug|bugs|smell|cold|hot|lost|stuck|emergency|complain|wrong|not|isn|doesn|won|cant|cannot)\b/.test(letters)) return false;
  var FILLER=new Set(["ok","okay","okey","k","kk","thanks","thank","thankyou","thx","ty","tysm","great","perfect","perfectly","awesome","cool","nice","gotcha","gotit","got","it","yes","yep","yeah","yup","sure","alright","allright","fine","understood","noted","cheers","bet","word","sounds","sound","good","appreciate","appreciated","appreciate","you","u","so","very","much","really","will","do","that","much","thumbs","up"]);
  return words.every(function(w){ return FILLER.has(w); });
}
// item #5: Victor sometimes types the placeholder literally ("Q9 <the answer/fact>") or wraps his real
// answer in the angle brackets ("Q9 <the unit is ready>"). Strip a wrapping <...> and any bare placeholder
// token so the remaining text is treated as his answer. Applied to SMS and MMS replies identically.
// item: detect an iMessage/RCS TAPBACK reaction delivered as text (e.g. 'Laughed at "Q140 sent..."', 'Removed a
// laugh from "..."') or an emoji/punctuation-only body. These are NOT replies — the parser must ignore them silently.
function isReaction(t){
  var x=String(t||"").replace(/\s+/g," ").trim();
  if(!x) return true;                                                   // empty
  if(!/[a-z0-9]/i.test(x)) return true;                                 // emoji / punctuation only (a lone reaction glyph)
  if(/^(laughed at|emphasi[sz]ed|questioned|reacted)\b/i.test(x)) return true;          // distinctive tapback verbs
  if(/^removed (a|an) [a-z ]+ from\b/i.test(x)) return true;                            // reaction removals ("Removed a laugh from ...")
  if(/["“”'‘’]/.test(x) && /^(loved|liked|disliked)\b/i.test(x)) return true;           // ambiguous verbs: require the quoted reference
  return false;
}
function cleanVictorFact(s){
  var t=String(s||"").replace(/\s+/g," ").trim();
  var m=t.match(/^<\s*([\s\S]*?)\s*>$/); if(m) t=m[1].trim();
  if(/^(the answer\s*\/?\s*fact|your answer|the answer|the fact|answer\s*\/\s*fact|answer|fact|placeholder)$/i.test(t)) return "";
  t=t.replace(/^(the answer\s*\/?\s*fact|your answer|the answer|the fact)\b[\s:>\u2014\-]*/i,"").trim();
  return t;
}
// KB-grounded draft. Returns {known:"full"|"partial"|"none", answer}. NEVER fabricates:
// unknown parts -> say we will confirm with the manager and follow up (no guessing).
async function aiDraftAnswer(kb, question, guestName, approvedBank, history){
  const _hasHist=(Array.isArray(history)?history:[]).some(function(m){ return m && m.d==="out"; }); // already messaged this guest?
  const key=process.env.ANTHROPIC_API_KEY; if(!key) return {known:"none", answer:holdingMessage(guestName), noKey:true};
  const kbFacts=((kb&&kb.items)||[]).filter(i=>i&&i.a&&String(i.a).trim()).map(i=>"- "+i.topic+": "+i.a);
  const bankFacts=((approvedBank)||[]).filter(e=>e&&String(e.a||"").trim()).map(e=>"- "+(e.q?("(previously asked: "+String(e.q).slice(0,70)+") "):"")+String(e.a).trim());
  const facts=[...kbFacts, ...bankFacts].join("\n");
  let _learn="";
  try{ const _corr=(await getCorrections()).slice(-8).map(c=>'- For "'+c.q+'": do NOT reply like "'+c.bad+'" — the owner corrected it to "'+c.good+'".').join("\n");
       const _rej=(await getRejections()).filter(r=>r&&r.q&&r.reason&&String(r.reason).trim()&&!r.autoRejected&&!/auto-?rejected|no decision within/i.test(String(r.reason))).slice(-8).map(r=>'- For "'+String(r.q).slice(0,120)+'": a past draft was rejected because: '+r.reason+'.').join("\n");
       _learn=(_corr?("LEARNED CORRECTIONS (the owner edited these past drafts — match the corrected version, avoid the rejected phrasing):\n"+_corr+"\n\n"):"")+(_rej?("PAST REJECTIONS (avoid repeating these mistakes):\n"+_rej+"\n\n"):""); }catch(e){ _learn=""; }
  const convo=(Array.isArray(history)?history:[]).filter(m=>m&&m.b).slice(-12).map(m=>(m.d==="out"?"Us (already sent): ":"Guest: ")+String(m.b).replace(/\s+/g," ").trim()).join("\n");
  const first=String(guestName||"").trim().split(/\s+/)[0]||"";
  const hold=holdingMessage(guestName);
  const sys="You are the guest-messaging assistant for Parkside Tepees (glamping tepees at Parkside Resort, Pigeon Forge TN). Your reply may be sent to the guest automatically, so it must be correct and grounded ONLY in known info. "
    +"Use ONLY the KNOWN INFO below. NEVER invent, guess, infer, or substitute a different fact. Keep the reply SHORT.\n"
    +"The KNOWN INFO entries (including previously-approved answers) are REFERENCE FACTS, NOT templates. COMPOSE a fresh reply tailored to exactly what THIS guest asked, pulling only the relevant fact(s). Do NOT paste a whole prior answer that does not match what was asked.\n"
    +"FIRST classify this newest guest message into exactly one intent and set the flags accordingly:\n"
    +"  (a) NO ACTION NEEDED \u2014 the message asks for NOTHING, reports NO problem, and requests NOTHING. This covers BOTH short pleasantries/acknowledgments ('thank you', 'thanks!', 'ok', 'okay', 'k', 'great', 'sounds good', 'perfect', 'got it', 'awesome', 'will do', 'no worries', a lone emoji/thumbs-up) AND longer FRIENDLY / ENTHUSIASTIC / CONVERSATIONAL statements and booking chit-chat that contain NO question, NO complaint, and NO actionable request \u2014 e.g. 'Hello! My husband and I are bringing the kids for their first trip to Tennessee \uD83E\uDD73', 'We\u2019re so excited to stay with you!', 'Can\u2019t wait, see you soon', 'Just booked, looking forward to it'. Set needs_response=false. A warm, no-question statement does NOT need a reply \u2014 do NOT send it a holding note and do NOT escalate it.\n"
    +"  (b) QUESTION or REQUEST \u2014 it asks something or wants us to do/confirm something. Set needs_response=true and answer per the KNOWN INFO rules below.\n"
    +"  (c) COMPLAINT or ACTIONABLE STATEMENT that needs action even though it may NOT be phrased as a question and may have NO question mark \u2014 e.g. 'the tepee is leaking', 'the AC isn't working', 'there are bugs', 'we're running late', 'we need to cancel', 'we're checking out early', 'the code didn't work'. Set needs_response=true. Do NOT ignore a message just because it is a statement rather than a question.\n"
    +"COMPLAINT DETECTION: set complaint=true if the guest reports a problem or is upset \u2014 e.g. something broken/leaking/dirty, bugs/pests, bad smell, a safety issue, or asks for a refund, credit, compensation, or to leave early. Otherwise complaint=false. When complaint=true be empathetic: apologize for the trouble and say a manager will follow up; do NOT say 'great question' and do NOT use a cheerful emoji.\n"
    +"CONSERVATIVE RULE: set needs_response=true only when there is a genuine QUESTION, a COMPLAINT, or an ACTIONABLE request/statement (b or c). If you are genuinely UNSURE whether a message is asking a question, prefer needs_response=true. BUT a clearly friendly/positive/excited statement with NO question mark and NO problem or request is NOT ambiguous \u2014 set needs_response=false (no reply, no holding, no escalation). Escalate real needs; never friendly chit-chat or booking excitement.\n"
    +"First decide how much of the guest's message the KNOWN INFO answers: 'full' (every part), 'partial' (some parts), or 'none'.\n"
    +"Match the question word to the right fact: 'where'->a location/place/address; 'when'/'what time'->a time; 'how'->a process; 'what'/'which'->the specific item. If the specific thing asked is NOT in KNOWN INFO, treat that part as UNKNOWN (do not substitute a different fact).\n"
    +"Format: keep the reply to 1-3 short sentences plus a brief friendly closing. No padding, no over-explaining.\n"
    +"GREETING RULE (important): open with a greeting ONLY on genuine FIRST contact. If there is CONVERSATION SO FAR below \u2014 i.e. we have already been messaging this guest \u2014 do NOT re-greet; answer directly (you may use their first name naturally). A bare 'Hi there!' is ONLY for a true first contact with an unknown name; NEVER say 'Hi there' when we have already been talking with this guest.\n"
    +"FIRST CONTACT: if there is no CONVERSATION SO FAR (the guest's first message to us), keep it especially brief \u2014 a short greeting plus only what's needed; no long paragraph.\n"
    +"NEVER include a phone number, email address, or external link, and never say 'call us', 'text us', or 'email us'. The channel BLOCKS messages that contain contact info, so they fail to send. Keep everything inside this message thread.\n"
    +"- full: answer every part using ONLY KNOWN INFO.\n"
    +"- partial: answer the part(s) you DO know from KNOWN INFO; for the unknown part(s) say you'll check with your manager and follow up shortly \u2014 NEVER guess it.\n"
    +"- none: do NOT attempt an answer. If complaint=true, briefly apologize for the trouble and say a manager will follow up shortly (no 'great question', no smiley). Otherwise use this exact warm holding message: \""+hold+"\"\n"
    +"You may be shown CONVERSATION SO FAR: earlier messages from this guest and replies WE already sent. Use it to understand what is being asked (pronouns, follow-ups) and do NOT repeat info we already gave. Still answer ONLY from KNOWN INFO.\n"
    +"Reply with ONLY a JSON object: {\"needs_response\":true|false, \"complaint\":true|false, \"known\":\"full\"|\"partial\"|\"none\", \"answer\":\"...\"}. 'answer' is always the full message text (ignored when needs_response is false).\n\n"
    +_learn
    +"KNOWN INFO:\n"+(facts||"(none saved yet)");
  const userMsg=(first?("Guest first name: "+first+"\n"):"")+(convo?("CONVERSATION SO FAR (oldest first):\n"+convo+"\n\n"):"")+"Newest guest message (reply to THIS): "+String(question);
  try{ const r=await fetch("https://api.anthropic.com/v1/messages",{method:"POST",headers:{"x-api-key":key,"anthropic-version":"2023-06-01","content-type":"application/json"},body:JSON.stringify({model:"claude-haiku-4-5-20251001",max_tokens:350,temperature:0.2,system:sys,messages:[{role:"user",content:userMsg}]})});
    const j=await r.json(); if(!r.ok) return {known:"none", answer:holdingMessage(guestName), error:JSON.stringify(j).slice(0,200)};
    let text=((j.content&&j.content[0]&&j.content[0].text)||"").trim();
    try{ const m=text.match(/\{[\s\S]*\}/); const o=JSON.parse(m?m[0]:text); const known=(o.known==="full"||o.known==="partial")?o.known:"none"; const needs_response=(o.needs_response===false)?false:true; const complaint=(o.complaint===true); let answer=tidyQuotes(scrubContact(String(o.answer||"").trim())); if(!answer) answer=holdingMessage(guestName, complaint, _hasHist); else if(_hasHist && (known==="full"||known==="partial")) answer=stripLeadGreeting(answer); return {known, answer, needs_response, complaint}; }
    catch{ return {known:"none", answer:holdingMessage(guestName)}; }
  }catch(e){ return {known:"none", answer:holdingMessage(guestName), error:String(e.message||e)}; }
}
// Learning stores: corrections (owner edited a draft) and rejections (with optional reason).
let _memCorrections=[];
async function appendCorrection(question, badDraft, goodAnswer){
  try{ const rec={q:String(question||"").slice(0,200), bad:String(badDraft||"").replace(/\s+/g," ").trim().slice(0,600), good:String(goodAnswer||"").replace(/\s+/g," ").trim().slice(0,600), ts:new Date().toISOString()};
    if(!rec.bad||!rec.good||rec.bad===rec.good) return;
    const arr=(redis?(await redis.get("parkside:kb_corrections")):_memCorrections)||[]; arr.push(rec); const t=arr.slice(-200);
    if(redis) await redis.set("parkside:kb_corrections",t); else _memCorrections=t; }catch(e){}
}
async function getCorrections(){ try{ return (redis?(await redis.get("parkside:kb_corrections")):_memCorrections)||[]; }catch(e){ return []; } }
async function getRejections(){ try{ return (redis?(await redis.get("parkside:kb_rejected")):_memRejected)||[]; }catch(e){ return []; } }
// Reject page: asks WHY (optional) so the assistant can learn from the rejection.
function rejectPageHtml(it, token){
  const action='/api/app?action=approve&id='+encodeURIComponent(it.id)+'&decision=no&token='+encodeURIComponent(token||'');
  const chip=t=>'<button type="button" onclick="document.getElementById(\'rr\').value=this.textContent" style="background:#1f2c3b;color:#cfe0f0;border:1px solid #2c3e52;border-radius:999px;padding:7px 12px;font-size:13px;margin:4px 6px 0 0;cursor:pointer">'+t+'</button>';
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Reject &amp; tell me why</title></head>'
    +'<body style="font-family:-apple-system,Arial,Helvetica,sans-serif;background:#0f1720;color:#e7eef6;margin:0;padding:16px"><div style="max-width:560px;margin:0 auto">'
    +'<h1 style="font-size:20px;margin:6px 0 12px 0">Reject this reply</h1>'
    +'<div style="background:#16212e;border:1px solid #26354a;border-radius:10px;padding:12px 14px;margin:12px 0">'
    +'<div style="color:#9fb0c0;font-size:12px;margin-bottom:4px">Guest asked</div><div style="font-size:15px">'+escHtml(it.question)+'</div>'
    +(it.proposed?'<div style="color:#9fb0c0;font-size:12px;margin:10px 0 4px">Draft being rejected</div><div style="font-size:14px;color:#f0b8b8;white-space:pre-wrap">'+escHtml(it.proposed)+'</div>':'')+'</div>'
    +'<form method="POST" action="'+action+'">'
    +'<label style="color:#9fb0c0;font-size:12px">Why are you rejecting it? <span style="color:#64748b">(optional — helps it learn)</span></label>'
    +'<textarea id="rr" name="reason" placeholder="e.g. wrong info, wrong tone, made something up, too long…" style="width:100%;min-height:110px;font-size:16px;padding:12px;border-radius:10px;border:1px solid #26354a;background:#0c141d;color:#e7eef6;box-sizing:border-box;margin-top:6px"></textarea>'
    +'<div style="margin-top:8px">'+chip("Wrong info")+chip("Made something up")+chip("Wrong tone")+chip("Too long")+chip("Off-topic")+chip("Not allowed")+'</div>'
    +'<button type="submit" style="width:100%;margin-top:14px;background:#dc2626;color:#fff;border:none;border-radius:10px;padding:15px;font-size:17px;font-weight:700">Reject &amp; save reason</button>'
    +'</form><p style="color:#64748b;font-size:12px;margin-top:10px">Nothing is sent to the guest. Your reason is used to improve future drafts. (Ref '+escHtml(it.id)+')</p>'
    +'</div></body></html>';
}
// Decide a queued approval item: YES -> send to guest + learn into KB; NO -> reject.
async function decideApproval(id, decision, overrideAnswer, reason){
  if(!id) return {ok:false, error:"no id"};
  const list=await getApprovals(); const it=list.find(x=>x.id===id);
  if(!it) return {ok:false, error:"item not found: "+id};
  if(it.status!=="pending") return {ok:false, error:"already "+it.status, item:it};
  const st=await getState(); const enabled=!!st.messaging_enabled;
  if(decision==="yes"||decision==="approve"){
    const isOverride=!!(overrideAnswer&&overrideAnswer.trim());
    let answer=(isOverride?overrideAnswer.trim():"")||it.proposed||"";
    if(!answer) return {ok:false, error:"no answer to send (proposed was empty — supply an answer)"};
    if(/^\s*(q\s*\d+|y|yes|n|no|ok|okay|send|approve|approved|reject|skip)\s*$/i.test(answer)) return {ok:false, error:"refused: that looks like a command, not a guest reply — nothing was sent"};
    answer=scrubContact(answer);
    if(!answer || !answer.trim()) return {ok:false, error:"reply was only contact info (phone/email) which the channel blocks - nothing to send"};
    const guestSend=await sendGuestReply(enabled, {threadId:it.thread_id, bookingId:it.booking_id}, answer);
    // LEARN only a REAL answer: an owner-typed answer (override) OR an approved known answer.
    // NEVER learn a holding/escalation message (it.escalate && not overridden).
    const shouldLearn = isOverride || !it.escalate;
    let bankSize=null;
    if(shouldLearn){
      // Route the learned Q->A to the pending-facts review queue instead of writing it
      // straight into the live KB — a human approves it before it is used in messaging.
      try{ await addPendingFact({ q:it.question, a:answer, source:"approved_reply" }); }catch(e){}
    }
    // LEARN FROM THE EDIT: owner changed the proposed reply -> store (bad draft, good sent) so future drafts avoid the mistake.
    let learnedEdit=false;
    try{ if(isOverride && it.proposed && answer && String(answer).trim()!==String(it.proposed).trim()){ await appendCorrection(it.question, it.proposed, answer); learnedEdit=true; } }catch(e){}
    it.status="approved"; it.answer=answer; it.decidedAt=new Date().toISOString();
    await setApprovals(list);
    return {ok:true, decision:"approved", id, guestSend, sent:guestSend.sent===true, learned:shouldLearn, learnedEdit, approvedBankSize:bankSize};
  }
  const _reason=reason?String(reason).slice(0,500):"";
  it.status="rejected"; it.decidedAt=new Date().toISOString(); it.rejectReason=_reason; await setApprovals(list);
  try{ const rk=(redis?(await redis.get("parkside:kb_rejected")):_memRejected)||[];
    rk.push({id:it.id, q:it.question, draft:it.proposed||"", reason:_reason, source:it.source||null, ts:new Date().toISOString()});
    const trimmed=rk.slice(-500); if(redis) await redis.set("parkside:kb_rejected", trimmed); else _memRejected=trimmed; }catch(e){}
  return {ok:true, decision:"rejected", id, reason:_reason};
}

// --- SMS approval labels (Q1, Q2 ...) + revise-from-text ---
function smsLabelFor(list, item){
  if(item && item.smsLabel) return item.smsLabel;
  const used=new Set((list||[]).filter(x=>(x.status==="pending"||x.status==="escalated")&&x.smsLabel).map(x=>parseInt(String(x.smsLabel).replace(/\D/g,""),10)).filter(n=>n>0));
  let n=1; while(used.has(n)) n++; return "Q"+n;
}
// Ever-CLIMBING Q# labels (Gavin wants the numbers to pile up, never reuse). Persistent
// Redis counter; seeded once above any existing labels; falls back to max-in-list + 1.
async function nextSmsLabel(){
  try{ if(redis){
      let n=await redis.incr("parkside:sms_seq");
      if(n===1){ let mx=0; try{ const list=await getApprovals(); for(const it of (list||[])){ const k=parseInt(String(it&&it.smsLabel||"").replace(/\D/g,""),10); if(isFinite(k)&&k>mx) mx=k; } }catch(e){}
        if(mx>=1){ n=mx+1; try{ await redis.set("parkside:sms_seq", n); }catch(e){} } }
      if(isFinite(n)&&n>0) return "Q"+n;
  } }catch(e){}
  try{ const list=await getApprovals(); let mx=0; for(const it of (list||[])){ const k=parseInt(String(it&&it.smsLabel||"").replace(/\D/g,""),10); if(isFinite(k)&&k>mx) mx=k; } return "Q"+(mx+1); }
  catch(e){ return "Q"+String(Date.now()).slice(-5); }
}
function mkSmsCode(){ return (Math.random().toString(36).slice(2,8)+Math.random().toString(36).slice(2,5)); }
function findByCode(list, code){ code=String(code||"").trim(); if(!code) return null; const m=(list||[]).filter(x=>x.smsCode===code); return m.length?m[m.length-1]:null; }
function findByLabel(list, label){
  const num=parseInt(String(label||"").replace(/\D/g,""),10); if(!num) return null;
  const pend=(list||[]).filter(x=>(x.status==="pending"||x.status==="escalated")&&x.smsLabel&&parseInt(String(x.smsLabel).replace(/\D/g,""),10)===num);
  if(pend.length) return pend[pend.length-1];
  const any=(list||[]).filter(x=>x.smsLabel&&parseInt(String(x.smsLabel).replace(/\D/g,""),10)===num);
  return any.length?any[any.length-1]:null;
}
// Owner texted a correction for a pending item: fold the new info into the KB, re-draft, record the correction, re-stage.
// item: does a composed reply look like the generic "checking with my manager" HOLDING note? Used to guarantee
// a fact-supply never comes back as a holding.
function isHoldingLike(text){ const t=String(text||"").toLowerCase(); return /check(ing)?\s+with\s+(my\s+)?manager|get(ting)?\s+my\s+manager\s+involved|follow up with you shortly|get right back to you shortly|will follow up (with you )?shortly|check with (my )?manager/.test(t); }
// item: deterministic guest reply built straight from the manager's fact — a guaranteed real answer if the model fails.
function directReplyFromFact(guestName, fact, hasHistory){
  const f=String(guestName||"").trim().split(/\s+/)[0];
  var fx=tidyQuotes(scrubContact(String(fact||"").trim())); if(!fx) return "";
  var body=fx.charAt(0).toUpperCase()+fx.slice(1); if(!/[.!?]$/.test(body)) body+=".";
  var hi = hasHistory ? "" : (f?("Hi "+f+"! "):"Hi there! ");
  return (hi+body+" Let me know if there’s anything else I can help with!").trim();
}
// item: FOCUSED composer — always answers the ORIGINAL question USING the manager's supplied fact. Unlike the
// general aiDraftAnswer classifier (which can decide known=none and punt to the holding), this never punts.
async function composeReplyFromFact(question, fact, guestName, history){
  const key=process.env.ANTHROPIC_API_KEY; if(!key) return "";
  const first=String(guestName||"").trim().split(/\s+/)[0]||"";
  const hasHist=(Array.isArray(history)?history:[]).some(function(m){ return m && m.d==="out"; });
  const sys="You write ONE short guest-facing reply for Parkside Tepees (glamping tepees). A manager has ALREADY supplied the answer/fact to the guest's question below. Compose a warm, natural reply that ANSWERS the question using ONLY that fact. Do NOT invent extra details. Do NOT include a phone number, email, or link, and never say 'call/text/email us'. "
    + (hasHist ? "This is an ONGOING conversation, so do NOT open with a greeting like 'Hi there'. " : "")
    + "Keep it to 1-2 sentences plus a brief friendly closing. Reply with ONLY the message text — no JSON, no quotes, no preamble. NEVER say you are checking with a manager or will follow up — the manager already answered, so give the answer now.";
  const userMsg="Guest's original question: "+String(question||"").slice(0,600)+"\nManager's supplied fact/answer (use this to answer): "+String(fact||"").slice(0,900)+(first?("\nGuest first name: "+first):"");
  try{ let _sig=undefined; try{ if(typeof AbortSignal!=="undefined"&&AbortSignal.timeout) _sig=AbortSignal.timeout(9000); }catch(e){} const r=await fetch("https://api.anthropic.com/v1/messages",{method:"POST",signal:_sig,headers:{"x-api-key":key,"anthropic-version":"2023-06-01","content-type":"application/json"},body:JSON.stringify({model:"claude-haiku-4-5-20251001",max_tokens:250,temperature:0.3,system:sys,messages:[{role:"user",content:userMsg}]})});
    const j=await r.json(); if(!r.ok) return "";
    let text=((j.content&&j.content[0]&&j.content[0].text)||"").trim();
    text=tidyQuotes(scrubContact(text)); if(hasHist) text=stripLeadGreeting(text);
    return String(text||"").trim();
  }catch(e){ return ""; }
}
async function reviseFromSms(req, item, extraInfo){
  extraInfo=String(extraInfo||"").trim();
  // SINGLE-RESOLUTION LOCK: never re-draft / re-open a Q that anyone already resolved (approved, rejected, or
  // closed because the front desk answered the guest directly). Protects the reservations fact-supply path too.
  try{ const _l=await getApprovals(); const _cur=_l.find(x=>x&&x.id===item.id); if(_cur && _cur.status && _cur.status!=="pending" && _cur.status!=="escalated") return {proposed:_cur.answer||_cur.proposed||"", known:"full", alreadyHandled:true, status:_cur.status}; }catch(e){}
  // Compose the guest reply FROM the supplied fact with a FOCUSED composer (NOT the general classifier, which
  // could decide known=none and punt to the "checking with my manager" holding). Answer the ORIGINAL question
  // (firstQuestion) so later pleasantry follow-ups in the thread cannot derail it. Nothing is sent to the guest
  // here — the item is re-staged pending; the send happens only on approval.
  let proposed="", known="full";
  let _history=[]; try{ _history=await getThreadLog(item.thread_id, item.booking_id); }catch(e){}
  const _q=item.firstQuestion||item.question||"";
  try{ proposed=await composeReplyFromFact(_q, extraInfo, item.guest_name, _history); }catch(e){}
  // ROBUSTNESS: if the model returned nothing OR something holding-like, build a deterministic reply straight from
  // the fact. reviseFromSms must NEVER return the holding note as the "answer".
  if(!proposed || isHoldingLike(proposed)){ const _hasHist=(_history||[]).some(function(m){ return m && m.d==="out"; }); proposed=directReplyFromFact(item.guest_name, extraInfo, _hasHist); }
  if(!proposed) return {proposed:"", known:"full", failed:true};
  const list=await getApprovals(); const it=list.find(x=>x.id===item.id);
  if(it){ const _now=new Date().toISOString(); it.proposed=proposed; it.status="pending"; it.escalate=false; it.factFromVictor=extraInfo; it.revisedAt=_now; it.ts=_now; it.primaryNotifiedAt=_now; await setApprovals(list); } // (note: do NOT reset escalatedTo2/backupAskSent — that re-armed the flood)
  return {proposed, known};
}

// ===== Resort geofence (on-site detection for Victor) =====
// Default center = midpoint of office (1110 Rocky Creek Way) and tepees (204 Big Sky Way); radius covers the property.
// Named zones, most-specific FIRST; a point is classified to the first zone it falls inside, else 'off'.
// 'resort' is the loose catch-all covering the whole property. Coords: office=1110 Rocky Creek Way,
// tepees=204 Big Sky Way, maintenance=960 Little Cove Rd. Radii are first-pass — tune from real pins.
const ZONES_DEFAULT=[
  { name:'office',      lat:35.76582,   lon:-83.57381,   radius_m:60 },
  { name:'tepees',      lat:35.7711455, lon:-83.5737728, radius_m:140 },
  { name:'maintenance', lat:35.7652343, lon:-83.5715715, radius_m:70 },
  { name:'resort',      lat:35.7678,    lon:-83.5730,    radius_m:800 }
];
function etDate(iso){ try{ return new Date(iso).toLocaleDateString('en-CA',{timeZone:'America/New_York'}); }catch(e){ return new Date().toLocaleDateString('en-CA',{timeZone:'America/New_York'}); } }
// Weekday (0=Sun..6=Sat) in America/New_York for a given iso (or now). Used to gate the
// daily verification-call reminder to Wed-Sat only (Sun/Mon/Tue are not monitored).
function etWeekday(iso){ try{ var d=iso?new Date(iso):new Date(); var wd=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',weekday:'short'}).format(d); return {Sun:0,Mon:1,Tue:2,Wed:3,Thu:4,Fri:5,Sat:6}[wd]; }catch(e){ return new Date().getUTCDay(); } }
function etHour(iso){ try{ var d=iso?new Date(iso):new Date(); var h=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour:'numeric',hour12:false}).format(d); return parseInt(h,10)%24; }catch(e){ return new Date().getUTCHours(); } }
// Current YYYY-MM in America/New_York (month key for cleans/refunds tallies).
function etMonth(iso){ return etDate(iso||new Date().toISOString()).slice(0,7); }
async function getZones(){ try{ if(redis){ const z=await redis.get('parkside:zones'); if(Array.isArray(z)&&z.length) return z.map(x=>({name:String(x.name||'zone'),lat:Number(x.lat),lon:Number(x.lon),radius_m:Number(x.radius_m)})).filter(x=>isFinite(x.lat)&&isFinite(x.lon)&&x.radius_m>0); } }catch(e){} return ZONES_DEFAULT; }
function haversineM(lat1,lon1,lat2,lon2){ const R=6371000, r=x=>x*Math.PI/180; const dLat=r(lat2-lat1), dLon=r(lon2-lon1); const a=Math.sin(dLat/2)**2 + Math.cos(r(lat1))*Math.cos(r(lat2))*Math.sin(dLon/2)**2; return 2*R*Math.asin(Math.min(1,Math.sqrt(a))); }
function classifyPoint(lat,lon,zones){ let best=null; for(const z of zones){ const d=haversineM(lat,lon,z.lat,z.lon); if(d<=z.radius_m){ return {zone:z.name, dist_m:Math.round(d)}; } if(best===null||d<best.dist_m){ best={zone:'off', dist_m:Math.round(d), nearest:z.name}; } } return best||{zone:'off', dist_m:null}; }
// ===== Per-tepee dwell (MANUAL REVIEW ONLY — NEVER fed into grading/scoring) =====
// Each tepee is a street address on Big Sky Way (Parkside Resort, Pigeon Forge/Sevierville TN). The lat/lon
// below are FIRST-PASS: georeferenced from the property satellite map (100 ft scale bar + a single anchor at
// 204's engine coord, north-up). They are APPROXIMATE and marked confirmed:false — Gavin should confirm or
// replace the exact coords (editable via ?action=tepees_config POST, or by tapping each tepee). Radii are
// NON-OVERLAPPING: the closest two tepees are ~67 m apart, so a 20 m radius maps a fix to at most one tepee.
// IMPORTANT: this per-tepee assignment is shown for Gavin's manual eyeballing ONLY. It is NEVER passed to
// scoreDay()/gpsZoneSummary(); noisy GPS (occasional stray points) must never move a grade or score.
const TEPEES_DEFAULT=[
  { name:'Arrowhead',       addr:'223 Big Sky Way', lat:35.772644, lon:-83.574093, radius_m:20, confirmed:false },
  { name:'Soaring Dreams',  addr:'217 Big Sky Way', lat:35.771981, lon:-83.574220, radius_m:20, confirmed:false },
  { name:'Mustang Manor',   addr:'213 Big Sky Way', lat:35.771385, lon:-83.574404, radius_m:20, confirmed:false },
  { name:'Flyin\' Horse',   addr:'209 Big Sky Way', lat:35.770752, lon:-83.574516, radius_m:20, confirmed:false },
  { name:'Bear Claw',       addr:'205 Big Sky Way', lat:35.770095, lon:-83.574640, radius_m:20, confirmed:false },
  { name:'Flyin\' Free',    addr:'220 Big Sky Way', lat:35.771555, lon:-83.572450, radius_m:20, confirmed:false },
  { name:'Sunset Stampede', addr:'216 Big Sky Way', lat:35.771671, lon:-83.573178, radius_m:20, confirmed:false },
  { name:'Buffalo Run',     addr:'212 Big Sky Way', lat:35.771102, lon:-83.573455, radius_m:20, confirmed:false },
  { name:'Scarlet Antlers', addr:'208 Big Sky Way', lat:35.770448, lon:-83.573418, radius_m:20, confirmed:false },
  { name:'Cub House',       addr:'204 Big Sky Way', lat:35.769821, lon:-83.573354, radius_m:20, confirmed:false }
];
async function getTepees(){ try{ if(redis){ let t=await redis.get('parkside:tepees'); if(typeof t==='string'){ try{ t=JSON.parse(t); }catch(e){} } if(Array.isArray(t)&&t.length){ const m=t.map(function(x){ return {name:String(x.name||'tepee'),addr:String(x.addr||''),lat:Number(x.lat),lon:Number(x.lon),radius_m:Number(x.radius_m)||20,confirmed:!!x.confirmed}; }).filter(function(x){ return isFinite(x.lat)&&isFinite(x.lon)&&x.radius_m>0; }); if(m.length) return m; } } }catch(e){} return TEPEES_DEFAULT; }
// Assign a fix to the NEAREST tepee CENTER (Voronoi) so every fix maps to exactly one unit even near a
// boundary — then accept it only if within a sane cap (max of that tepee's geofence radius or 25 m) so a
// fix well off-property is not force-assigned. DISPLAY/manual-review only; never used for scoring.
function nearestTepee(lat,lon,tepees){ let best=null; for(const t of tepees){ const d=haversineM(lat,lon,t.lat,t.lon); if(best===null||d<best.d){ best={name:t.name, addr:t.addr, d:d, cap:Math.max(Number(t.radius_m)||20,25)}; } } if(best && best.d<=best.cap) return {name:best.name, addr:best.addr, dist_m:Math.round(best.d)}; return null; }
// Per-tepee DISPLAY radius (m) = clamp(0.5 x nearest-neighbour distance, 6, 18). Half the neighbour distance
// guarantees adjacent circles at most TOUCH (never overlap) while staying as large as readable. DISPLAY ONLY.
function tepeeDisplayRadius(tepees){ const MIN=6, MAX=18; const out=[]; for(let i=0;i<tepees.length;i++){ let nn=Infinity; for(let j=0;j<tepees.length;j++){ if(j===i) continue; const d=haversineM(tepees[i].lat,tepees[i].lon,tepees[j].lat,tepees[j].lon); if(d<nn) nn=d; } const r=isFinite(nn)?0.5*nn:MAX; out.push({ nn_m:(isFinite(nn)?Math.round(nn):null), display_radius_m:Math.round(Math.max(MIN,Math.min(MAX,r))) }); } return out; }
// Minutes spent inside each tepee for a day. SEPARATE from gpsZoneSummary; RESULT IS NEVER USED FOR SCORING.
async function tepeeDwellSummary(device, date){
  let pts=[]; try{ if(redis){ const raw=await redis.lrange("parkside:gpsday:"+device+":"+date,0,-1); pts=(raw||[]).map(function(x){ try{ return typeof x==="string"?JSON.parse(x):x; }catch(e){ return null; } }).filter(Boolean); } }catch(e){}
  const tepees=await getTepees(); const byName={}; tepees.forEach(function(t){ byName[t.name]=0; });
  let assigned=0, total=0, hits=0;
  for(let i=0;i<pts.length-1;i++){ const a=pts[i], b=pts[i+1];
    let gap=(new Date(b.t)-new Date(a.t))/60000; if(!isFinite(gap)||gap<0) gap=0; if(gap>10) gap=10; total+=gap;
    if(!(isFinite(a.lat)&&isFinite(a.lon))) continue;
    const nt=nearestTepee(a.lat,a.lon,tepees); if(nt){ byName[nt.name]=(byName[nt.name]||0)+gap; assigned+=gap; hits++; } }
  const dr=tepeeDisplayRadius(tepees);
  const list=tepees.map(function(t,i){ return { name:t.name, addr:t.addr, lat:t.lat, lon:t.lon, radius_m:t.radius_m, display_radius_m:dr[i].display_radius_m, nn_m:dr[i].nn_m, confirmed:!!t.confirmed, min:Math.round(byName[t.name]||0) }; }).sort(function(x,y){ return y.min-x.min; });
  return { points:pts.length, total_min:Math.round(total), assigned_min:Math.round(assigned), hits:hits, tepees:list, all_confirmed:(tepees.length>0 && tepees.every(function(t){ return t.confirmed; })) };
}
// ===== WebWork (Victor screen/activity) + daily scorecard =====
const WW_BASE="https://api.webwork-tracker.com/api/v2";
function wwWorkspace(){ return String(process.env.WEBWORK_WORKSPACE_ID||"506630"); }
function wwVictor(){ return String(process.env.WEBWORK_VICTOR_USER_ID||"416481"); }
async function wwFetch(path, qs){
  const tok=String(process.env.WEBWORK_TOKEN||""); if(!tok) return {ok:false, error:"WEBWORK_TOKEN not set"};
  try{ const r=await fetch(WW_BASE+path+(qs?("?"+qs):""), {headers:{Authorization:"Bearer "+tok, Accept:"application/json"}});
    const j=await r.json().catch(function(){return null;}); return {ok:r.ok, status:r.status, json:j}; }
  catch(e){ return {ok:false, error:String(e.message||e)}; }
}
async function wwHoursForDate(date){
  const r=await wwFetch("/reports/tracked-hours","workspace_id="+wwWorkspace()+"&user_id="+wwVictor()+"&start_date="+date+"&end_date="+date);
  if(!r.ok || !r.json || !r.json.data) return {available:false, error:r.error||("status "+r.status)};
  const d=r.json.data; const tot=(d.total&&d.total.total_minutes)||0; const inact=(d.total&&d.total.inactive_minutes)||0;
  const active=Math.max(0, tot-inact);
  return { available:true, tracked_min:tot, inactive_min:inact, active_min:active, active_pct:(tot>0?Math.round(100*active/tot):0), hours:Number((tot/60).toFixed(2)) };
}
// WebWork screen activity (daily-timeline) — the "what was on his computer" signal behind screenshots.
// The public WebWork v2 API exposes the activity timeline + activity level (mouse/keyboard/scroll),
// NOT raw screenshot images. Path is env-overridable (WEBWORK_TIMELINE_PATH) so a real screenshots
// endpoint can be swapped in later with no redeploy.
async function wwScreenActivity(date){
  const path=String(process.env.WEBWORK_TIMELINE_PATH||"/reports/daily-timeline");
  const r=await wwFetch(path,"workspace_id="+wwWorkspace()+"&user_id="+wwVictor()+"&date="+date);
  if(!r.ok || !r.json) return {available:false, error:r.error||("status "+r.status)};
  const d=(r.json.data!=null)?r.json.data:r.json;
  let entries=[];
  const looksEntry=function(e){ return e&&typeof e==="object"&&(e.start||e.start_time||e.activity_description!=null||e.activity_level!=null||e.tracking_method!=null||e.memo!=null); };
  const dig=function(x){ if(!x) return; if(Array.isArray(x)){ for(const e of x){ if(looksEntry(e)) entries.push(e); else dig(e); } return; } if(typeof x==="object"){ if(Array.isArray(x.time_entries)) dig(x.time_entries); if(Array.isArray(x.entries)) dig(x.entries); if(Array.isArray(x.timeline)) dig(x.timeline); if(Array.isArray(x.users)) for(const u of x.users) dig(u.time_entries||u.entries||u.timeline||[]); for(const k in x){ if(Array.isArray(x[k])) dig(x[k]); } } };
  try{ dig(d); }catch(e){}
  if(!entries.length) return {available:false, empty:true, note:"no timeline entries returned", raw_status:r.status};
  const memo=function(e){ return String(e.activity_description||e.memo||e.description||"").trim(); };
  const taskOf=function(e){ const t=e.task; return String((t&&(t.name||t.title))||e.task_name||"").trim(); };
  const projOf=function(e){ const pr=e.project; return String((pr&&(pr.name||pr.title))||e.project_name||"").trim(); };
  const lvl=function(e){ const v=Number(e.activity_level!=null?e.activity_level:(e.activity!=null?e.activity:NaN)); return isFinite(v)?v:null; };
  const mins=function(e){ const m=Number(e.duration_minutes!=null?e.duration_minutes:(e.total_minutes!=null?e.total_minutes:(e.minutes!=null?e.minutes:NaN))); if(isFinite(m)) return m; const a=e.start||e.start_time, b=e.end||e.end_time; if(a&&b){ const g=(new Date(b)-new Date(a))/60000; return (isFinite(g)&&g>0)?g:0; } return 0; };
  let totMin=0, lvlSum=0, lvlN=0; const desc={}, methods={};
  // item MW-2: track the most recent activity segment so the My Work "WebWork working" light can
  // go green only on RECENT activity (mirrors the location-working live logic). last_ts = latest
  // segment end (any tracked segment); last_active_ts = latest segment that had nonzero activity.
  let lastTs=null, lastActiveTs=null;
  const segEnd=function(e){ const b=e.end||e.end_time||null; if(b) return b; const a=e.start||e.start_time||null; if(a){ const m=mins(e); return m?new Date(new Date(a).getTime()+m*60000).toISOString():a; } return null; };
  for(const e of entries){ const mm=mins(e); totMin+=mm; const L=lvl(e); if(L!=null){ lvlSum+=L; lvlN++; } const label=memo(e); if(label) desc[label]=(desc[label]||0)+mm; /* description only, not project/task which go stale e.g. minibar */ const meth=String(e.tracking_method||e.method||"").trim(); if(meth) methods[meth]=(methods[meth]||0)+1;
    const eend=segEnd(e); if(eend){ if(!lastTs || new Date(eend)>new Date(lastTs)) lastTs=eend; if(L!=null && L>0){ if(!lastActiveTs || new Date(eend)>new Date(lastActiveTs)) lastActiveTs=eend; } } }
  const top=Object.keys(desc).sort(function(a,b){return desc[b]-desc[a];}).slice(0,8).map(function(k){ return {label:k.slice(0,80), min:Math.round(desc[k])}; });
  return { available:true, entries:entries.length, active_min:Math.round(totMin), avg_activity_pct:(lvlN?Math.round(lvlSum/lvlN):null), top_activities:top, methods:Object.keys(methods), last_ts:lastTs, last_active_ts:lastActiveTs };
}
async function wwAppsWebsites(date){
  // The apps & websites (URLs) Victor actually used + minutes + activity level. PRIMARY "is he active / what was he on"
  // signal for verification — NOT project labels. Endpoint path env-overridable (WEBWORK_APPS_PATH).
  const path=String(process.env.WEBWORK_APPS_PATH||"/reports/apps-websites");
  const r=await wwFetch(path,"workspace_id="+wwWorkspace()+"&users="+wwVictor()+"&start_date="+date+"&end_date="+date+"&per_page=200");
  if(!r.ok || !r.json) return {available:false, error:r.error||("status "+r.status)};
  const d=(r.json.data!=null)?r.json.data:r.json;
  let rows=[];
  const looksRow=function(e){ return e&&typeof e==="object" && (e.app_website!=null||e.url!=null||e.website!=null||e.domain!=null||e.host!=null||e.app!=null||e.application!=null||e.name!=null||e.title!=null); };
  const dig=function(x){ if(!x) return; if(Array.isArray(x)){ for(const e of x){ if(looksRow(e)) rows.push(e); else dig(e); } return; } if(typeof x==="object"){ for(const k in x){ if(Array.isArray(x[k])) dig(x[k]); else if(x[k]&&typeof x[k]==="object") dig(x[k]); } } };
  try{ dig(d); }catch(e){}
  const vid=String(wwVictor());
  const mine=rows.filter(function(e){ const uid=String(e.user_id!=null?e.user_id:((e.user&&(e.user.id||e.user.user_id))||(e.member&&(e.member.id||e.member.user_id))||"")); return !uid || uid===vid; });
  const use=mine.length?mine:rows;
  const labelOf=function(e){ return String(e.app_website||e.url||e.website||e.domain||e.host||e.app||e.application||e.name||e.title||"").trim(); };
  const minOf=function(e){ const m=Number(e.duration_minutes!=null?e.duration_minutes:(e.total_minutes!=null?e.total_minutes:(e.tracked_minutes!=null?e.tracked_minutes:(e.minutes!=null?e.minutes:(e.duration!=null?e.duration/60:NaN))))); return isFinite(m)?m:0; };
  const lvlOf=function(e){ const v=Number(e.activity_level!=null?e.activity_level:(e.activity!=null?e.activity:NaN)); return isFinite(v)?v:null; };
  const agg={}; let tot=0, lvlSum=0, lvlN=0;
  for(const e of use){ const lab=labelOf(e); const mm=minOf(e); if(lab) agg[lab]=(agg[lab]||0)+mm; tot+=mm; const L=lvlOf(e); if(L!=null){ lvlSum+=L; lvlN++; } }
  const top=Object.keys(agg).sort(function(a,b){return agg[b]-agg[a];}).slice(0,10).map(function(k){ return {label:k.slice(0,120), min:Math.round(agg[k])}; });
  if(!top.length) return {available:false, empty:true, note:"no apps/website rows returned", raw_status:r.status};
  return { available:true, rows:use.length, total_min:Math.round(tot), avg_activity_pct:(lvlN?Math.round(lvlSum/lvlN):null), top:top };
}
async function gpsZoneSummary(device, date){
  let pts=[]; try{ if(redis){ const raw=await redis.lrange("parkside:gpsday:"+device+":"+date,0,-1); pts=(raw||[]).map(function(x){ try{ return typeof x==="string"?JSON.parse(x):x; }catch(e){ return null; } }).filter(Boolean); } }catch(e){}
  const byZone={office:0,tepees:0,maintenance:0,resort:0,off:0}; let total=0;
  for(let i=0;i<pts.length-1;i++){ const a=pts[i], b=pts[i+1];
    let gap=(new Date(b.t)-new Date(a.t))/60000; if(!isFinite(gap)||gap<0) gap=0; if(gap>10) gap=10;
    const z=(a.zone && (a.zone in byZone))?a.zone:"off"; byZone[z]+=gap; total+=gap; }
  const round=function(o){ const r={}; for(const k in o) r[k]=Math.round(o[k]); return r; };
  return { points:pts.length, total_min:Math.round(total), on_site_min:Math.round(total-byZone.off), byZoneMin:round(byZone), first:pts.length?pts[0].t:null, last:pts.length?pts[pts.length-1].t:null, last_zone:pts.length?(pts[pts.length-1].zone||"off"):null };
}
// Claude ranks Victor's self-report against the objective data. Returns + stores {truth_score, ...}.
async function scoreDay(date, device){
  const key=process.env.ANTHROPIC_API_KEY; if(!key) return {error:"ANTHROPIC_API_KEY not set"};
  const hours=await wwHoursForDate(date); const zones=await gpsZoneSummary(device, date);
  const screen=await wwScreenActivity(date); const apps=await wwAppsWebsites(date); let todoDoc=""; try{ todoDoc=((await getTodo())||{}).text||""; }catch(e){}
  let gradeExamples=[]; try{ gradeExamples=await getGavinGradeExamples(8); }catch(e){}
  let report=""; try{ if(redis){ report=(await redis.get("parkside:report:"+date))||""; } }catch(e){}
  if(!report || !String(report).trim()) return {error:"no self-report on file for "+date+" (nothing to score against)"};
  let turn=null; try{ const tv=await getTurnovers(date,1,true); turn=tv[date]; }catch(e){}
  // item MW-12: RECORDED time off must NEVER lower Victor's grade. Full day = do not grade at all;
  // partial hours = carve the recorded off-minutes out of the on-duty window so inactivity during
  // his recorded time off is not counted against him. (Normal working-time scoring is unchanged.)
  let timeOff={fullDay:false,hours:0}; try{ timeOff=await timeOffForDate(date); }catch(e){}
  if(timeOff && timeOff.fullDay){ try{ if(redis) await redis.del("parkside:score:"+date); }catch(e){} return {date, skipped:"full day off (recorded in his time-off tab) \u2014 not graded", timeoff:timeOff}; }
  const offMin=(timeOff&&timeOff.hours>0)?Math.round(timeOff.hours*60):0;
  const _od=onDutyActivePct(hours.active_min, hours.inactive_min, offMin);
  const hoursDesc = !hours.available ? "no WebWork data"
    : (offMin>0
        ? (hours.hours+"h tracked with "+timeOff.hours+"h RECORDED OFF \u2192 judge over ~"+Number((_od.adjTracked/60).toFixed(2))+"h on-duty; "+_od.pct+"% active over on-duty time ("+hours.active_min+" active min of "+_od.adjTracked+" on-duty min, after removing "+offMin+" recorded-off min)")
        : (hours.hours+"h tracked, "+hours.active_pct+"% active ("+hours.active_min+" active min of "+hours.tracked_min+")"));
  const dataBlock=
    "OBJECTIVE DATA for "+date+" (America/New_York):\n"+
    "- WebWork hours: "+hoursDesc+"\n"+
    "- WebWork screen activity: "+(screen.available?(screen.entries+" segment(s), "+screen.active_min+" active min"+(screen.avg_activity_pct!=null?(", "+screen.avg_activity_pct+"% avg activity"):"")+(screen.top_activities&&screen.top_activities.length?("; top: "+screen.top_activities.map(function(a){return a.label+" ("+a.min+"m)";}).join(", ")):"")):"no WebWork screen-activity data")+"\n"+
    "- WebWork apps & websites (what he was ON — URLs/apps + activity): "+(apps.available?(apps.top.map(function(a){return a.label+" ("+a.min+"m)";}).join(", ")+(apps.avg_activity_pct!=null?("; "+apps.avg_activity_pct+"% activity"):"")):"no apps/website data")+"\n"+
    "- GPS on-site time: "+zones.on_site_min+" min on resort grounds of "+zones.total_min+" min tracked\n"+
    "- GPS time per zone (minutes): office "+zones.byZoneMin.office+", tepees "+zones.byZoneMin.tepees+", maintenance "+zones.byZoneMin.maintenance+", elsewhere-on-resort "+zones.byZoneMin.resort+", off-site "+zones.byZoneMin.off+"\n"+
    "- First ping "+(zones.first||"n/a")+", last ping "+(zones.last||"n/a")+"\n"+
    (turn? ("- Bookings/cleaning ground-truth: "+turn.occupied.length+" of "+UNITS.length+" units occupied that night; "+turn.checkouts.length+" checkout(s) that day \u2192 "+turn.checkouts.length+" unit(s) required a turnover clean"+(turn.checkouts.length?(" ("+turn.checkouts.join(", ")+")"):"")+"; "+turn.arrivals.length+" arrival(s)"+(turn.arrivals.length?(" ("+turn.arrivals.join(", ")+")"):"")+".\n") : "");
  const sys="You audit an employee's (Victor, maintenance/operations at Parkside Tepees resort) daily self-report against objective tracking data. "+
    "Compare what he SAID he did to the GPS zone time and WebWork computer-activity data. "+
    "Judge how well his claims match the data. Be fair: absence of GPS/WebWork data for a task does not always mean he lied (e.g., outdoor work with phone in pocket still shows GPS on-site; computer tasks show WebWork activity). "+
    "Do NOT nitpick that every minute was active \u2014 short breaks, phone calls, and idle gaps are normal and fine. Judge productivity at an hour-to-two-hour granularity: was the time GENERALLY productive and not wasted (the real concern is an employee on his phone all day, not one who took a call). "+
    "Cross-check any CLEANING claims against the bookings/cleaning ground-truth: a unit needs a full turnover clean when a guest checked OUT that day. If he claims he cleaned MORE units than there were checkouts, flag the excess as unverified in discrepancies; markedly fewer cleanings than checkouts may mean turnovers were skipped. "+
    "RECORDED TIME OFF IS APPROVED AND AUTHORITATIVE: when the data says Victor logged time off (a number of hours, or a full day), you MUST exclude that time from all productivity expectations \u2014 judge him ONLY over his on-duty hours and NEVER lower any score because of inactivity, absence, or low activity that falls within his recorded time off. "+"If a to-do list is provided, treat work that advances items on it as valued/expected; he should stay roughly (not exactly) aligned to it, and maintenance is expected even if unlisted. Use the WebWork data PRIMARILY to verify he was actually ACTIVE and what he genuinely used (apps & websites / URLs + activity rate) to corroborate desk/admin/computer claims; do NOT treat WebWork project/task names as proof of what he worked on (those labels can be stale). "+
    "Return ONLY a JSON object: {\"truth_score\":0-100, \"productivity_score\":0-100, \"hours_worked\":<number, from the data>, \"matches\":[\"...\"], \"discrepancies\":[\"...\"], \"summary\":\"1-2 sentences\"}. "+
    "truth_score = how well his report is corroborated by the data (100 = fully consistent, low = claims contradicted by the data). "+
    "productivity_score = how productive and on-list the day was given the to-do list, GPS on-site time, and screen activity (100 = clearly productive on valued work, low = little evidence of productive/valued work). "+
    "If example gradings from the owner (Gavin) are provided below, your productivity_score MUST predict the grade GAVIN would give \u2014 learn his standard from those examples; his grading is the ground truth.";
  const todoBlock=(todoDoc&&todoDoc.trim())?("\nVICTOR'S CURRENT TO-DO LIST (living doc \u2014 admin + general tasks; maintenance expected, may be unlisted):\n"+String(todoDoc).slice(0,3000)+"\n"):"";
  let exBlock="";
  if(gradeExamples&&gradeExamples.length){ exBlock="\nHOW GAVIN (owner) GRADED PAST DAYS FOR PRODUCTIVITY (0-100) \u2014 match his standard:\n"+gradeExamples.map(function(e){ const sn=e.snap||{}; return "- "+e.date+" \u2192 "+Math.round(e.grade)+"/100"+(e.note?(" ("+String(e.note).slice(0,140)+")"):"")+". Data: "+(sn.hours_summary||"")+"; "+(sn.gps_summary||"")+"; "+(sn.screen_summary||"")+"."; }).join("\n")+"\n"; }
  const offBlock=(offMin>0)?("\nRECORDED TIME OFF (authoritative): Victor logged "+timeOff.hours+" hour(s) off on "+date+". Carve this out of all productivity expectations \u2014 evaluate ONLY his on-duty hours and do not count any inactivity during the recorded time off against him.\n"):"";
  const userMsg=dataBlock+offBlock+todoBlock+exBlock+"\nVICTOR'S SELF-REPORT:\n"+String(report).slice(0,4000);
  try{
    const r=await fetch("https://api.anthropic.com/v1/messages",{method:"POST",headers:{"x-api-key":key,"anthropic-version":"2023-06-01","content-type":"application/json"},
      body:JSON.stringify({model:"claude-haiku-4-5-20251001",max_tokens:700,temperature:0,system:sys,messages:[{role:"user",content:userMsg}]})});
    const j=await r.json(); if(!r.ok) return {error:"Anthropic error", detail:JSON.stringify(j).slice(0,200)};
    let text=((j.content&&j.content[0]&&j.content[0].text)||"").trim(); let o=null;
    try{ const m=text.match(/\{[\s\S]*\}/); o=JSON.parse(m?m[0]:text); }catch(e){ o=null; }
    if(!o) return {error:"could not parse AI response", raw:text.slice(0,300)};
    const out={ date, scored_at:new Date().toISOString(), truth_score:Number(o.truth_score), productivity_score:Number(o.productivity_score!=null?o.productivity_score:o.truth_score), hours_worked:Number(o.hours_worked!=null?o.hours_worked:(hours.hours||0)),
      matches:Array.isArray(o.matches)?o.matches:[], discrepancies:Array.isArray(o.discrepancies)?o.discrepancies:[], summary:String(o.summary||""),
      data:{hours, zones, screen, todo_present:!!(todoDoc&&todoDoc.trim()), timeoff:{hours:(timeOff&&timeOff.hours)||0, off_min:offMin, full_day:!!(timeOff&&timeOff.fullDay)}} };
    try{ if(redis) await redis.set("parkside:score:"+date, out); }catch(e){}
    return out;
  }catch(e){ return {error:"request failed: "+String(e.message||e)}; }
}
module.exports=async(req,res)=>{
  try{
    res.setHeader("Cache-Control","no-store, max-age=0, must-revalidate"); res.setHeader("CDN-Cache-Control","no-store"); res.setHeader("Vercel-CDN-Cache-Control","no-store");
    const action=(req.query&&req.query.action)||""; const today=new Date().toISOString().slice(0,10), days=365;
    // ===== Victor GPS ingest (Traccar Client / OsmAnd protocol) =====
    // Public but secret-gated. Traccar hits /gps/<secret>?id=..&lat=..&lon=..&timestamp=..&speed=..&batt=..&accuracy=..
    // (rewritten to action=gps). The app's Tracking toggle = clock in/out; OFF sends nothing.
    if(action==="gps"){
      const need=String(process.env.GPS_INGEST_SECRET||"");
      if(!need){ res.status(503); return res.end("gps secret not configured"); }
      if(String((req.query&&req.query.secret)||"")!==need){ res.status(401); return res.end("unauthorized"); }
      // Read params from BOTH the URL query AND the POST body (Traccar iOS puts them in the body).
      const q=req.query||{};
      let bd=req.body; if(typeof bd==="string"){ try{ bd=JSON.parse(bd); }catch(e){ try{ bd=Object.fromEntries(new URLSearchParams(bd)); }catch(e2){ bd={}; } } } if(!bd||typeof bd!=="object") bd={};
      const g=function(){ for(let i=0;i<arguments.length;i++){ const k=arguments[i]; if(q[k]!=null&&q[k]!=="") return q[k]; if(bd[k]!=null&&bd[k]!=="") return bd[k]; } return undefined; };
      const lat=parseFloat(g("lat","latitude")), lon=parseFloat(g("lon","longitude"));
      if(!isFinite(lat)||!isFinite(lon)){ res.status(400); return res.end("missing coords"); }
      const device=String(g("id","deviceid","device_id")||"victor").toLowerCase().replace(/[^A-Za-z0-9_\-]/g,"").slice(0,40)||"victor";
      let when=new Date(); const _ts=g("timestamp"); const tsRaw=_ts!=null?Number(_ts):NaN;
      if(isFinite(tsRaw)){ const d=new Date(tsRaw>1e12?tsRaw:tsRaw*1000); if(isFinite(d.getTime())) when=d; }
      const num=v=>(v!=null&&v!==""&&isFinite(Number(v)))?Number(v):null;
      const pt={ t:when.toISOString(), lat, lon, spd:num(g("speed")), batt:num(g("batt")!=null?g("batt"):g("battery")), acc:num(g("accuracy")) };
      try{ const zones=await getZones(); const c=classifyPoint(lat,lon,zones); pt.zone=c.zone; pt.dist_m=c.dist_m; pt.on_site=(c.zone!=="off"); if(c.nearest) pt.nearest=c.nearest; }catch(e){}
      try{ if(redis){ const pj=JSON.stringify(pt);
        const dstr=etDate(pt.t); const dk="parkside:gpsday:"+device+":"+dstr;
        await redis.rpush(dk, pj); await redis.expire(dk, 60*60*24*120);            // full day history, kept ~120 days
        try{ await redis.zadd("parkside:gpsdays:"+device, {score:Number(dstr.replace(/-/g,"")), member:dstr}); }catch(e){} // index of days that have data
        const k="parkside:gps:"+device; await redis.rpush(k, pj); await redis.ltrim(k,-500,-1);  // rolling recent for live view
        await redis.set("parkside:gps_last:"+device, pt); } }
      catch(e){ res.status(500); return res.end("db error"); }
      res.status(200); return res.end("ok");
    }
    // Read GPS state (password-gated): latest point, count, recent trail, and the ingest URL to paste into Traccar.
    // Verify the 2nd ("Gavin") login. Returns ok if the Gavin password matches.
    if(action==="gavin_auth"){
      const need=String(process.env.GAVIN_PASSWORD||"");
      if(!need) return res.status(200).json({ok:false, unset:true});
      return res.status(200).json({ok: (req.headers["x-gavin-password"]||"")===need});
    }
    if(action==="gps_status"){
      if((req.headers["x-gavin-password"]||"")!==(process.env.GAVIN_PASSWORD||"__x")) return res.status(401).json({error:"unauthorized (Gavin login)"});
      const device=String((req.query&&req.query.id)||"victor").toLowerCase().replace(/[^A-Za-z0-9_\-]/g,"").slice(0,40)||"victor";
      const date=String((req.query&&req.query.date)||"").trim();
      const sec=String(process.env.GPS_INGEST_SECRET||""); const origin=process.env.APP_PUBLIC_ORIGIN||"https://project-jvyw3.vercel.app";
      const _parse=raw=>(raw||[]).map(x=>{ try{ return typeof x==="string"?JSON.parse(x):x; }catch{ return null; } }).filter(Boolean);
      let last=null, count=0, trail=[], lastSeen=null, stale=false, liveToday=null;
      try{ if(redis){
        if(date){ const dk="parkside:gpsday:"+device+":"+date; trail=_parse(await redis.lrange(dk,0,-1)); count=trail.length; last=trail.length?trail[trail.length-1]:null; }
        else {
          // "Today (live)": show ONLY today's (ET) points — never spill yesterday's fixes into the live view.
          liveToday=etDate(new Date().toISOString());
          const dk="parkside:gpsday:"+device+":"+liveToday;
          trail=_parse(await redis.lrange(dk,0,-1)); count=trail.length;
          last = trail.length ? trail[trail.length-1] : null;      // live "current" = today's last fix only
          lastSeen = await redis.get("parkside:gps_last:"+device);  // most-recent fix on ANY day (for "last seen")
          stale = !!(lastSeen && !last);                            // no fix yet today
        }
      } }catch(e){}
      const zones=await getZones();
      const zoneNow=(last&&last.zone)?last.zone:null;
      // item MON-1: per-zone MINUTES (time), not a raw ping count. Sum the gap between consecutive
      // fixes (capped at 10 min, mirroring gpsZoneSummary) into the zone of the earlier fix, so the
      // Gavin Location card shows real minutes per zone instead of a point count mislabeled 'm'.
      const byZone={}; for(let i=0;i<trail.length-1;i++){ const a=trail[i], b=trail[i+1]; if(!a||!b) continue;
        let gap=(new Date(b.t)-new Date(a.t))/60000; if(!isFinite(gap)||gap<0) gap=0; if(gap>10) gap=10;
        const z=(a&&a.zone)?a.zone:'off'; byZone[z]=(byZone[z]||0)+gap; }
      for(const k in byZone) byZone[k]=Math.round(byZone[k]);
      return res.status(200).json({ device, date:date||null, today:liveToday, configured:!!sec, ingestUrl: sec?(origin+"/gps/"+sec):null, count, last, lastSeen, stale, zone:zoneNow, on_site:(zoneNow&&zoneNow!=='off'), zones, trailByZone:byZone, trail });
    }
    // Get/set the named zones (password-gated). POST {zones:[{name,lat,lon,radius_m},...]} to replace them.
    // List days that have GPS history for a device (Gavin-gated) — powers the date scrubber.
    if(action==="gps_days"){
      if((req.headers["x-gavin-password"]||"")!==(process.env.GAVIN_PASSWORD||"__x")) return res.status(401).json({error:"unauthorized"});
      const device=String((req.query&&req.query.id)||"victor").toLowerCase().replace(/[^A-Za-z0-9_\-]/g,"").slice(0,40)||"victor";
      let days=[]; try{ if(redis){ const z=await redis.zrange("parkside:gpsdays:"+device,0,-1); days=(z||[]).slice().reverse(); } }catch(e){}
      return res.status(200).json({device, days});
    }
    // List devices that have reported GPS (Gavin-gated) so the UI can auto-discover the phone.
    if(action==="gps_devices"){
      if((req.headers["x-gavin-password"]||"")!==(process.env.GAVIN_PASSWORD||"__x")) return res.status(401).json({error:"unauthorized"});
      let devices=[];
      try{ if(redis){ const keys=await redis.keys("parkside:gps_last:*");
        for(const k of (keys||[])){ const dev=k.replace("parkside:gps_last:",""); const last=await redis.get(k); let count=0; try{ count=await redis.llen("parkside:gps:"+dev); }catch(e){}
          devices.push({device:dev, count, lastZone:(last&&last.zone)||null, lastTs:(last&&last.t)||null}); } } }catch(e){}
      devices.sort(function(a,b){ return String(b.lastTs||"").localeCompare(String(a.lastTs||"")); });
      return res.status(200).json({devices});
    }
    // ===== Rental agreement status (Gavin-only): which upcoming bookings have a SIGNED lease vs still NEEDED =====
    // Single OwnerRez call: GET /v2/bookings?...&include_agreements=true. A booking whose agreements[] has a dated
    // signed lease = "completed"; empty = "needed". Drives the dashboard "Rental agreement completed / needed" card.
    if(action==="agreements_status"){
      // Reception-facing (main dashboard): low-sensitivity operational data. Accept the main app password OR the Gavin password.
      if((req.headers["x-app-password"]||"")!==(process.env.APP_PASSWORD||"__y") && (req.headers["x-gavin-password"]||"")!==(process.env.GAVIN_PASSWORD||"__x")) return res.status(401).json({error:"unauthorized"});
      if(!orBasicHeader() && !(await orOauthHeader())) return res.status(503).json({error:"OwnerRez API credentials not set (need OWNERREZ_API_USER + OWNERREZ_API_TOKEN)"});
      const etToday=etDate(new Date().toISOString());
      if(!(req.query&&req.query.nocache) && redis){ try{ const c=await redis.get("parkside:agreements"); if(c&&c.today===etToday&&(Date.now()-c.ts)<180000) return res.status(200).json(c.payload); }catch(e){} }
      const pids=UNITS.map(function(u){return u.orp;}).join(",");
      const nameOf={}; for(const u of UNITS) nameOf[u.orp]=u.name;
      const url="https://api.ownerrez.com/v2/bookings?property_ids="+pids+"&from="+etToday+"&status=active&include_agreements=true&include_guest=true&limit=100";
      let r,data;
      try{ r=await orFetch(url,{prefer:"basic",headers:{Accept:"application/json"}}); data=await r.json(); }
      catch(e){ return res.status(502).json({error:"OwnerRez fetch failed: "+String(e.message||e)}); }
      if(!r||!r.ok) return res.status((r&&r.status)||502).json({error:"OwnerRez bookings "+((r&&r.status)||"error"), detail:JSON.stringify(data).slice(0,300)});
      const items=(data.items||[]).filter(function(b){return !b.is_block && (b.type==="booking"||!b.type);}).map(function(b){
        const ags=Array.isArray(b.agreements)?b.agreements:[];
        const signed=ags.find(function(a){return a&&a.date;});
        return { bookingId:b.id, guest_id:b.guest_id||null, unit:nameOf[b.property_id]||(b.property&&b.property.name)||("#"+b.property_id), property_id:b.property_id,
          guest: b.guest? ((b.guest.first_name||"")+" "+(b.guest.last_name||"")).trim() : "",
          arrival:(b.arrival||"").slice(0,10), departure:(b.departure||"").slice(0,10), listing_site:b.listing_site||"",
          agreementSigned: !!signed, agreementName: signed?String(signed.name||""):"", agreementDate: signed?String(signed.date||"").slice(0,10):"", agreementUrl: signed?String(signed.url||""):"", contactInfo:false };
      }).sort(function(a,b){return (a.arrival||"").localeCompare(b.arrival||"");});
      // Contact-info heuristic: a guest only gets a mailing ADDRESS on file after completing the portal "Confirm Contact Info" step
      // (OTAs like Airbnb pass a name/email but no street address), so address-on-file ~= contact info completed.
      const _gc=items.slice(0,60);
      await Promise.all(_gc.map(async function(it){
        if(!it.guest_id) return;
        try{ const gr=await orFetch("https://api.ownerrez.com/v2/guests/"+it.guest_id,{prefer:"basic",headers:{Accept:"application/json"}});
          if(gr&&gr.ok){ const g=await gr.json(); const addrs=Array.isArray(g.addresses)?g.addresses:[];
            it.contactInfo=addrs.some(function(a){return a && (String(a.street||a.street1||a.address1||"").trim()||String(a.city||"").trim());}); }
        }catch(e){}
      }));
      const needed=items.filter(function(x){return !x.agreementSigned;}).length;
      const contactNeeded=items.filter(function(x){return !x.contactInfo;}).length;
      const payload={ today:etToday, total:items.length, completed:items.length-needed, needed:needed, contactOnFile:items.length-contactNeeded, contactNeeded:contactNeeded, bookings:items };
      if(redis){ try{ await redis.set("parkside:agreements",{today:etToday,ts:Date.now(),payload}); }catch(e){} }
      return res.status(200).json(payload);
    }
    // ===== Cleaning ground-truth (Gavin-only): actual checkouts/day = units that truly needed a turnover clean =====
    if(action==="cleaning_get"){
      if((req.headers["x-gavin-password"]||"")!==(process.env.GAVIN_PASSWORD||"__x")) return res.status(401).json({error:"unauthorized (Gavin login)"});
      const etToday=etDate(new Date().toISOString());
      const start=new Date(etToday+"T00:00:00Z"); start.setUTCDate(start.getUTCDate()-9); const from=start.toISOString().slice(0,10);
      let tv={}; try{ tv=await getTurnovers(from,12,true); }catch(e){ return res.status(200).json({error:"booking feed unavailable",days:[]}); }
      const rows=Object.keys(tv).sort().map(function(ds){ const t=tv[ds]; return { date:ds, occupied:t.occupied.length, cleaningsNeeded:t.checkouts.length, checkoutUnits:t.checkouts, arrivals:t.arrivals.length, isToday:ds===etToday, future:ds>etToday }; });
      return res.status(200).json({ today:etToday, unitCount:UNITS.length, days:rows });
    }
    // ===== Fraud Alert (Gavin-only): payout-account integrity + receipt reconciliation =====
    // Storage blob parkside:fraud = { accounts:{channel:{...}}, checks:[], receipts:[], alerts:[] }
    if(action==="fraud_get"){
      if((req.headers["x-gavin-password"]||"")!==(process.env.GAVIN_PASSWORD||"__x")) return res.status(401).json({error:"unauthorized (Gavin login)"});
      let blob=null; try{ if(redis) blob=await redis.get("parkside:fraud"); }catch(e){}
      blob=blob||{accounts:{},checks:[],receipts:[],alerts:[]};
      return res.status(200).json(blob);
    }
    if(action==="fraud_post"){
      if((req.headers["x-gavin-password"]||"")!==(process.env.GAVIN_PASSWORD||"__x")) return res.status(401).json({error:"unauthorized (Gavin login)"});
      let body=req.body; if(typeof body==="string"){ try{ body=JSON.parse(body); }catch(e){ try{ body=Object.fromEntries(new URLSearchParams(body)); }catch(e2){ body={}; } } } if(!body||typeof body!=="object") body={};
      let blob=null; try{ if(redis) blob=await redis.get("parkside:fraud"); }catch(e){}
      blob=blob||{accounts:{},checks:[],receipts:[],alerts:[]};
      blob.accounts=blob.accounts||{}; blob.checks=blob.checks||[]; blob.receipts=blob.receipts||[]; blob.alerts=blob.alerts||[];
      const now=new Date().toISOString(); const op=String(body.op||"");
      const uid=()=>Date.now().toString(36)+Math.random().toString(36).slice(2,7);
      const norm=v=>String(v==null?"":v).trim();
      const digits=v=>norm(v).replace(/[^0-9]/g,"");
      if(op==="setAccount"){
        const ch=norm(body.channel).toLowerCase(); if(!ch) return res.status(400).json({error:"channel required"});
        blob.accounts[ch]={ channel:ch, label:norm(body.label)||ch, bank:norm(body.bank), last4:digits(body.last4).slice(-4), routing_last4:digits(body.routing_last4).slice(-4), note:norm(body.note), updated:now };
      } else if(op==="removeAccount"){
        delete blob.accounts[norm(body.channel).toLowerCase()];
      } else if(op==="runCheck"){
        const ch=norm(body.channel).toLowerCase(); const base=blob.accounts[ch];
        const obsBank=norm(body.observed_bank), obsLast4=digits(body.observed_last4).slice(-4);
        let status="ok", reasons=[];
        if(!base){ status="no-baseline"; reasons.push("No baseline set for this channel"); }
        else {
          if(base.last4 && obsLast4 && base.last4!==obsLast4){ status="MISMATCH"; reasons.push("Account last4 "+obsLast4+" != baseline "+base.last4); }
          if(base.bank && obsBank && base.bank.toLowerCase()!==obsBank.toLowerCase()){ status="MISMATCH"; reasons.push('Bank "'+obsBank+'" != baseline "'+base.bank+'"'); }
          if(status==="ok") reasons.push("Matches baseline "+(base.bank?base.bank+" ":"")+(base.last4?"*"+base.last4:""));
        }
        const rec={ id:uid(), channel:ch, observed_bank:obsBank, observed_last4:obsLast4, status, reasons, at:now };
        blob.checks.unshift(rec); blob.checks=blob.checks.slice(0,300);
        if(status==="MISMATCH"){ blob.alerts.unshift({ id:uid(), kind:"payout-mismatch", channel:ch, msg:"["+ch.toUpperCase()+"] "+reasons.join("; "), at:now, resolved:false }); blob.alerts=blob.alerts.slice(0,300); }
      } else if(op==="addReceipt"){
        blob.receipts.unshift({ id:uid(), source:norm(body.source)||"manual", vendor:norm(body.vendor), amount:norm(body.amount), date:norm(body.date)||now.slice(0,10), ref:norm(body.ref), category:norm(body.category), note:norm(body.note), media:norm(body.media), status:norm(body.status)||"unreviewed", at:now });
        blob.receipts=blob.receipts.slice(0,2000);
      } else if(op==="setReceiptStatus"){
        const id=norm(body.id), st=norm(body.status); blob.receipts=blob.receipts.map(r=>r.id===id?{...r,status:st}:r);
      } else if(op==="deleteReceipt"){
        const id=norm(body.id); blob.receipts=blob.receipts.filter(r=>r.id!==id);
      } else if(op==="resolveAlert"){
        const id=norm(body.id); blob.alerts=blob.alerts.map(a=>a.id===id?{...a,resolved:true,resolvedAt:now}:a);
      } else { return res.status(400).json({error:"unknown op: "+op}); }
      try{ if(redis) await redis.set("parkside:fraud", blob); }catch(e){}
      return res.status(200).json(blob);
    }
    // ===== Victor daily verification-call reminder =====
    // Cron-eligible: emails Victor if he did NOT complete his verification call AND email
    // verification is off — ONLY on monitored days (Wed-Sat, America/New_York). Auth: cron
    // secret OR Gavin password (for manual/diagnostic runs).
    if(action==="verify_reminder"){
      const okAuth=((req.headers["authorization"]||"")==="Bearer "+(process.env.CRON_SECRET||"__x"))
        || ((req.query&&req.query.token)===(process.env.CRON_SECRET||"__y"))
        || ((req.headers["x-gavin-password"]||"")===(process.env.GAVIN_PASSWORD||"__z"));
      if(!okAuth) return res.status(401).json({error:"unauthorized"});
      const out=await runVictorVerifyReminder(new Date().toISOString());
      return res.status(200).json(out);
    }
    // Victor email-verification toggle. GET reads current status (ungated read); POST sets it.
    // POST is Gavin-gated OR app-password (owner action).
    if(action==="victor_verify"){
      if(req.method==="POST"){
        const okAuth=((req.headers["x-gavin-password"]||"")===(process.env.GAVIN_PASSWORD||"__x")) || ((req.headers["x-app-password"]||"")===(process.env.APP_PASSWORD||"__y"));
        if(!okAuth) return res.status(401).json({error:"unauthorized"});
        let b=req.body; if(typeof b==="string"){ try{b=JSON.parse(b);}catch(e){ try{ b=Object.fromEntries(new URLSearchParams(b)); }catch(e2){ b={}; } } } b=b||{};
        let v=null; try{ if(redis) v=await redis.get("parkside:victor_verify"); }catch(e){} v=v||{};
        v.emailEnabled=!!b.emailEnabled; v.updated=new Date().toISOString();
        try{ if(redis) await redis.set("parkside:victor_verify", v); }catch(e){}
        return res.status(200).json({ok:true, ...(await victorVerifyConfig())});
      }
      const date=etDate(new Date().toISOString());
      return res.status(200).json({ ...(await victorVerifyConfig()), calledToday:await victorCalledOn(date), date, weekday:etWeekday(new Date().toISOString()) });
    }
    // ===== Victor portal (Bonus tab): monthly cleans tally =====
    // Victor-accessible (no login), matching the Bonus tab. Keyed parkside:cleans:<YYYY-MM>;
    // auto-resets each month because the month is part of the key.
    if(action==="cleans_get"){
      const month=String((req.query&&req.query.month)||"")||etMonth();
      let rec=null; try{ if(redis) rec=await redis.get("parkside:cleans:"+month); }catch(e){}
      rec=rec||{};
      if(!rec.monday && !rec.other && (rec.count!=null||rec.log)) rec={ other:{count:Number(rec.count||0), log:Array.isArray(rec.log)?rec.log:[]} };
      const mon=rec.monday||{count:0,log:[]}, oth=rec.other||{count:0,log:[]};
      return res.status(200).json({ month,
        monday:{count:Number(mon.count||0), log:(mon.log||[]).slice(-50)},
        other:{count:Number(oth.count||0), log:(oth.log||[]).slice(-50)},
        count:Number(mon.count||0)+Number(oth.count||0) });
    }
    if(action==="cleans_post"){
      let b=req.body; if(typeof b==="string"){ try{b=JSON.parse(b);}catch(e){ try{ b=Object.fromEntries(new URLSearchParams(b)); }catch(e2){ b={}; } } } b=b||{};
      const month=etMonth(); const op=String(b.op||"add");
      const type=(String(b.type||"other")==="monday")?"monday":"other";
      let rec=null; try{ if(redis) rec=await redis.get("parkside:cleans:"+month); }catch(e){}
      rec=rec||{};
      if(!rec.monday && !rec.other && (rec.count!=null||rec.log)) rec={ other:{count:Number(rec.count||0), log:Array.isArray(rec.log)?rec.log:[]} };
      rec.monday=rec.monday||{count:0,log:[]}; rec.other=rec.other||{count:0,log:[]};
      rec.monday.log=rec.monday.log||[]; rec.other.log=rec.other.log||[];
      const bucket=rec[type];
      if(op==="add"){
        const n=Math.max(1, Math.min(50, parseInt(b.n,10)||1));
        const note=String(b.note||"").slice(0,200); const now=new Date().toISOString();
        bucket.count=Number(bucket.count||0)+n;
        bucket.log.push({ id:Date.now().toString(36)+Math.random().toString(36).slice(2,6), n, note, at:now, date:etDate(now) });
        bucket.log=bucket.log.slice(-200);
      } else if(op==="undo"){
        const last=bucket.log.pop(); if(last) bucket.count=Math.max(0, Number(bucket.count||0)-Number(last.n||1));
      } else { return res.status(400).json({error:"unknown op: "+op}); }
      try{ if(redis) await redis.set("parkside:cleans:"+month, rec); }catch(e){}
      return res.status(200).json({ ok:true, month, type,
        monday:{count:Number(rec.monday.count||0), log:rec.monday.log.slice(-50)},
        other:{count:Number(rec.other.count||0), log:rec.other.log.slice(-50)},
        count:Number(rec.monday.count||0)+Number(rec.other.count||0) });
    }
    // ===== Victor portal (Bonus tab): refunds report =====
    // Victor-accessible. Keyed parkside:refunds:<YYYY-MM> (list per month).
    if(action==="refunds_get"){
      const month=String((req.query&&req.query.month)||"")||etMonth();
      let list=null; try{ if(redis) list=await redis.get("parkside:refunds:"+month); }catch(e){}
      list=Array.isArray(list)?list:[];
      const total=list.reduce((a,r)=>a+(Number(r.amount)||0),0);
      return res.status(200).json({ month, count:list.length, total:Math.round(total*100)/100, refunds:list.slice(0,100) });
    }
    if(action==="refunds_post"){
      let b=req.body; if(typeof b==="string"){ try{b=JSON.parse(b);}catch(e){ try{ b=Object.fromEntries(new URLSearchParams(b)); }catch(e2){ b={}; } } } b=b||{};
      const month=etMonth(); const op=String(b.op||"add");
      let list=null; try{ if(redis) list=await redis.get("parkside:refunds:"+month); }catch(e){}
      list=Array.isArray(list)?list:[];
      if(op==="add"){
        const amount=Math.round((parseFloat(b.amount)||0)*100)/100;
        const desc=String(b.desc||b.description||"").slice(0,1000);
        if(!(amount>0) && !desc) return res.status(400).json({error:"need an amount or description"});
        const now=new Date().toISOString();
        list.unshift({ id:Date.now().toString(36)+Math.random().toString(36).slice(2,6), amount, desc, at:now, date:etDate(now) });
        list=list.slice(0,500);
      } else if(op==="delete"){
        const id=String(b.id||""); list=list.filter(r=>String(r.id)!==id);
      } else { return res.status(400).json({error:"unknown op: "+op}); }
      try{ if(redis) await redis.set("parkside:refunds:"+month, list); }catch(e){}
      const total=list.reduce((a,r)=>a+(Number(r.amount)||0),0);
      return res.status(200).json({ ok:true, month, count:list.length, total:Math.round(total*100)/100, refunds:list.slice(0,100) });
    }
    // WebWork API probe (Gavin-gated) — pass ?path=/workspaces etc. Returns raw JSON to validate token + learn shapes.
    if(action==="webwork_raw"){
      if((req.headers["x-gavin-password"]||"")!==(process.env.GAVIN_PASSWORD||"__x")) return res.status(401).json({error:"unauthorized"});
      const tok=String(process.env.WEBWORK_TOKEN||""); if(!tok) return res.status(503).json({error:"WEBWORK_TOKEN not set"});
      const base="https://api.webwork-tracker.com/api/v2";
      const path=String((req.query&&req.query.path)||"/workspaces");
      const qs=String((req.query&&req.query.qs)||"");
      try{ const r=await fetch(base+path+(qs?("?"+qs):""), {headers:{Authorization:"Bearer "+tok, Accept:"application/json"}});
        const t=await r.text(); let j=null; try{ j=JSON.parse(t); }catch(e){}
        return res.status(200).json({status:r.status, url:base+path+(qs?("?"+qs):""), json:j, raw:(j?null:t.slice(0,1500))}); }
      catch(e){ return res.status(200).json({error:String(e.message||e)}); }
    }
    // Connection check (Gavin-gated): is WebWork + Traccar/GPS data ACTUALLY reaching the engine right now?
    if(action==="conn_check"){
      if((req.headers["x-gavin-password"]||"")!==(process.env.GAVIN_PASSWORD||"__x")) return res.status(401).json({error:"unauthorized"});
      const device=String((req.query&&req.query.id)||"victor").toLowerCase().replace(/[^A-Za-z0-9_\-]/g,"").slice(0,40)||"victor";
      const today=etDate(new Date().toISOString()); const yday=etDateAddDays(today,-1);
      // WebWork
      const wwTok=!!String(process.env.WEBWORK_TOKEN||"");
      let hToday=null,hY=null,scr=null;
      try{ hToday=await wwHoursForDate(today); }catch(e){ hToday={available:false,error:String(e&&e.message||e)}; }
      try{ hY=await wwHoursForDate(yday); }catch(e){ hY={available:false,error:String(e&&e.message||e)}; }
      try{ scr=await wwScreenActivity(today); }catch(e){ scr={available:false,error:String(e&&e.message||e)}; }
      // Traccar / GPS
      const sec=String(process.env.GPS_INGEST_SECRET||""); const origin=process.env.APP_PUBLIC_ORIGIN||"https://project-jvyw3.vercel.app";
      let last=null,total=0,ptsToday=0,ptsY=0;
      try{ if(redis){ last=await redis.get("parkside:gps_last:"+device); total=await redis.llen("parkside:gps:"+device);
        ptsToday=((await redis.lrange("parkside:gpsday:"+device+":"+today,0,-1))||[]).length;
        ptsY=((await redis.lrange("parkside:gpsday:"+device+":"+yday,0,-1))||[]).length; } }catch(e){}
      return res.status(200).json({
        today, yday, device,
        webwork:{ token_set:wwTok, workspace:wwWorkspace(), user:wwVictor(),
          hours_today:hToday, hours_yday:hY,
          screen_today:(scr?{available:!!scr.available, entries:scr.entries||0, active_min:scr.active_min||0, error:scr.error||null}:null) },
        gps:{ configured:!!sec, ingestUrl:(sec?(origin+"/gps/"+sec):null), device_expected:device,
          last, total_points:total, points_today:ptsToday, points_yday:ptsY }
      });
    }
    // Daily scorecard: WebWork hours + GPS zone-time + stored report + stored score. (Gavin-gated)
    if(action==="scorecard"){
      if((req.headers["x-gavin-password"]||"")!==(process.env.GAVIN_PASSWORD||"__x")) return res.status(401).json({error:"unauthorized"});
      const date=String((req.query&&req.query.date)||"")||etDate(new Date().toISOString());
      const device=String((req.query&&req.query.id)||"victor").toLowerCase().replace(/[^A-Za-z0-9_\-]/g,"").slice(0,40)||"victor";
      const hours=await wwHoursForDate(date); const zones=await gpsZoneSummary(device,date); const screen=await wwScreenActivity(date); const apps=await wwAppsWebsites(date);
      let report="", score=null, todo=null, grade=null, graded_count=0; try{ if(redis){ report=(await redis.get("parkside:report:"+date))||""; score=await redis.get("parkside:score:"+date); grade=await redis.get("parkside:grade:"+date); const gz=await redis.zrange("parkside:grades_index",0,-1); graded_count=(gz||[]).length; } }catch(e){} try{ todo=await getTodo(); }catch(e){}
      return res.status(200).json({ date, device, hours, zones, screen, apps, report, score, todo, grade, graded_count });
    }
    // Get/set Victor's self-report text for a date. (Gavin-gated)
    if(action==="scorecard_report"){
      if((req.headers["x-gavin-password"]||"")!==(process.env.GAVIN_PASSWORD||"__x")) return res.status(401).json({error:"unauthorized"});
      const date=String((req.query&&req.query.date)||"")||etDate(new Date().toISOString());
      if(req.method==="POST"){ let b=req.body; if(typeof b==="string"){try{b=JSON.parse(b);}catch{b={};}} b=b||{};
        const txt=String(b.report||"").slice(0,8000); try{ if(redis) await redis.set("parkside:report:"+date, txt); }catch(e){}
        return res.status(200).json({ok:true, date, report:txt}); }
      let report=""; try{ if(redis) report=(await redis.get("parkside:report:"+date))||""; }catch(e){}
      return res.status(200).json({ date, report });
    }
    // Run the Claude truth-score for a date (Gavin-gated OR cron secret).
    if(action==="score_day"){
      const okAuth=((req.headers["x-gavin-password"]||"")===(process.env.GAVIN_PASSWORD||"__x")) || ((req.headers["authorization"]||"")==="Bearer "+(process.env.CRON_SECRET||"__y")) || ((req.query&&req.query.token)===(process.env.CRON_SECRET||"__z"));
      if(!okAuth) return res.status(401).json({error:"unauthorized"});
      const date=String((req.query&&req.query.date)||"")||etDate(new Date(Date.now()-86400000).toISOString());
      const device=String((req.query&&req.query.id)||"victor").toLowerCase().replace(/[^A-Za-z0-9_\-]/g,"").slice(0,40)||"victor";
      const out=await scoreDay(date, device); return res.status(200).json(out);
    }
    // WebWork screen-activity (Gavin-gated): what Victor was doing on the computer for a date.
    if(action==="ww_activity"){
      // Victor may read his OWN WebWork activity (My Work panel), as well as Gavin.
      if((req.headers["x-app-password"]||"")!==(process.env.APP_PASSWORD||"__y") && (req.headers["x-gavin-password"]||"")!==(process.env.GAVIN_PASSWORD||"__x")) return res.status(401).json({error:"unauthorized"});
      const date=String((req.query&&req.query.date)||"")||etDate(new Date().toISOString());
      return res.status(200).json(Object.assign(await wwScreenActivity(date), {apps: await wwAppsWebsites(date)}));
    }
    // item MW5 (My Work): today's per-zone TIME (minutes) for the Location working card. Victor + Gavin.
    if(action==="my_location"){
      if((req.headers["x-app-password"]||"")!==(process.env.APP_PASSWORD||"__y") && (req.headers["x-gavin-password"]||"")!==(process.env.GAVIN_PASSWORD||"__x")) return res.status(401).json({error:"unauthorized"});
      const date=String((req.query&&req.query.date)||"")||etDate(new Date().toISOString());
      const device=String((req.query&&req.query.id)||"victor").toLowerCase().replace(/[^A-Za-z0-9_\-]/g,"").slice(0,40)||"victor";
      const z=await gpsZoneSummary(device, date);
      return res.status(200).json({date, device, byZoneMin:(z&&z.byZoneMin)||{}, on_site_min:(z&&z.on_site_min)||0, total_min:(z&&z.total_min)||0, last:(z&&z.last)||null, last_zone:(z&&z.last_zone)||null});
    }
    // ===== Per-tepee dwell (Gavin-only) — WHICH tepee & HOW LONG, for MANUAL review only. =====
    // NOT scoring data: tepeeDwellSummary() is never called by scoreDay(); it only powers the map circles
    // and the manual-review card so Gavin can eyeball which unit Victor was in. GPS noise stays out of grades.
    if(action==="tepee_dwell"){
      if((req.headers["x-gavin-password"]||"")!==(process.env.GAVIN_PASSWORD||"__x")) return res.status(401).json({error:"unauthorized"});
      const device=String((req.query&&req.query.id)||"victor").toLowerCase().replace(/[^A-Za-z0-9_\-]/g,"").slice(0,40)||"victor";
      const date=String((req.query&&req.query.date)||"").trim()||etDate(new Date().toISOString());
      const out=await tepeeDwellSummary(device, date);
      return res.status(200).json(Object.assign({device, date, manual_review_only:true, note:"Manual review only — GPS is noisy; this per-tepee data is NEVER used for grading/scoring."}, out));
    }
    // Editable per-tepee coordinate table (Gavin-only). GET returns the table; POST {tepees:[{name,addr,lat,lon,radius_m,confirmed}]} replaces it.
    if(action==="tepees_config"){
      if((req.headers["x-gavin-password"]||"")!==(process.env.GAVIN_PASSWORD||"__x")) return res.status(401).json({error:"unauthorized"});
      if(req.method==="POST"){ let b=req.body; if(typeof b==="string"){ try{ b=JSON.parse(b); }catch(e){ b={}; } } b=b||{};
        if(b.reset===true){ try{ if(redis) await redis.del("parkside:tepees"); }catch(e){} return res.status(200).json({ok:true, reset:true, tepees:TEPEES_DEFAULT, source:"default"}); }
        const arr=Array.isArray(b.tepees)?b.tepees:[];
        const clean=arr.map(function(x){ return {name:String(x.name||'tepee').slice(0,40), addr:String(x.addr||'').slice(0,60), lat:Number(x.lat), lon:Number(x.lon), radius_m:Number(x.radius_m)||20, confirmed:!!x.confirmed}; }).filter(function(x){ return isFinite(x.lat)&&isFinite(x.lon)&&x.radius_m>0; });
        if(!clean.length) return res.status(400).json({error:"no valid tepees in payload"});
        if(!redis) return res.status(503).json({error:"storage not configured (redis unavailable) — cannot persist"});
        let verified=null;
        try{ await redis.set("parkside:tepees", JSON.stringify(clean));
          // Read back immediately and confirm it persisted (surfaces silent write failures to the client).
          let rb=await redis.get("parkside:tepees"); if(typeof rb==="string"){ try{ rb=JSON.parse(rb); }catch(e){} }
          verified=Array.isArray(rb)?rb.length:null;
        }catch(e){ return res.status(500).json({error:"db error: "+String(e&&e.message||e)}); }
        return res.status(200).json({ok:true, count:clean.length, persisted:(verified===clean.length), verified_count:verified, tepees:clean}); }
      const tepees=await getTepees(); const isDefault=(tepees===TEPEES_DEFAULT);
      const _dr=tepeeDisplayRadius(tepees);
      const tepeesOut=tepees.map(function(t,i){ return Object.assign({}, t, {display_radius_m:_dr[i].display_radius_m, nn_m:_dr[i].nn_m}); });
      return res.status(200).json({tepees:tepeesOut, source:isDefault?"default":"custom", approximate:isDefault, note:isDefault?"Approximate — georeferenced from the satellite map; confirm/replace each tepee's exact coord.":"Custom coordinates saved by Gavin."});
    }
    // Shared to-do list. Victor-facing like cleans/refunds (panel is the access boundary); tags who edited.
    if(action==="todo_get"){ return res.status(200).json(await getTodo()); }
    // ===== Bonus / incentive comp. bonus_get: Victor-readable (drafts hidden unless Gavin); bonus_save: Gavin-gated. =====
    if(action==="bonus_get"){
      const all=await getBonus(); const gv=(req.headers["x-gavin-password"]||"")===(process.env.GAVIN_PASSWORD||"__x");
      const out={}; for(const k in all){ if(k==="_terms") continue; const e=all[k]; if(gv || !e || e.published!==false) out[k]=e; }
      return res.status(200).json({ terms: bonusTerms(all), data: out, isGavin: gv });
    }
    if(action==="bonus_save"){
      if((req.headers["x-gavin-password"]||"")!==(process.env.GAVIN_PASSWORD||"__x")) return res.status(401).json({error:"unauthorized"});
      let b=req.body; if(typeof b==="string"){try{b=JSON.parse(b);}catch{b={};}} b=b||{};
      const all=await getBonus();
      if(b.terms&&typeof b.terms==="object"){ all._terms=Object.assign({}, all._terms||{}, b.terms); }
      if(b.key){ if(b.entry===null){ delete all[String(b.key)]; } else if(b.entry&&typeof b.entry==="object"){ all[String(b.key)]=b.entry; } }
      await setBonus(all);
      return res.status(200).json({ ok:true, terms: bonusTerms(all) });
    }
    if(action==="todo_post"){
      const gv=(req.headers["x-gavin-password"]||"")===(process.env.GAVIN_PASSWORD||"__x");
      const ap=(req.headers["x-app-password"]||"")===(process.env.APP_PASSWORD||"__y");
      let b=req.body; if(typeof b==="string"){try{b=JSON.parse(b);}catch{b={};}} b=b||{};
      const doc=await setTodo(String(b.text||""), gv?"gavin":(ap?"victor":"panel"));
      return res.status(200).json(Object.assign({ok:true}, doc));
    }
    // Gavin sets the to-do DOCUMENT url (his docX). GET returns url+pulled text; POST {url} saves it.
    if(action==="todo_docx_upload"){
      if((req.headers["x-gavin-password"]||"")!==(process.env.GAVIN_PASSWORD||"__x")) return res.status(401).json({error:"unauthorized"});
      let b=req.body; if(typeof b==="string"){try{b=JSON.parse(b);}catch{b={};}} b=b||{};
      const data=String(b.data||""); if(!data) return res.status(400).json({error:"no file data"});
      let buf; try{ buf=Buffer.from(data.replace(/^data:[^,]*,/,""), "base64"); }catch(e){ return res.status(400).json({error:"bad file encoding"}); }
      if(!buf.length) return res.status(400).json({error:"empty file"});
      let text; try{ text=docxToText(buf); }catch(e){ return res.status(400).json({error:"could not read .docx: "+String(e.message||e)}); }
      if(!text || !text.trim()) return res.status(400).json({error:"no text found in the document"});
      await setTodo(text, "gavin-docx:"+String(b.filename||"").slice(0,60));
      try{ if(redis){ await redis.del("parkside:todo_doc_url"); await redis.del("parkside:todo_doc_cache"); } }catch(e){}
      return res.status(200).json({ok:true, chars:text.length, text:text.slice(0,4000), filename:String(b.filename||"")});
    }
    if(action==="todo_doc"){
      if((req.headers["x-gavin-password"]||"")!==(process.env.GAVIN_PASSWORD||"__x")) return res.status(401).json({error:"unauthorized"});
      if(req.method==="POST"){ let b=req.body; if(typeof b==="string"){try{b=JSON.parse(b);}catch{b={};}} b=b||{};
        const url=String(b.url||"").trim().slice(0,500);
        try{ if(redis){ await redis.set("parkside:todo_doc_url", url); await redis.del("parkside:todo_doc_cache"); } }catch(e){}
        const t=await getTodo(); return res.status(200).json({ok:true, url, text:t.text, chars:(t.text||"").length});
      }
      const url=await getTodoDocUrl(); const t=await getTodo(); return res.status(200).json({url, text:t.text, chars:(t.text||"").length, source:t.source});
    }
    // Daily auto-grade (cron secret OR Gavin). Grades yesterday if data complete; else emails the data-gap alert.
    if(action==="daily_score"){
      const okAuth=((req.headers["x-gavin-password"]||"")===(process.env.GAVIN_PASSWORD||"__x")) || ((req.headers["authorization"]||"")==="Bearer "+(process.env.CRON_SECRET||"__y")) || ((req.query&&req.query.token)===(process.env.CRON_SECRET||"__z"));
      if(!okAuth) return res.status(401).json({error:"unauthorized"});
      return res.status(200).json(await runDailyScore(new Date().toISOString()));
    }
    // Weekly report (Victor-facing, his tab): all daily grades + explanations for a week. ?week=0 this week, 1=last week, or ?start=YYYY-MM-DD (Monday).
    if(action==="weekly_report"){
      const _isGavinWk=((req.headers["x-gavin-password"]||"")===(process.env.GAVIN_PASSWORD||"__x"));
      if(!_isGavinWk){ let _wkHid=false; try{ if(redis) _wkHid=!!(await redis.get("parkside:weekly_hidden")); }catch(e){} if(_wkHid) return res.status(200).json({hidden:true}); }
      let start=String((req.query&&req.query.start)||"").trim();
      if(!/^\d{4}-\d{2}-\d{2}$/.test(start)){ const off=Math.max(0,parseInt((req.query&&req.query.week)||0,10)||0); const today=etDate(new Date().toISOString()); start=weekStartMonday(etDateAddDays(today,-7*off)); }
      const rep=await buildWeeklyReport(start);
      let narrative=null; try{ narrative=await weeklyNarrative(rep,false); }catch(e){}
      return res.status(200).json(Object.assign(rep,{narrative}));
    }
    // Weekly report visibility toggle (Gavin-gated). GET -> {hidden}; POST {hidden} -> set.
if(action==="email_recipients"){
    const _isG=((req.headers["x-gavin-password"]||"")===(process.env.GAVIN_PASSWORD||"__x"));
    if(!_isG) return res.status(403).json({error:"gavin only"});
    const _cfg=await getNotifyConfig();
    if(req.method==="POST"){
      let _b=req.body; if(typeof _b==="string"){ try{ _b=JSON.parse(_b);}catch(e){ _b={}; } }
      const _rec=(_b&&_b.recipients)||{};
      const _clean={};
      for(const it of EMAIL_CATALOG){ const rr=_rec[it.key]||{}; _clean[it.key]={ to:String(rr.to||"").slice(0,400), victor:!!rr.victor, enabled:(rr.enabled!==false) }; }
      await setEmailRecipients(_clean);
      const _out=EMAIL_CATALOG.map(it=>({key:it.key,name:it.name,desc:it.desc,to:_clean[it.key].to,victor:_clean[it.key].victor,enabled:_clean[it.key].enabled,effective:resolveRecipients(_clean,it.key,_cfg)}));
      return res.status(200).json({ok:true, victorEmail:_cfg.to, emails:_out});
    }
    const _er=await getEmailRecipients();
    const _out=EMAIL_CATALOG.map(it=>({key:it.key,name:it.name,desc:it.desc,to:(_er[it.key]&&_er[it.key].to)||"",victor:!!(_er[it.key]&&_er[it.key].victor),enabled:!(_er[it.key]&&_er[it.key].enabled===false),effective:resolveRecipients(_er,it.key,_cfg)}));
    return res.status(200).json({victorEmail:_cfg.to, emails:_out});
  }
  // Master on/off flags for each automatic system email. Gavin-gated. GET returns flags; POST {flags:{...}} saves. Defaults all TRUE.
  if(action==="email_flags"){
    if((req.headers["x-gavin-password"]||"")!==(process.env.GAVIN_PASSWORD||"__x")) return res.status(403).json({error:"gavin only"});
    if(req.method==="POST"){ let _b=req.body; if(typeof _b==="string"){ try{ _b=JSON.parse(_b);}catch(e){ _b={}; } } _b=_b||{}; const _src=(_b&&_b.flags&&typeof _b.flags==="object")?_b.flags:_b; const _saved=await setEmailFlags(_src); return res.status(200).json({ok:true, flags:_saved}); }
    return res.status(200).json({flags:await getEmailFlags()});
  }
  // Auto-grade on/off (Gavin toggle). Backend source of truth: the UI reads it on load and the daily
  // auto-grader (runDailyScore) checks it. GET -> {enabled}; POST {enabled:true|false} -> set.
  if(action==="autograde_flag"){
    if((req.headers["x-gavin-password"]||"")!==(process.env.GAVIN_PASSWORD||"__x")) return res.status(403).json({error:"gavin only"});
    if(req.method==="POST"){ let _b=req.body; if(typeof _b==="string"){ try{ _b=JSON.parse(_b);}catch(e){ _b={}; } } _b=_b||{}; const _want=(_b.enabled!==undefined?_b.enabled:_b.on); const _saved=await setAutograde(_want); return res.status(200).json({ok:true, enabled:_saved}); }
    return res.status(200).json({enabled:await getAutograde()});
  }
  if(action==="weekly_hide"){
      if((req.headers["x-gavin-password"]||"")!==(process.env.GAVIN_PASSWORD||"__x")) return res.status(401).json({error:"unauthorized"});
      let b=req.body; if(typeof b==="string"){try{b=JSON.parse(b);}catch(e){b={};}} b=b||{};
      if(Object.prototype.hasOwnProperty.call(b,"hidden")){ const hid=!!b.hidden; try{ if(redis){ if(hid) await redis.set("parkside:weekly_hidden","1"); else await redis.del("parkside:weekly_hidden"); } }catch(e){} return res.status(200).json({ok:true, hidden:hid}); }
      let hid=false; try{ if(redis) hid=!!(await redis.get("parkside:weekly_hidden")); }catch(e){} return res.status(200).json({hidden:hid});
    }
    // item 8: per-day hide (Gavin-gated). Persists a JSON list of hidden dates so "Hide this day" survives reload.
    // POST {date,hidden} toggles; GET ?date=YYYY-MM-DD -> {hidden}; GET (no date) -> {dates:[...]}.
    if(action==="day_hide"){
      if((req.headers["x-gavin-password"]||"")!==(process.env.GAVIN_PASSWORD||"__x")) return res.status(401).json({error:"unauthorized"});
      let b=req.body; if(typeof b==="string"){try{b=JSON.parse(b);}catch(e){b={};}} b=b||{};
      const _qd=String((req.query&&req.query.date)||b.date||"").slice(0,10);
      let _set=[]; try{ if(redis){ const raw=await redis.get("parkside:day_hidden"); _set=Array.isArray(raw)?raw:(raw?JSON.parse(raw):[]); } }catch(e){ _set=[]; }
      if(!Array.isArray(_set)) _set=[];
      if(req.method==="POST" && Object.prototype.hasOwnProperty.call(b,"hidden")){
        if(!/^\d{4}-\d{2}-\d{2}$/.test(_qd)) return res.status(400).json({error:"date required (YYYY-MM-DD)"});
        const hid=!!b.hidden;
        _set=_set.filter(function(d){return d!==_qd;});
        if(hid) _set.push(_qd);
        try{ if(redis) await redis.set("parkside:day_hidden", JSON.stringify(_set)); }catch(e){ return res.status(500).json({error:"db error"}); }
        return res.status(200).json({ok:true, date:_qd, hidden:hid});
      }
      if(_qd) return res.status(200).json({date:_qd, hidden:_set.indexOf(_qd)!==-1, dates:_set});
      return res.status(200).json({dates:_set});
    }
    // Victor time-off log. app-gated (Victor) or Gavin. GET=list; POST add {date,kind:day|hours,hours,note}; POST del {id,del:1}.
    if(action==="timeoff_list"){
      if((req.headers["x-app-password"]||"")!==(process.env.APP_PASSWORD||"__y") && (req.headers["x-gavin-password"]||"")!==(process.env.GAVIN_PASSWORD||"__x")) return res.status(401).json({error:"unauthorized"});
      let items=[]; try{ if(redis){ const raw=await redis.lrange("parkside:timeoff",0,-1); items=(raw||[]).map(function(x){try{return typeof x==="string"?JSON.parse(x):x;}catch(e){return null;}}).filter(Boolean); } }catch(e){}
      items.sort(function(a,b){return String(b.date||"").localeCompare(String(a.date||""));});
      return res.status(200).json({items});
    }
    if(action==="timeoff_add"){
      if((req.headers["x-app-password"]||"")!==(process.env.APP_PASSWORD||"__y") && (req.headers["x-gavin-password"]||"")!==(process.env.GAVIN_PASSWORD||"__x")) return res.status(401).json({error:"unauthorized"});
      let b=req.body; if(typeof b==="string"){try{b=JSON.parse(b);}catch(e){b={};}} b=b||{};
      const date=String(b.date||"").slice(0,10); if(!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({error:"date required (YYYY-MM-DD)"});
      const kind=(String(b.kind||"day").toLowerCase()==="hours")?"hours":"day";
      const hours=kind==="hours"?Math.max(0,Math.min(24,Number(b.hours)||0)):null;
      const rec={id:"to_"+Date.now().toString(36)+Math.floor(Math.random()*1e4).toString(36), date:date, kind:kind, hours:hours, note:String(b.note||"").slice(0,200), at:new Date().toISOString()};
      try{ if(redis){ await redis.rpush("parkside:timeoff", JSON.stringify(rec)); await redis.ltrim("parkside:timeoff",-500,-1); } }catch(e){ return res.status(500).json({error:"db error"}); }
      return res.status(200).json({ok:true, item:rec});
    }
    if(action==="timeoff_del"){
      if((req.headers["x-app-password"]||"")!==(process.env.APP_PASSWORD||"__y") && (req.headers["x-gavin-password"]||"")!==(process.env.GAVIN_PASSWORD||"__x")) return res.status(401).json({error:"unauthorized"});
      let b=req.body; if(typeof b==="string"){try{b=JSON.parse(b);}catch(e){b={};}} b=b||{}; const id=String(b.id||"");
      try{ if(redis){ const raw=await redis.lrange("parkside:timeoff",0,-1); const kept=(raw||[]).map(function(x){return typeof x==="string"?x:JSON.stringify(x);}).filter(function(x){try{return JSON.parse(x).id!==id;}catch(e){return true;}}); await redis.del("parkside:timeoff"); if(kept.length) await redis.rpush.apply(redis,["parkside:timeoff"].concat(kept)); } }catch(e){ return res.status(500).json({error:"db error"}); }
      return res.status(200).json({ok:true, removed:id});
    }
    // Report-a-Bug — SHARED staff tab (Victor via app password, or Gavin). GET=list; POST {text} append;
    // POST {delId} (or {id,del:true}) remove. Persisted at parkside:bugs as a JSON array using the same
    // stringify-on-write / string-or-array-tolerant-read pattern as parkside:day_hidden (reliable across cold keys).
    if(action==="bugs"){
      if((req.headers["x-app-password"]||"")!==(process.env.APP_PASSWORD||"__y") && (req.headers["x-gavin-password"]||"")!==(process.env.GAVIN_PASSWORD||"__x")) return res.status(401).json({error:"unauthorized"});
      let list=[]; try{ if(redis){ const raw=await redis.get("parkside:bugs"); list=Array.isArray(raw)?raw:(raw?JSON.parse(raw):[]); } }catch(e){ list=[]; }
      if(!Array.isArray(list)) list=[];
      if(req.method==="POST"){
        let b=req.body; if(typeof b==="string"){try{b=JSON.parse(b);}catch(e){b={};}} b=b||{};
        const delId=String(b.delId||(b.del?b.id:"")||"");
        if(delId){
          list=list.filter(function(x){ return x && x.id!==delId; });
          try{ if(redis) await redis.set("parkside:bugs", JSON.stringify(list)); }catch(e){ return res.status(500).json({error:"db error"}); }
          return res.status(200).json({ok:true, removed:delId, bugs:list});
        }
        const text=String(b.text||"").trim().slice(0,2000);
        if(!text) return res.status(400).json({error:"text required"});
        const rec={id:"bug_"+Date.now().toString(36)+Math.floor(Math.random()*1e4).toString(36), text:text, at:new Date().toISOString()};
        list.push(rec);
        if(list.length>500) list=list.slice(-500);
        try{ if(redis) await redis.set("parkside:bugs", JSON.stringify(list)); }catch(e){ return res.status(500).json({error:"db error"}); }
        return res.status(200).json({ok:true, item:rec, bugs:list});
      }
      return res.status(200).json({bugs:list});
    }
    // Monthly report (Gavin/cron): GET returns JSON; ?send=1 emails Gavin+Victor. ?month=YYYY-MM (default current).
    if(action==="monthly_report"){
      const okAuth=((req.headers["x-gavin-password"]||"")===(process.env.GAVIN_PASSWORD||"__x")) || ((req.headers["authorization"]||"")==="Bearer "+(process.env.CRON_SECRET||"__y")) || ((req.query&&req.query.token)===(process.env.CRON_SECRET||"__z"));
      if(!okAuth) return res.status(401).json({error:"unauthorized"});
      const month=String((req.query&&req.query.month)||"")||etDate(new Date().toISOString()).slice(0,7);
      if((req.query&&req.query.send)==="1"){ return res.status(200).json(await sendMonthlyReport(month, null)); }
      return res.status(200).json(await buildMonthlyReport(month));
    }
    // Month summary: average grade + good/bad lists + optional AI prose. Gavin-gated. ?month=YYYY-MM (default current).
    if(action==="score_summary"){
      // Victor sees his own month AI-score snippet (My Work), plus Gavin.
      if((req.headers["x-app-password"]||"")!==(process.env.APP_PASSWORD||"__y") && (req.headers["x-gavin-password"]||"")!==(process.env.GAVIN_PASSWORD||"__x")) return res.status(401).json({error:"unauthorized"});
      const month=String((req.query&&req.query.month)||"")||etDate(new Date().toISOString()).slice(0,7);
      const first=month+"-01", last=monthLastDay(month);
      let dates=[]; try{ if(redis){ const z=await redis.zrange("parkside:grades_index",0,-1); dates=(z||[]).filter(function(d){ return d>=first && d<=last; }); } }catch(e){}
      const graded=[]; for(const d of dates){ try{ const g=await redis.get("parkside:grade:"+d); if(g&&g.grade!=null) graded.push({date:d, grade:Number(g.grade), note:String(g.note||"")}); }catch(e){} }
      graded.sort(function(a,b){ return String(a.date).localeCompare(String(b.date)); });
      // item 8: days Gavin hid are removed from VICTOR's month snippet (Gavin still sees them in his own view).
      if((req.headers["x-gavin-password"]||"")!==(process.env.GAVIN_PASSWORD||"__x")){
        let _hid=[]; try{ if(redis){ const _raw=await redis.get("parkside:day_hidden"); _hid=Array.isArray(_raw)?_raw:(_raw?JSON.parse(_raw):[]); } }catch(e){ _hid=[]; }
        if(Array.isArray(_hid)&&_hid.length){ for(let _i=graded.length-1;_i>=0;_i--){ if(_hid.indexOf(graded[_i].date)!==-1) graded.splice(_i,1); } }
      }
      const count=graded.length;
      const average=count?Math.round(graded.reduce(function(s,x){return s+x.grade;},0)/count):null;
      const fmt=function(x){ return x.date+" — "+x.grade+"/100"+(x.note?(" ("+x.note+")"):""); };
      const good=graded.filter(function(x){return x.grade>=80;}).map(fmt);
      const bad=graded.filter(function(x){return x.grade<60;}).map(fmt);
      let summary="";
      const key=process.env.ANTHROPIC_API_KEY;
      if(key && count){
        const lines=graded.map(function(x){ return x.date+": "+x.grade+"/100"+(x.note?(" — "+x.note):""); }).join("\n");
        const sys="You summarize a maintenance/operations worker's month at a glamping resort using the owner's daily grades (0-100) and notes. Write 3-5 short sentences: what went well this month, and what to work on / improve next month. Honest, specific, constructive. Plain prose paragraph, no lists, no JSON.";
        try{ const r=await fetch("https://api.anthropic.com/v1/messages",{method:"POST",headers:{"x-api-key":key,"anthropic-version":"2023-06-01","content-type":"application/json"},body:JSON.stringify({model:"claude-haiku-4-5-20251001",max_tokens:400,temperature:0.3,system:sys,messages:[{role:"user",content:"Month "+month+". Average grade: "+(average!=null?(average+"/100"):"n/a")+" across "+count+" graded day(s).\nDaily grades:\n"+lines}]})});
          const j=await r.json(); if(r.ok) summary=((j.content&&j.content[0]&&j.content[0].text)||"").trim();
        }catch(e){}
      }
      return res.status(200).json({month, average, count, good, bad, summary});
    }
    // item R1 (Connections): on-demand month report. Averages the month's dailies (owner grade, else AI
    // productivity score) and writes a ~2-sentence summary of the RECURRING strengths & weaknesses across
    // the month (patterns that repeat, not one-off days). Gavin-gated.
    if(action==="gen_month_report"){
      if((req.headers["x-gavin-password"]||"")!==(process.env.GAVIN_PASSWORD||"__x")) return res.status(401).json({error:"unauthorized"});
      const month=String((req.query&&req.query.month)||"")||etDate(new Date().toISOString()).slice(0,7);
      const first=month+"-01", last=monthLastDay(month);
      const days=[]; let d=first;
      while(d<=last){
        let score=null, grade=null; try{ if(redis){ score=await redis.get("parkside:score:"+d); grade=await redis.get("parkside:grade:"+d); } }catch(e){}
        const ownerG=!!(grade&&grade.grade!=null);
        const g = ownerG ? Number(grade.grade) : (score&&score.productivity_score!=null?Number(score.productivity_score):null);
        const expl = (grade&&grade.note)?String(grade.note):(score&&score.summary?String(score.summary):"");
        if(g!=null) days.push({date:d, grade:Math.round(g), owner:ownerG, explanation:expl});
        d=etDateAddDays(d,1);
      }
      const count=days.length;
      const average=count?Math.round(days.reduce(function(s,x){return s+x.grade;},0)/count):null;
      let report="";
      const key=process.env.ANTHROPIC_API_KEY;
      if(key && count){
        const lines=days.map(function(x){ return x.date+": "+x.grade+"/100"+(x.owner?" [owner]":"")+(x.explanation?(" - "+x.explanation):""); }).join("\n");
        const sys="You are writing a VERY SHORT monthly performance report for a maintenance/operations worker at a glamping resort, from the owner's daily grades (0-100) and notes for the month. Write about TWO sentences. Call out the RECURRING strengths (patterns that repeat across multiple days) and the RECURRING weaknesses (issues that repeat across multiple days). Focus on what repeats, not one-off days. Plain prose, no lists, no JSON, no preamble.";
        try{ const r=await fetch("https://api.anthropic.com/v1/messages",{method:"POST",headers:{"x-api-key":key,"anthropic-version":"2023-06-01","content-type":"application/json"},body:JSON.stringify({model:"claude-haiku-4-5-20251001",max_tokens:220,temperature:0.3,system:sys,messages:[{role:"user",content:"Month "+month+". Average grade: "+(average!=null?(average+"/100"):"n/a")+" across "+count+" graded day(s).\nDaily grades + notes:\n"+lines}]})});
          const j=await r.json(); if(r.ok) report=((j.content&&j.content[0]&&j.content[0].text)||"").trim();
        }catch(e){}
      }
      return res.status(200).json({month, average, count, report});
    }
    // item MW6 (My Work): per-day grade + short explanation for a month, powering the AI-score calendar.
    // Victor may read his own; Gavin too. Hidden days are suppressed for Victor.
    if(action==="score_calendar"){
      if((req.headers["x-app-password"]||"")!==(process.env.APP_PASSWORD||"__y") && (req.headers["x-gavin-password"]||"")!==(process.env.GAVIN_PASSWORD||"__x")) return res.status(401).json({error:"unauthorized"});
      const month=String((req.query&&req.query.month)||"")||etDate(new Date().toISOString()).slice(0,7);
      const first=month+"-01", last=monthLastDay(month);
      const isGavin=((req.headers["x-gavin-password"]||"")===(process.env.GAVIN_PASSWORD||"__x"));
      let hid=[]; if(!isGavin){ try{ if(redis){ const raw=await redis.get("parkside:day_hidden"); hid=Array.isArray(raw)?raw:(raw?JSON.parse(raw):[]); } }catch(e){ hid=[]; } }
      const days=[]; let d=first, sum=0, cnt=0;
      while(d<=last){
        if(isGavin || hid.indexOf(d)===-1){
          let score=null, grade=null; try{ if(redis){ score=await redis.get("parkside:score:"+d); grade=await redis.get("parkside:grade:"+d); } }catch(e){}
          const ownerG=!!(grade&&grade.grade!=null);
          const g = ownerG ? Number(grade.grade) : (score&&score.productivity_score!=null?Number(score.productivity_score):null);
          const expl = (grade&&grade.note)?String(grade.note):(score&&score.summary?String(score.summary):"");
          // item MW-5: the model isn't trained/published yet — do NOT expose per-day AI reasoning to
          // Victor. Only Gavin's view receives the explanation text; Victor gets the bare score.
          if(g!=null){ const drec={date:d, grade:Math.round(g), source:ownerG?"owner":"ai"}; if(isGavin) drec.explanation=expl; days.push(drec); sum+=g; cnt++; }
        }
        d=etDateAddDays(d,1);
      }
      return res.status(200).json({month, days, average:(cnt?Math.round(sum/cnt):null), count:cnt});
    }
    // Gavin's manual grade for a day (ground truth the auto-grader learns from). Gavin-gated.
    if(action==="grade_get"){
      if((req.headers["x-gavin-password"]||"")!==(process.env.GAVIN_PASSWORD||"__x")) return res.status(401).json({error:"unauthorized"});
      const date=String((req.query&&req.query.date)||"")||etDate(new Date().toISOString());
      let grade=null; try{ if(redis) grade=await redis.get("parkside:grade:"+date); }catch(e){}
      let count=0; try{ if(redis){ const z=await redis.zrange("parkside:grades_index",0,-1); count=(z||[]).length; } }catch(e){}
      return res.status(200).json({date, grade, graded_count:count});
    }
    if(action==="grade_set"){
      if((req.headers["x-gavin-password"]||"")!==(process.env.GAVIN_PASSWORD||"__x")) return res.status(401).json({error:"unauthorized"});
      const date=String((req.query&&req.query.date)||"")||etDate(new Date().toISOString());
      const device=String((req.query&&req.query.id)||"victor").toLowerCase().replace(/[^A-Za-z0-9_\-]/g,"").slice(0,40)||"victor";
      let b=req.body; if(typeof b==="string"){try{b=JSON.parse(b);}catch{b={};}} b=b||{};
      if(b.grade===""||b.grade==null){ if(redis){ try{ await redis.del("parkside:grade:"+date); await redis.zrem("parkside:grades_index",date); }catch(e){} } return res.status(200).json({ok:true, cleared:true, date}); }
      const g=Number(b.grade); if(!isFinite(g)) return res.status(400).json({error:"grade must be a number 0-100"});
      const snap=await buildDaySnapshot(date, device);
      const rec={date, grade:Math.max(0,Math.min(100,Math.round(g))), note:String(b.note||"").slice(0,500), by:"gavin", at:new Date().toISOString(), snap};
      try{ if(redis){ await redis.set("parkside:grade:"+date, rec); await redis.zadd("parkside:grades_index",{score:Number(date.replace(/-/g,'')),member:date}); } }catch(e){}
      let count=0; try{ if(redis){ const z=await redis.zrange("parkside:grades_index",0,-1); count=(z||[]).length; } }catch(e){}
      return res.status(200).json(Object.assign({ok:true, graded_count:count}, rec));
    }
    if(action==="grades_list"){
      if((req.headers["x-gavin-password"]||"")!==(process.env.GAVIN_PASSWORD||"__x")) return res.status(401).json({error:"unauthorized"});
      let dates=[]; try{ if(redis){ const z=await redis.zrange("parkside:grades_index",0,-1); dates=(z||[]).slice().reverse(); } }catch(e){}
      return res.status(200).json({count:dates.length, dates});
    }
    if(action==="gps_zones"){
      if((req.headers["x-gavin-password"]||"")!==(process.env.GAVIN_PASSWORD||"__x") && (req.headers["x-app-password"]||"")!==(process.env.APP_PASSWORD||"__y")) return res.status(401).json({error:"unauthorized"});
      if(req.method==="POST"){ let b=req.body; if(typeof b==="string"){try{b=JSON.parse(b);}catch{b={};}} b=b||{};
        const arr=Array.isArray(b.zones)?b.zones:null; if(!arr) return res.status(400).json({error:"need zones:[{name,lat,lon,radius_m}]"});
        const clean=arr.map(z=>({name:String(z.name||'zone').slice(0,32),lat:Number(z.lat),lon:Number(z.lon),radius_m:Math.round(Number(z.radius_m))})).filter(z=>isFinite(z.lat)&&isFinite(z.lon)&&z.radius_m>0);
        if(!clean.length) return res.status(400).json({error:"no valid zones"}); if(redis) await redis.set('parkside:zones',clean); return res.status(200).json({ok:true, zones:clean}); }
      return res.status(200).json({ zones: await getZones() });
    }
    if(action==="go" || ((!action) && req.query && req.query.c)){
      res.setHeader("Content-Type","text/html; charset=utf-8");
      const list=await getApprovals();
      const it=findByCode(list, (req.query&&req.query.c)||"");
      const d=String((req.query&&req.query.d)||"").toLowerCase();
      const decision=(d==="n"||d==="no")?"no":"yes";
      if(!it){ res.statusCode=200; return res.end(htmlPage("Link expired","This approval link is no longer valid (it may already have been handled).")); }
      if(it.status!=="pending"){ res.statusCode=200; return res.end(htmlPage("Already "+it.status+" ✓",(it.smsLabel||"This one")+" was already "+it.status+". The guest was not messaged twice.")); }
      const out=await decideApproval(it.id, decision, null, decision==="no"?"rejected via link":undefined);
      if(decision==="no"){ res.statusCode=200; return res.end(htmlPage("Skipped",(it.smsLabel||"It")+" was skipped — nothing was sent to the guest.")); }
      if(out&&out.ok&&out.decision==="approved"){ res.statusCode=200; return res.end(htmlPage("Sent ✓",(it.smsLabel||"Your reply")+" was sent to the guest and saved for next time.")); }
      res.statusCode=200; return res.end(htmlPage("Couldn’t send",((out&&out.error)||"Unknown error")+"."));
    }
    if(action==="state"){
      if(req.method==="GET"){ const s=await getState(); const icalCount={}; for(const u of UNITS) icalCount[u.orp]=OWNERREZ_ICAL[u.orp]?1:0;
        const gapEnabled=redis?(Number(await redis.get("parkside:gap_enabled"))===1):false;
        const lastRun=redis?(await redis.get("parkside:last_run")):null;
        return res.status(200).json({targets:s.targets,knobs:KNOBS,auto_sync:s.auto_sync,pricing_model:s.pricing_model||'legacy',learning_enabled:s.learning_enabled!==false,overrides:s.overrides||{},icalCount,occupancySource:'ownerrez',kb:s.kb||KB_SEED,messaging_enabled:!!s.messaging_enabled,gap_enabled:gapEnabled,last_run:lastRun}); }
      if(req.method==="POST"){ if((req.headers["x-app-password"]||"")!==(process.env.APP_PASSWORD||"")) return res.status(401).json({error:"unauthorized"});
        let b=req.body; if(typeof b==="string"){try{b=JSON.parse(b);}catch{return res.status(400).json({error:"bad json"});}}
        const cur=await getState(); const p={};
        if(b&&b.targets)p.targets=b.targets; if(b&&typeof b.auto_sync==="boolean")p.auto_sync=b.auto_sync; if(b&&b.kb)p.kb=b.kb; if(b&&typeof b.messaging_enabled==="boolean")p.messaging_enabled=b.messaging_enabled; if(b&&(b.pricing_model==="glide"||b.pricing_model==="legacy"))p.pricing_model=b.pricing_model; if(b&&typeof b.learning_enabled==="boolean")p.learning_enabled=b.learning_enabled;
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
      const _kPace=await getKnobs(); const pace=computePace(od.agg.poolAgg, st.targets, learned, today, months, _kPace.paceLength);
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
      const gapOn=redis?(Number(await redis.get("parkside:gap_enabled"))===1):false; const K=await getKnobs();
      const model=(st.pricing_model==="glide")?"glide":"legacy";let rates;if(model==="glide"){const gsState=(redis&&await redis.get("parkside:gs"))||{};rates=computeGlide(sig,targets,today,today,days,occ,st.overrides,gsState,{mode:"step",applyGap:gapOn,knobs:K,learned}).rates;}else{rates=compute(sig,targets,today,today,days,occ,st.overrides,learned);} const amts=rates.map(r=>r.amount);
      const pace = occ.agg ? computePace(occ.agg.poolAgg, targets, learned, today, monthList(today,days), K.paceLength) : null;
      const paceLearn={weekend:learned.weekend.n||0,weekday:learned.weekday.n||0,blendWeight:Math.min(0.8,((learned.weekend.n||0)+(learned.weekday.n||0))/600).toFixed(2)};
      return res.status(200).json({mode:"PREVIEW",wrote:false,count:rates.length,coldStart:!occ.hasData,min:Math.min(...amts),max:Math.max(...amts),avg:Math.round(amts.reduce((a,c)=>a+c,0)/amts.length),overrideCount:rates.filter(r=>r.overridden).length,pace,paceLearn,rates});
    }
    if(action==="glide_preview"){
      // READ-ONLY. Shows current (legacy, live) rate vs new GLIDE-SLOPE rate per unit for the next N nights. Writes nothing; pushes nothing.
      let b=req.body; if(typeof b==="string"){try{b=JSON.parse(b);}catch{b={};}}
      const N=Math.max(7,Math.min(90, parseInt((req.query&&req.query.days)||(b&&b.days)||45,10)||45));
      const st=await getState(); const targets=st.targets; const sig=await getSignal(); const learned=await getLearned();
      const od=await getOccData(st,today,days,true); const occ={hasData:od.booked.total>0, agg:od.agg};
      const before=compute(sig,targets,today,today,N,occ,st.overrides,learned);            // legacy = what is live today
      const after=computeGlide(sig,targets,today,today,N,occ,st.overrides,{},{mode:"steady",knobs:await getKnobs(),learned}).rates; // glide steady-state destination
      const bIx={}; for(const r of before) bIx[r.property_id+"|"+r.date]=r.amount;
      const perUnit={}; let gBefore=[],gAfter=[];
      for(const u of UNITS) perUnit[u.orp]={unit:u.name,nights:[]};
      for(const r of after){ const bv=bIx[r.property_id+"|"+r.date]; perUnit[r.property_id].nights.push({date:r.date,before:bv,after:r.amount,poolOcc:r.poolOcc,lead:r.lead,lm:r.lm,override:r.overridden}); gBefore.push(bv); gAfter.push(r.amount); }
      const avg=a=>a.length?Math.round(a.reduce((x,y)=>x+y,0)/a.length):null;
      const summ={}; for(const u of UNITS){ const ns=perUnit[u.orp].nights; const bs=ns.map(x=>x.before),as=ns.map(x=>x.after);
        summ[u.orp]={unit:u.name,beforeAvg:avg(bs),afterAvg:avg(as),beforeMin:Math.min(...bs),beforeMax:Math.max(...bs),afterMin:Math.min(...as),afterMax:Math.max(...as),avgDeltaPct:bs.length?Math.round(1000*((avg(as)-avg(bs))/avg(bs)))/10:null}; }
      return res.status(200).json({mode:"GLIDE_PREVIEW",wrote:false,pushedToOwnerRez:false,auto_sync:st.auto_sync,pricing_model:st.pricing_model||"legacy",learning_enabled:st.learning_enabled!==false,days:N,coldStart:!occ.hasData,
        knobs:{FLOOR,CEIL,PEAK_CEIL:MODEL.PEAK_CEIL,GS,LM,unitPremiums:UNIT_PREM},
        overall:{beforeAvg:avg(gBefore),afterAvg:avg(gAfter),avgDeltaPct:gBefore.length?Math.round(1000*((avg(gAfter)-avg(gBefore))/avg(gBefore)))/10:null},
        summary:summ, perUnit});
    }
    if(action==="wipe_learning"){
      if((req.headers["x-app-password"]||"")!==(process.env.APP_PASSWORD||"__x")) return res.status(401).json({error:"unauthorized"});
      if(!redis) return res.status(200).json({ok:false,error:"no redis"});
      const ev=(await redis.get("parkside:events"))||[]; const L=(await redis.get("parkside:learn"))||{}; const snap=(await redis.get("parkside:snap"))||{}; const gs=(await redis.get("parkside:gs"))||{};
      const cleared={events:Array.isArray(ev)?ev.length:0, learnBuckets:Object.keys(L).length, snapCells:Object.keys(snap).length, glideState:Object.keys(gs).length};
      await redis.del("parkside:events"); await redis.del("parkside:learn"); await redis.del("parkside:snap"); await redis.del("parkside:gs");
      await setState({learning_enabled:false}); // bookings still count toward occupancy via iCal; they no longer feed demand/elasticity learning
      return res.status(200).json({ok:true,wiped:cleared,learning_enabled:false,note:"Demand/elasticity learning reset. OwnerRez bookings still count toward current occupancy (iCal). Targets + knobs preserved."});
    }
    if(action==="signal_override"){
      if((req.headers["x-app-password"]||"")!==(process.env.APP_PASSWORD||"")) return res.status(401).json({error:"unauthorized"});
      let b=req.body; if(typeof b==="string"){try{b=JSON.parse(b);}catch{b={};}}
      if(b&&b.clear){ if(redis) await redis.del("parkside:signal_override"); return res.status(200).json({ok:true,cleared:true,note:"signal_override cleared - PriceLabs sourcing restored"}); }
      const _v=Math.round(Number(b&&b.value)); if(!(_v>0)) return res.status(400).json({error:"value must be a positive number"});
      if(redis) await redis.set("parkside:signal_override",_v); return res.status(200).json({ok:true,override:_v,note:"TEMP flat base override active - clear with {clear:true} once PriceLabs reflects the new base"});
    }
    if(action==="run"){
      const okAuth=((req.headers["authorization"]||"")==="Bearer "+(process.env.CRON_SECRET||"__x")) || ((req.headers["x-app-password"]||"")===(process.env.APP_PASSWORD||"__x")) || ((req.headers["x-gavin-password"]||"")===(process.env.GAVIN_PASSWORD||"__zzz"));
      if(!okAuth) return res.status(401).json({error:"unauthorized"});
      let _dailyScore=null; try{ _dailyScore=await runDailyScore(new Date().toISOString()); }catch(_ds){ _dailyScore={error:String((_ds&&_ds.message)||_ds)}; }
      try{ await runMonthlyReportIfDue(new Date().toISOString()); }catch(_mr){}
      try{ console.error("[run] start model-check auto_sync-check begin"); }catch(_){}
      const st=await getState(); const model=(st.pricing_model==="glide")?"glide":"legacy"; const sig=await getSignal();
      const od=await getOccData(st,today,days,false); const booked=od.booked;
      const occ={hasData:booked.total>0, agg:od.agg};
      let rates, logged=0;
      const K=await getKnobs();
      if(model==="glide"){
        const gapOn=redis?(Number(await redis.get("parkside:gap_enabled"))===1):false;
        const gsState=(redis&&await redis.get("parkside:gs"))||{};
        const g=computeGlide(sig,st.targets,today,today,days,occ,st.overrides,gsState,{mode:"step",applyGap:gapOn,knobs:K,learned:await getLearned()});
        rates=g.rates; if(redis) await redis.set("parkside:gs",g.gsNext); // ease the applied multiplier toward target; NO demand/elasticity learning
        if(redis){ // min-stay bookkeeping: set min on active gap nights; restore default on nights that stopped being gaps
          const prevSet=(await redis.get("parkside:gapmin"))||[]; const nowSet=[]; const rIx={};
          for(const r of rates) rIx[r.property_id+"|"+r.date]=r;
          for(const r of rates){ if(r.minNights===1) nowSet.push(r.property_id+"|"+r.date); }
          const nowKeys=new Set(nowSet);
          for(const k of prevSet){ if(!nowKeys.has(k)){ const r=rIx[k]; if(r && !r.overridden){ r.minNights=GAP_RESET_MIN; r._gapReset=true; } } }
          await redis.set("parkside:gapmin",nowSet);
        }
      } else {
        const learned=await getLearned();
        rates=compute(sig,st.targets,today,today,days,occ,st.overrides,learned);
        if(st.learning_enabled!==false) logged=await logPhase1(rates,booked,today);
      }
      if(!st.auto_sync) return res.status(200).json({mode:"COMPUTED_NO_SYNC",pricing_model:model,auto_sync:false,dailyScore:_dailyScore,computed:rates.length,wrote:false,bookedNights:booked.total,logged,note:"auto-sync OFF — nothing written to OwnerRez"});
      let r; try{ r=await pushOwnerRez(rates,K); }catch(_pe){ try{ console.error("[run] pushOwnerRez threw: "+String((_pe&&_pe.stack)||_pe)); }catch(_){} return res.status(500).json({error:"pushOwnerRez failed: "+String((_pe&&_pe.message)||_pe)}); }
      if(redis&&r.ownerrezOk){ const _gn=rates.filter(x=>x.gapApplied).length; try{ await redis.set("parkside:last_run",{ts:Date.now(),at:new Date().toISOString(),sent:r.sent,gapNights:_gn}); }catch(_x){} }
      return res.status(r.ownerrezOk?200:502).json({mode:"LIVE_SYNC",pricing_model:model,auto_sync:true,dailyScore:_dailyScore,bookedNights:booked.total,logged,overrides:rates.filter(x=>x.overridden).length,gapNights:rates.filter(x=>x.gapApplied).length,...r});
    }
    if(action==="gap_preview"){
      // READ-ONLY sign-off report: orphan-gap nights over next N days, normal price vs gap-discounted price + min-stay.
      const N=Math.max(7,Math.min(120, parseInt((req.query&&req.query.days)||60,10)||60));
      const st=await getState(); const sig=await getSignal();
      const od=await getOccData(st,today,days,true); const occ={hasData:od.booked.total>0, agg:od.agg};
      const gsState=(redis&&await redis.get("parkside:gs"))||{}; const K=await getKnobs();
      const lrn=await getLearned();
      const normal=computeGlide(sig,st.targets,today,today,N,occ,st.overrides,gsState,{mode:"step",applyGap:false,knobs:K,learned:lrn}).rates;
      const gapped=computeGlide(sig,st.targets,today,today,N,occ,st.overrides,gsState,{mode:"step",applyGap:true,knobs:K,learned:lrn}).rates;
      const nIx={}; for(const r of normal) nIx[r.property_id+"|"+r.date]=r.amount;
      const gapOn=redis?(Number(await redis.get("parkside:gap_enabled"))===1):false;
      const perUnit={}; const totals={1:0,2:0,3:0}; let count=0;
      for(const u of UNITS) perUnit[u.orp]={unit:u.name,gaps:[]};
      for(const r of gapped){ if(r.gapApplied){ const before=nIx[r.property_id+"|"+r.date];
        const dow=new Date(r.date+"T00:00:00Z").getUTCDay();
        perUnit[r.property_id].gaps.push({date:r.date,dow,tier:r.gapTier,weekend:r.gapHasWeekend,discPct:Math.round(r.gapDisc*100),before,after:r.amount,minNights:r.minNights,deeperOf:r.discSource});
        totals[r.gapTier]=(totals[r.gapTier]||0)+1; count++; } }
      return res.status(200).json({mode:"GAP_PREVIEW",writes:false,pushedToOwnerRez:false,gapsLive:gapOn,days:N,coldStart:!occ.hasData,
        knobs:{GAP_DISC:{1:K.gap1,2:K.gap2,3:K.gap3},weekendFactor:K.gapWeekend,resetMin:GAP_RESET_MIN,saneMin:K.saneMin,floor:K.floor},
        totalsByTier:totals, gapNightCount:count, perUnit});
    }
    if(action==="gap_toggle"){
      if((req.headers["x-app-password"]||"")!==(process.env.APP_PASSWORD||"")) return res.status(401).json({error:"unauthorized"});
      let b=req.body; if(typeof b==="string"){try{b=JSON.parse(b);}catch{b={};}}
      const on=!!(b&&b.enabled); if(redis) await redis.set("parkside:gap_enabled",on?1:0);
      return res.status(200).json({ok:true,gap_enabled:on,note:on?"Gap discounting ON — applies on next run/preview/push":"Gap discounting OFF — gap nights price at the normal glide rate"});
    }
    if(action==="breakdown"){
      // READ-ONLY full computation chain for ONE unit+date (per-day inspector).
      const ds=(req.query&&req.query.date)||""; const unitId=(req.query&&req.query.unit)||"";
      if(!/^\d{4}-\d{2}-\d{2}$/.test(ds)) return res.status(400).json({error:"need date=YYYY-MM-DD"});
      const u=UNITS.find(x=>String(x.orp)===String(unitId))||UNITS[0];
      const st=await getState(); const sig=await getSignal();
      const od=await getOccData(st,today,days,true); const occ={hasData:od.booked.total>0, agg:od.agg};
      const gsState=(redis&&await redis.get("parkside:gs"))||{}; const K=await getKnobs();
      const gapOn=redis?(Number(await redis.get("parkside:gap_enabled"))===1):false;
      const span=Math.max(1, daysBetween(today,ds)+1);
      const lrn=await getLearned();
      const liveRates=computeGlide(sig,st.targets,today,today,span,occ,st.overrides,gsState,{mode:"step",applyGap:gapOn,knobs:K,learned:lrn}).rates;
      const gapRates=computeGlide(sig,st.targets,today,today,span,occ,st.overrides,gsState,{mode:"step",applyGap:true,knobs:K,learned:lrn}).rates;
      const normRates=computeGlide(sig,st.targets,today,today,span,occ,st.overrides,gsState,{mode:"step",applyGap:false,knobs:K,learned:lrn}).rates;
      const find=arr=>arr.find(r=>String(r.property_id)===String(u.orp)&&r.date===ds);
      const live=find(liveRates), withGap=find(gapRates), norm=find(normRates);
      if(!live) return res.status(200).json({error:"date out of horizon"});
      const signalOverride=redis?(await redis.get("parkside:signal_override")):null; const ovOn=(signalOverride!=null&&Number(signalOverride)>0);
      const sigRaw=sig[ds];
      const booked=!!(occ.agg&&od.booked&&od.booked.byUnit&&od.booked.byUnit[u.orp]&&od.booked.byUnit[u.orp][ds]);
      const prem=UNIT_PREM[u.orp]||1.0, base=live.base, ceil=live.peak?MODEL.PEAK_CEIL:K.ceil;
      const sigShown=(sigRaw!=null?sigRaw:Math.round(base/prem));
      const isGapActive=gapOn&&!!live.gapApplied;
      const activeMult=live.appliedMult; const rawPrice=(activeMult==null?live.amount:Math.round(base*activeMult));
      // push-sanity threshold mirrors pushOwnerRez: gap nights exempt (hard floor); else max(saneMin, base*0.6)
      const saneThresh=isGapActive?K.floor:Math.max(K.saneMin,Math.round(base*0.60));
      let pushedPrice=(live.amount<saneThresh?saneThresh:live.amount); if(live.gap1Capped && pushedPrice>GAP1_CAP) pushedPrice=GAP1_CAP; // 1-night gap cap wins over the sane-min (matches pushOwnerRez order)
      const pct=x=>x==null?'—':Math.round(x*100)+'%'; const sgn=x=>x==null?'—':(x>0?'+':'')+x.toFixed(2);
      const fP=p=>(p>=0?'+':'−')+Math.abs(p).toFixed(1)+'%'; const fD=d=>{d=Math.round(d);return (d>=0?'+$':'−$')+Math.abs(d);};
      const dirw=d=>d>0?'↑ raises':d<0?'↓ lowers':'→ no change';
      // ===== ACCOUNTING LEDGER: start at base, each row adds/subtracts to the running total; base + Σ(±) = final push.
      const steps=[]; let run=base;
      const eff=newRun=>{ newRun=Math.round(newRun); const d=newRun-run; const p=run?d/run*100:0; const o={effect:fP(p)+'  /  '+fD(d)+'   '+dirw(d), running:'$'+newRun}; run=newRun; return o; };
      steps.push({label:'Base price', math:'PriceLabs $'+sigShown+(ovOn?' (flat override)':'')+'  ×  '+u.name+' premium '+prem+'  =  $'+base, value:'$'+base, running:'$'+base});
      // Peak-night lever — always shown so it is never a hidden effect. Peak = signal at the top of the year.
      // It (a) lifts the ceiling to PEAK_CEIL and (b) floors the demand multiplier at ×1.0 so a peak night never takes a
      // demand/pace discount. Perishable discounts (last-minute, orphan-gap) still apply below.
      { const _sv=Object.values(sig).filter(v=>v>0); const _peakLine=Math.round((_sv.length?median(_sv):K.floor)*MODEL.PEAK_MULT);
        const _peakFloored=(live.peak && live.desiredBaseMult!=null && live.desiredBaseMult<1);
        const _pMath=live.peak
          ? ('PEAK night — signal $'+sigShown+' ≥ peak line $'+_peakLine+' (top of the year). Ceiling lifts to $'+MODEL.PEAK_CEIL+'; demand multiplier floored at ×1.0'+(_peakFloored?(' — demand wanted ×'+live.desiredBaseMult.toFixed(3)+' (a discount) but PEAK floored it to ×1.0, so no demand discount was taken'):' (demand was already ≥1, so no change here)')+'. Perishable discounts (last-minute, orphan-gap) still apply below.')
          : ('not a peak night — signal $'+sigShown+' < peak line $'+_peakLine+'. Standard ceiling $'+K.ceil+', no demand floor.');
        steps.push({label:'Peak status', math:_pMath, effect:'+0.0%  /  +$0   → no change (lever effect shown inside the steps below)', running:'$'+base}); }
      if(!occ.hasData){ steps.push({label:'Demand', math:'no occupancy data yet → priced at seasonal base', ...eff(live.amount)}); }
      else {
        const monNm=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][new Date(ds+'T00:00:00Z').getUTCMonth()];
        const dtName=isWe(new Date(ds+'T00:00:00Z'))?'weekend':'weekday';
        // Demand = the ACTUALLY-APPLIED (eased) effect — where the price is today on its glide toward target. Split into
        // resort + unit by their gap contribution; NO separate "glide easing" row.
        const easedMult=(live.easedDemandMult!=null?live.easedDemandMult:live.desiredBaseMult);
        const demandDelta=Math.round(base*easedMult)-base; // total $ demand moves the price: near-term pace gap + gentle far-out demand (already eased)
        const rc=K.wResort*(live.resortGap||0), uc=K.wUnit*(live.unitGap||0); const blend=rc+uc;
        const resortDelta=Math.abs(blend)>1e-9?Math.round(demandDelta*(rc/blend)):demandDelta;
        const glideNote=(live.easedDemandMult!=null && Math.abs(easedMult-live.desiredBaseMult)>0.005)?'  ·  applied is gliding toward its full target ×'+live.desiredBaseMult+' over the next few daily runs (gradual, not instant)':'';
        const farNote=(live.farW!=null&&live.farW>=0.5&&K.farDemand>0)?('  ·  far-out ('+pct(live.farW)+' out): pace deviation '+sgn(live.relDev)+' applied gently × farDemand '+K.farDemand+'  →  ×'+(live.farDemandMult!=null?live.farDemandMult.toFixed(3):'1.000')):'';
        steps.push({label:'Pacing reference', math:'saved target '+pct(live.savedTarget)+' ('+monNm+' '+dtName+')  ×  pacing '+pct(live.paceFrac)+' (lead '+live.lead+'d on a '+K.paceLength+'-day pacing window'+(K.paceLength!==PACE_LEN_DEFAULT?', vs '+PACE_LEN_DEFAULT+'-day default → ramp '+(K.paceLength>PACE_LEN_DEFAULT?'stretched further out':'compressed toward check-in'):'')+')  =  pace-ref '+pct(live.ref)+'   →   resort occ '+pct(live.poolOcc)+' vs pace-ref  →  gap '+sgn(live.resortGap)+(live.resortGap>0?' (behind pace → lower to fill)':live.resortGap<0?' (ahead of pace → raise)':'')+'  × GAIN '+K.GAIN+' × weight '+K.wResort+farNote+glideNote+((live.peak&&live.desiredBaseMult!=null&&live.desiredBaseMult<1)?'  ·  PEAK night: this demand discount was floored to ×1.0 (peak nights take no demand discount) — see Peak status above':''), ...eff(base+resortDelta)});
        steps.push({label:'Unit demand', math:u.name+' occ '+pct(live.unitOcc)+' vs pace-ref '+pct(live.ref)+'  →  gap '+sgn(live.unitGap)+(live.unitGap>0?' (behind pace → lower)':live.unitGap<0?' (ahead of pace → raise)':'')+'  × GAIN '+K.GAIN+' × weight '+K.wUnit+(K.wUnit===0?'  (0 = off)':''), ...eff(base+demandDelta)});
        // Last-minute — ALWAYS shown; applied IMMEDIATELY on top of the eased demand. $0 if outside the window.
        const lmTxt=live.lm>0?('lead '+live.lead+'d → proximity ('+K.lmWindow+'−'+live.lead+')/'+K.lmWindow+'^'+K.lmSteep+' × max '+Math.round(K.lmMax*100)+'%  →  ×(1 − '+live.lm.toFixed(3)+') = −'+Math.round(live.lm*100)+'% (perishable, still open)'):('lead '+live.lead+'d, outside '+K.lmWindow+'d window  →  ×1.00 (none)');
        if(isGapActive){
          steps.push({label:'Last-minute', math:lmTxt, ...eff(base*(live.easedDemandMult!=null?live.easedDemandMult:live.desiredBaseMult)*(1-(live.lm||0)))});
          steps.push({label:'Gap night', math:withGap.gapTier+'-night gap'+(withGap.gapHasWeekend?' (wknd × '+K.gapWeekend+')':' (mid-week)')+'  →  ×(1 − '+withGap.gapDisc.toFixed(3)+') = −'+Math.round(withGap.gapDisc*100)+'%  (STACKS with last-minute)  ·  min-stay '+(withGap.minNights||GAP_RESET_MIN), ...eff(live.gap1Capped?live.preCapAmount:live.amount)});
        } else {
          steps.push({label:'Last-minute', math:lmTxt, ...eff(live.amount)});
          steps.push({label:'Gap night', math:(gapOn?'no orphan gap on this night':'gap discounting OFF')+(withGap.gapTier>0?('  — if active: '+withGap.gapTier+'-night −'+Math.round(withGap.gapDisc*100)+'%'):'')+'  →  ×1.00 (none)', ...eff(run)});
        }
        if(live.gap1Capped){ steps.push({label:'1-night gap cap', math:'single-night orphan gap — hard-capped so it never exceeds $'+GAP1_CAP+' (was $'+Math.round(live.preCapAmount)+')', ...eff(live.amount)}); }
      }
      steps.push({label:'Push sanity (min)', math:(isGapActive?('gap night — exempt; hard floor $'+K.floor):('non-gap minimum $'+saneThresh))+(live.peak?' · peak ceiling':''), ...eff(pushedPrice)});
      steps.push({label:'FINAL pushed price', math:'base $'+base+'  +  every ± above  =  the final pushed price'+((isGapActive&&live.minNights)?('  ·  min-stay '+live.minNights):''), value:'$'+pushedPrice, running:'$'+pushedPrice, final:true});
      steps.forEach((s,i)=>{ s.label=(i+1)+' · '+s.label; }); // sequential ledger numbering
      return res.status(200).json({
        unit:u.name, property_id:u.orp, date:ds, daytype:(isWe(new Date(ds+"T00:00:00Z"))?"weekend":"weekday"), booked,
        knobs:{GAIN:K.GAIN,STEP:K.STEP,wResort:K.wResort,wUnit:K.wUnit,lmMax:K.lmMax,lmWindow:K.lmWindow,lmSteep:K.lmSteep,gap1:K.gap1,gap2:K.gap2,gap3:K.gap3,gapWeekend:K.gapWeekend,floor:K.floor,ceil:K.ceil,saneMin:K.saneMin},
        signal:{ value:sigShown, priceLabsRaw:(sigRaw==null?null:sigRaw), override:ovOn?Number(signalOverride):null, source:ovOn?"flat override ($"+Number(signalOverride)+")":"PriceLabs" },
        premium:prem, base:base, peak:live.peak,
        glide:{ savedTarget:live.savedTarget, paceFrac:live.paceFrac, paceRef:live.ref, poolOcc:live.poolOcc, unitOcc:live.unitOcc, refTarget:live.ref, resortGap:live.resortGap, unitGap:live.unitGap, blendedGap:live.gap, wResort:K.wResort, wUnit:K.wUnit, desiredBaseMult:live.desiredBaseMult, gain:K.GAIN, step:K.STEP, desiredMult:live.desiredMult, appliedMult:live.appliedMult },
        lastMinute:{ window:K.lmWindow, lead:live.lead, max:K.lmMax, steep:K.lmSteep, lm:live.lm },
        gapNight:{ tier:withGap.gapTier||0, hasWeekend:withGap.gapHasWeekend||false, discPct:Math.round((withGap.gapDisc||0)*100), deeperOf:withGap.discSource, live:gapOn, appliedNow:isGapActive, ifEnabledPrice:withGap.amount, ifEnabledMinNights:withGap.minNights },
        clamp:{ floor:K.floor, ceil:ceil, saneMin:K.saneMin, gapExemptFromSaneMin:true },
        override:{ pinned:!!live.overridden, amount:live.overridden?live.amount:null },
        steps,
        final:{ price:pushedPrice, minNights:(isGapActive?live.minNights:null) }
      });
    }
    if(action==="get_knobs"){
      const k=await getKnobs();
      const pick=x=>({GAIN:x.GAIN,farDemand:x.farDemand,STEP:x.STEP,BAND_NEAR:x.BAND_NEAR,paceLength:x.paceLength,wResort:x.wResort,wUnit:x.wUnit,gap1:x.gap1,gap2:x.gap2,gap3:x.gap3,gapWeekend:x.gapWeekend,lmMax:x.lmMax,lmWindow:x.lmWindow,lmSteep:x.lmSteep,floor:x.floor,ceil:x.ceil,saneMin:x.saneMin});
      return res.status(200).json({knobs:pick(k), defaults:pick(DEFAULT_KNOBS), ranges:KNOB_RANGES, unitPremiums:UNIT_PREM});
    }
    if(action==="set_knobs"){
      if((req.headers["x-app-password"]||"")!==(process.env.APP_PASSWORD||"")) return res.status(401).json({error:"unauthorized"});
      let b=req.body; if(typeof b==="string"){try{b=JSON.parse(b);}catch{return res.status(400).json({error:"bad json"});}}
      if(b&&b.reset){ if(redis) await redis.del("parkside:knobs"); const k=await getKnobs(); return res.status(200).json({ok:true,reset:true,knobs:{GAIN:k.GAIN,STEP:k.STEP,BAND_NEAR:k.BAND_NEAR,wResort:k.wResort,wUnit:k.wUnit,gap1:k.gap1,gap2:k.gap2,gap3:k.gap3,gapWeekend:k.gapWeekend,lmMax:k.lmMax,lmWindow:k.lmWindow,lmSteep:k.lmSteep,floor:k.floor,ceil:k.ceil,saneMin:k.saneMin}}); }
      const cur=(redis&&await redis.get("parkside:knobs"))||{}; const next={...cur}; const errors=[]; const applied={};
      for(const key in KNOB_RANGES){ if(b&&b[key]!=null&&b[key]!==""){ let v=Number(b[key]); const rng=KNOB_RANGES[key];
        if(!isFinite(v)){ errors.push(key+": not a number"); continue; }
        if(rng[2]) v=Math.round(v);
        if(v<rng[0]||v>rng[1]){ errors.push(key+": must be "+rng[0]+"–"+rng[1]); continue; }
        next[key]=v; applied[key]=v; } }
      const eFloor=next.floor!=null?next.floor:DEFAULT_KNOBS.floor;
      if(next.ceil!=null&&next.ceil<eFloor) errors.push("ceil must be ≥ floor");
      if(next.saneMin!=null&&next.saneMin<eFloor) errors.push("saneMin must be ≥ floor");
      if(errors.length) return res.status(400).json({ok:false,errors});
      if(redis) await redis.set("parkside:knobs",next);
      const k=await getKnobs();
      return res.status(200).json({ok:true,applied,knobs:{GAIN:k.GAIN,STEP:k.STEP,BAND_NEAR:k.BAND_NEAR,wResort:k.wResort,wUnit:k.wUnit,gap1:k.gap1,gap2:k.gap2,gap3:k.gap3,gapWeekend:k.gapWeekend,lmMax:k.lmMax,lmWindow:k.lmWindow,lmSteep:k.lmSteep,floor:k.floor,ceil:k.ceil,saneMin:k.saneMin}});
    }
    if(action==="recommendations"){ // READ-ONLY: per-knob learning-recommended value vs current. NEVER applies anything.
      const g=await genRecommendations(today); return res.status(200).json({...g, adoptOnly:true});
    }
    if(action==="adopt_recommendation"){ // AUTH: sets ONLY the chosen knob(s) to their recommended value — explicit Gavin action.
      if((req.headers["x-app-password"]||"")!==(process.env.APP_PASSWORD||"")) return res.status(401).json({error:"unauthorized"});
      let b=req.body; if(typeof b==="string"){try{b=JSON.parse(b);}catch{b={};}}
      const recs=await genRecommendations(today); const map={}; for(const it of recs.items) map[it.knob]=it.recommended;
      const names = (b&&b.all) ? Object.keys(map) : (Array.isArray(b&&b.knobs)?b.knobs : (b&&b.knob?[b.knob]:[]));
      const cur=(redis&&await redis.get("parkside:knobs"))||{}; const applied=[];
      for(const key of names){ if(map[key]==null) continue; const r=KNOB_RANGES[key]; if(!r) continue; let v=Number(map[key]); if(!isFinite(v)) continue; if(r[2])v=Math.round(v); v=Math.max(r[0],Math.min(r[1],v)); const had=(cur[key]!=null?Number(cur[key]):Number(DEFAULT_KNOBS[key])); if(v!==had){ cur[key]=v; applied.push({knob:key,value:v}); } }
      if(applied.length && redis) await redis.set("parkside:knobs",cur); // writes ONLY the adopted knob(s)
      const k=await getKnobs();
      return res.status(200).json({ok:true, applied, knobs:{GAIN:k.GAIN,STEP:k.STEP,BAND_NEAR:k.BAND_NEAR,wResort:k.wResort,wUnit:k.wUnit,gap1:k.gap1,gap2:k.gap2,gap3:k.gap3,gapWeekend:k.gapWeekend,lmMax:k.lmMax,lmWindow:k.lmWindow,lmSteep:k.lmSteep,floor:k.floor,ceil:k.ceil,saneMin:k.saneMin}});
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
        +"You may be shown CONVERSATION SO FAR (earlier guest messages and replies we already sent) — use it for context (follow-ups, pronouns) and avoid repeating what we already told them; still answer ONLY from KNOWN INFO.\n"
        +"\n\nKNOWN INFO:\n"+(facts||"(none saved yet)");
      const _hist=await getThreadLog((b&&b.thread_id)||null, bookingId);
      const _convo=(Array.isArray(_hist)?_hist:[]).filter(m=>m&&m.b).slice(-12).map(m=>(m.d==="out"?"Us (already sent): ":"Guest: ")+String(m.b).replace(/\s+/g," ").trim()).join("\n");
      const _userContent=(_convo?("CONVERSATION SO FAR (oldest first):\n"+_convo+"\n\n"):"")+"Newest guest message (reply to THIS): "+String(question);
      try{
        const r=await fetch("https://api.anthropic.com/v1/messages",{method:"POST",headers:{"x-api-key":key,"anthropic-version":"2023-06-01","content-type":"application/json"},body:JSON.stringify({model:"claude-haiku-4-5-20251001",max_tokens:400,temperature:0,system:sys,messages:[{role:"user",content:_userContent}]})});
        const j=await r.json(); if(!r.ok) return res.status(200).json({error:"Anthropic API error",detail:JSON.stringify(j).slice(0,300)});
        let text=((j.content&&j.content[0]&&j.content[0].text)||"").trim();
        let inKb=false, answer="";
        try{ const m=text.match(/\{[\s\S]*\}/); const o=JSON.parse(m?m[0]:text); inKb=o.in_kb===true; answer=String(o.answer||"").trim(); }catch{ inKb=false; answer=""; }
        if(!inKb || !answer){
          const victorSms=await smsVictor(enabled, "Parkside escalation — guest asked: "+String(question).slice(0,300)+(bookingId?(" (booking "+bookingId+")"):""));
          const guestSend=await sendGuestReply(enabled, {bookingId}, APOLOGY);
          return res.status(200).json({escalate:true, escalatedTo:"Victor", draft:APOLOGY, victorSms, guestSend, sent:guestSend.sent===true});
        }
        const guestSend=await sendGuestReply(enabled, {bookingId}, answer);
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
      try{ await maybePollMessages(req); }catch(e){}
      const _haveAuth = !!(orBasicHeader() || (await orOauthHeader()));
      if(!_haveAuth) return res.status(200).json({configured:false, bookings:[], error:"OwnerRez credentials not set (OwnerRez OAuth token in Victor\u2019s card, or OWNERREZ_OAUTH_TOKEN / OWNERREZ_API_USER + OWNERREZ_API_TOKEN)"});
      const fresh=req.query&&req.query.fresh==="1";
      if(redis&&!fresh){ const c=await redis.get("parkside:bookings"); if(c&&(Date.now()-c.ts)<300000) return res.status(200).json({configured:true, cached:true, count:(c.list||[]).length, bookings:c.list}); }
      const ymd=d=>d.toISOString().slice(0,10);
      const now=new Date(); const from=new Date(now); from.setUTCDate(from.getUTCDate()-14); const to=new Date(now); to.setUTCDate(to.getUTCDate()+365);
      const pids=UNITS.map(u=>u.orp).join(",");
      const HBASE={"Content-Type":"application/json","User-Agent":"parkside-control/1.0"};
      let url="https://api.ownerrez.com/v2/bookings?property_ids="+encodeURIComponent(pids)+"&from="+ymd(from)+"&to="+ymd(to)+"&include_agreements=true&limit=50";
      let items=[], pages=0;
      try{ while(url&&pages<30){ const r=await orFetch(url,{headers:HBASE, prefer:"basic"}); if(!r||!r.ok){ const t=r?await r.text():""; 
            return res.status(200).json({configured:true, bookings:[], error:"OwnerRez bookings "+(r?r.status:"no-response"), detail:t.slice(0,200), note:"tried Basic PAT + OAuth; both rejected for /v2/bookings"}); }
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
        const r=await withTimeout(orFetch("https://api.ownerrez.com/v2/guests/"+gid,{headers:HBASE, prefer:"basic"}), 4000);
        if(r&&r.ok){ const gj=await withTimeout(r.json(),2000); if(gj) guests[gid]=gj; }
      }catch(e){} }));
      const gName=g=>{ if(!g) return ""; const n=((g.first_name||"")+" "+(g.last_name||"")).trim(); return n||g.name||""; };
      const gEmail=g=>{ if(!g) return ""; if(Array.isArray(g.email_addresses)&&g.email_addresses.length){ const e=g.email_addresses.find(x=>x.is_default)||g.email_addresses[0]; return e.address||e.email||""; } if(Array.isArray(g.emails)&&g.emails.length){ const e=g.emails[0]; return (typeof e==="string")?e:(e.address||""); } return g.email||""; };
      const gPhone=g=>{ if(!g) return ""; if(Array.isArray(g.phones)&&g.phones.length){ const p=g.phones.find(x=>x.is_default)||g.phones[0]; return p.number||p.phone||""; } return g.phone||""; };
      const list=(items||[]).map(b=>{ const g=guests[gidOf(b)];
          const unit=(b.property&&b.property.name)||unitName[b.property_id]||String(b.property_id||"");
          const _ags=Array.isArray(b.agreements)?b.agreements:[];
          return { arrival:b.arrival||"", departure:b.departure||"",
            name:gName(g), email:gEmail(g), phone:gPhone(g),
            reference:b.title||"", unit, status:b.status||b.type||"",
            agreementSigned: !!_ags.find(function(a){return a&&a.date;}) }; })
        .filter(x=>x.arrival);
      const totalBeforeFilter=list.length;
      // Only show real, live reservations — drop cancelled / void / declined / removed / inactive.
      const isLive=x=>!/cancel|void|declin|remov|inactive|expired/i.test(String(x.status||"").toLowerCase());
      const liveList=list.filter(isLive);
      // "Today" in the property's local tz (America/New_York) so UTC roll-over never
      // drops a booking a day early. Drop anything whose checkout was 2+ days ago.
      const etTodayStr=new Intl.DateTimeFormat("en-CA",{timeZone:"America/New_York"}).format(new Date()); // YYYY-MM-DD
      const tod=etTodayStr;
      const cutoffD=new Date(etTodayStr+"T00:00:00Z"); cutoffD.setUTCDate(cutoffD.getUTCDate()-2);
      const cutoffStr=cutoffD.toISOString().slice(0,10); // today - 2 days (ET)
      const recentOrFuture=liveList.filter(x=>(x.departure||x.arrival)>=cutoffStr);
      const droppedPast=liveList.length-recentOrFuture.length;
      const upcoming=recentOrFuture.filter(x=>(x.departure||x.arrival)>=tod).sort((a,b)=>a.arrival<b.arrival?-1:(a.arrival>b.arrival?1:0));
      const past=recentOrFuture.filter(x=>(x.departure||x.arrival)<tod).sort((a,b)=>a.arrival>b.arrival?-1:(a.arrival<b.arrival?1:0));
      const out=upcoming.concat(past);
      if(redis) await redis.set("parkside:bookings",{ts:Date.now(),list:out});
      return res.status(200).json({configured:true, count:out.length, totalBeforeFilter, excludedCancelled:totalBeforeFilter-liveList.length, droppedPast, cutoff:cutoffStr, bookings:out});
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
    // ===== OwnerRez inbound intake -> approval pipeline =====
    // Helper: does a message look like an INBOUND guest message (not our own outbound)?
    // (Defensive across possible OwnerRez shapes; tune once a live channel exists.)
    // Polling cron: pull recent OwnerRez messages and feed new guest ones into the pipeline.
    if(action==="poll_messages"){
      const tok=String((req.query&&req.query.token)||""); const secret=(await getNotifyConfig()).secret;
      const okAuth=((req.headers["authorization"]||"")==="Bearer "+(process.env.CRON_SECRET||"__x"))
        || ((req.headers["x-app-password"]||"")===(process.env.APP_PASSWORD||"__x"))
        || (!!secret && tok===secret);
      if(!okAuth) return res.status(401).json({error:"unauthorized"});
      const out=await runPollMessages(req);
      const esc=await escalateStaleApprovals(req);
      const autorej=await autoRejectStaleApprovals(req);
      let verify=null; try{ verify=await runVictorVerifyReminder(new Date().toISOString()); }catch(e){ verify={error:String(e.message||e)}; }
      return res.status(200).json(Object.assign(out||{}, {escalation:esc, autoReject:autorej, verifyReminder:verify}));
    }
    // PUBLIC plan-free heartbeat: hit by an external free cron (cron-job.org/UptimeRobot)
    // or by page loads. Token-gated by the approve-link secret. Drives intake without
    // a Vercel paid plan / Vercel cron.
    // Plan-independent heartbeat for the 60-min backup escalation. SAFE to call unauthenticated: it only runs the
    // idempotent sweep (one-shot per item via the parkside:backup_ask lock; emails ONLY the configured backup
    // contact to2) plus the 24h auto-reject — no attacker-controllable side effects, same work notify_status already
    // does. A GitHub Actions cron (.github/workflows/escalation-heartbeat.yml) hits this every ~5 min so the backup
    // email auto-sends shortly after escalateMins even with NO new inbound, NO dashboard open, and regardless of
    // whether the Vercel cron runs on the current plan.
    if(action==="esc_debug"){
      // READ-ONLY diagnostic: evaluate every escalated/pending item against the backup-email guards WITHOUT mutating.
      // Redacted (short question snippet only; no guest name/phone). Temporary — safe to call unauthenticated.
      res.setHeader("Cache-Control","no-store, max-age=0");
      const cfg=await getNotifyConfig();
      const now=Date.now();
      const windowMs=(cfg.escalateMins||60)*60*1000;
      const maxAgeMs=Math.max(3*3600*1000, windowMs+3600*1000);
      const cutoff=now-windowMs;
      const list=await getApprovals();
      const rows=[];
      for(const it of list){
        if(!it) continue;
        if(it.status!=="escalated" && it.status!=="pending") continue;
        const t=Date.parse(it.primaryNotifiedAt||it.ts||"");
        const ageMin=isFinite(t)?Math.round((now-t)/60000):null;
        let handled=false, outAfter=null;
        try{ const _log=await getThreadLog(it.thread_id, it.booking_id);
          const _ht=Date.parse(it.primaryNotifiedAt||it.ts||"")||0;
          if(_ht){ for(const m of (_log||[])){ if(m && m.d==="out"){ const _mt=Date.parse(m.t||"")||0; if(_mt && _mt>_ht+120000){ handled=true; outAfter=m.t; break; } } } }
        }catch(e){}
        let verdict="ELIGIBLE (would email)";
        if(it.status!=="escalated") verdict="skip: status="+it.status+" (not escalated)";
        else if(!isFinite(t)) verdict="skip: no parseable timestamp";
        else if((now-t)>maxAgeMs) verdict="skip: NEUTRALIZED stale (age "+ageMin+"m > maxAge "+Math.round(maxAgeMs/60000)+"m)";
        else if(it.backupAskSent) verdict="skip: backupAskSent=true (already asked / stamped)";
        else if(t>cutoff) verdict="skip: not past timer yet (age "+ageMin+"m < "+cfg.escalateMins+"m)";
        else if(handled) verdict="skip: already-replied (out msg after +2m)";
        rows.push({ id:it.id, label:it.smsLabel||null, status:it.status, q:String(it.question||it.firstQuestion||"").slice(0,80),
          ts:it.ts||null, primaryNotifiedAt:it.primaryNotifiedAt||null, revisedAt:it.revisedAt||null, decidedAt:it.decidedAt||null,
          ageMin:ageMin, backupAskSent:!!it.backupAskSent, escalatedTo2:!!it.escalatedTo2, escalatedTo2Sent:!!it.escalatedTo2Sent,
          backupSkippedStale:!!it.backupSkippedStale, backupSkippedHandled:!!it.backupSkippedHandled,
          closedExternally:!!it.closedExternally, handledByReply:handled, outAfter:outAfter, verdict:verdict });
      }
      return res.status(200).json({ now:new Date(now).toISOString(), escalateMins:cfg.escalateMins, windowMin:Math.round(windowMs/60000),
        maxAgeMin:Math.round(maxAgeMs/60000), to2Set:!!cfg.to2, resendConfigured:!!(cfg.apiKey&&cfg.from), count:rows.length, items:rows.slice(-25) });
    }
    if(action==="run_escalations"){
      res.setHeader("Cache-Control","no-store, max-age=0");
      let _esc=null, _autorej=null;
      try{ _esc=await escalateStaleApprovals(req); }catch(e){ _esc={error:String(e&&e.message||e)}; }
      try{ _autorej=await autoRejectStaleApprovals(req); }catch(e){ _autorej={error:String(e&&e.message||e)}; }
      let _verify=null; try{ _verify=await runVictorVerifyReminder(new Date().toISOString()); }catch(e){ _verify={error:String(e&&e.message||e)}; }
      return res.status(200).json({ok:true, ranAt:new Date().toISOString(), escalation:_esc, autoReject:_autorej, verifyReminder:_verify});
    }
    if(action==="tick"){
      const tok=String((req.query&&req.query.token)||""); const secret=(await getNotifyConfig()).secret;
      if(!secret || tok!==secret) return res.status(403).json({error:"bad or missing token"});
      const out=await maybePollMessages(req);
      const esc=await escalateStaleApprovals(req);
      const autorej=await autoRejectStaleApprovals(req);
      return res.status(200).json(Object.assign(out||{skipped:true, reason:"throttled (<60s since last poll)", lastPoll:await getPollStatus()}, {escalation:esc, autoReject:autorej}));
    }
    // Webhook intake: OwnerRez (or any source) POSTs an inbound message here.
    // URL: /api/app?action=or_message_inbound&token=<APPROVE_LINK_SECRET>
    if(action==="or_message_inbound"){
      // OwnerRez webhook receiver. Auth = HTTP Basic (User/Password set in the OAuth
      // app Webhooks section, matching Victor\u2019s card). ?token=<approve secret> also allowed.
      // Auth is RELAXED: OwnerRez sets a webhook password we can't control, so instead of
      // matching basic-auth we accept any well-formed OwnerRez webhook payload
      // (body has action + entity_type, and normally user_id). We learn the owner's
      // user_id from the first webhook and prefer it going forward, but don't reject on it
      // yet. ?token=<approve secret> still always accepted. Garbage/empty bodies are rejected.
      let b=req.body; if(typeof b==="string"){ try{b=JSON.parse(b);}catch{ try{b=Object.fromEntries(new URLSearchParams(b));}catch{b={};} } } b=b||{};
      const act=String(b.action||"").toLowerCase();
      const etype=String(b.entity_type||"").toLowerCase();
      const wellFormed = !!act && !!etype; // looks like an OwnerRez webhook
      const secret=(await getNotifyConfig()).secret; const tok=String((req.query&&req.query.token)||"");
      const tokenOk = !!secret && tok===secret;
      if(!wellFormed && !tokenOk){ return res.status(400).json({error:"empty or non-OwnerRez payload (need action + entity_type)"}); }
      // Learn + remember the OwnerRez user_id (first seen wins; informational, not enforced).
      try{ if(b.user_id!=null){ const raw=await getNotifyRaw(); if(!raw.ownerrez_user_id){ raw.ownerrez_user_id=String(b.user_id); await setNotifyRaw(raw); } } }catch(e){}

      // OwnerRez "Send a Test Webhook" -> action=webhook_test, entity_type=api_application
      if(act==="webhook_test" || etype==="api_application"){
        await writeWhStatus({ranAt:new Date().toISOString(), event:"webhook_test", ok:true});
        return res.status(200).json({ok:true, test:true});
      }
      // We handle guest messages (thread_message) AND pre-booking inquiries (inquiry).
      if(etype!=="thread_message" && etype!=="inquiry"){ await writeWhStatus({ranAt:new Date().toISOString(), event:"ignored", entity_type:etype}); return res.status(200).json({ok:true, ignored:"entity_type "+etype}); }
      // item A: DRIVE the 60-minute backup escalation from live inbound traffic. The sweep is also on the
      // poll_messages cron, but that cron may not fire on the current plan; running it here guarantees that a
      // still-unanswered escalation reaches the configured backup/front-desk contact (victorEmail2) within one
      // inbound webhook of the 60-min mark. escalateStaleApprovals is idempotent (marks escalatedTo2) so it
      // never double-sends. Non-fatal.
      try{ await escalateStaleApprovals(req); }catch(e){}

      // De-dupe by payload id (mark seen BEFORE processing so retries skip).
      const pid=String(b.id||b.entity_id||"");
      const seenArr=(redis&&await redis.get("parkside:wh_seen"))||[]; const seen=new Set(seenArr);
      if(pid && seen.has(pid)) return res.status(200).json({ok:true, dedup:true});
      if(pid){ seen.add(pid); if(redis) await redis.set("parkside:wh_seen", Array.from(seen).slice(-5000)); }

      const e=(b.entity&&typeof b.entity==="object")?b.entity:{};
      const g=(e.guest&&typeof e.guest==="object")?e.guest:{};
      const nameFrom=()=>String(e.guest_name||e.guestName||e.from_name||((g.first_name||"")+" "+(g.last_name||"")).trim()||g.name||"").trim();
      const _threadRaw=e.thread_id||e.threadId||e.thread||(g&&g.thread_id)||null;
      const threadId=(_threadRaw&&typeof _threadRaw==="object")?(_threadRaw.id||_threadRaw.thread_id||null):_threadRaw;
      const bookingId=e.booking_id||e.bookingId||null;

      if(etype==="inquiry"){
        // Pre-booking guest question. Always inbound (guest -> host); no loop risk.
        const guestName=nameFrom();
        const guestEmail=String(e.email||e.email_address||g.email||(Array.isArray(g.email_addresses)&&g.email_addresses[0]&&(g.email_addresses[0].address||g.email_addresses[0]))||"").trim();
        const arrival=String(e.arrival||e.check_in||e.checkin||e.arrival_date||"").trim();
        const departure=String(e.departure||e.check_out||e.checkout||e.departure_date||"").trim();
        let question=String(e.message||e.notes||e.comments||e.body||e.content||e.text||e.question||e.guest_message||"").trim();
        const hadMessage=!!question;
        // item #2 (SCOPED so it can NEVER drop real content): a NO-MESSAGE inquiry (availability ping with no
        // question text) gets ONE short greeting and never escalates. The 30-min de-dupe is applied ONLY to these
        // CONTENTLESS pings (OwnerRez fires several per inquiry). A message-bearing inquiry is NEVER de-duped on
        // content — it always falls through to processGuestQuestion (exact webhook retries are already caught by
        // the payload-id parkside:wh_seen guard above).
        if(!hadMessage){
          const _ikey = threadId?("t:"+threadId):(bookingId?("b:"+bookingId):("g:"+String(guestName||guestEmail||pid||"").toLowerCase().replace(/[^a-z0-9]/g,"").slice(0,40)));
          try{ if(redis && _ikey){ const _last=await redis.get("parkside:inq_seen:"+_ikey); if(_last && (Date.now()-new Date(_last).getTime()) < 30*60*1000){ return res.status(200).json({ok:true, type:"inquiry", deduped:true, contentless:true, skipped:"repeat no-message inquiry within 30m for "+_ikey}); } await redis.set("parkside:inq_seen:"+_ikey, new Date().toISOString(), {ex:6*3600}); } }catch(e){}
          const _st=await getState(); const _enabled=!!_st.messaging_enabled;
          const _greet=firstContactGreeting(guestName);
          let _gs={sent:false}; try{ _gs=await sendGuestReply(_enabled, {threadId, bookingId}, _greet); if(threadId||bookingId) await appendThreadLog(threadId, bookingId, "out", _greet, ""); }catch(e){}
          await writeWhStatus({ranAt:new Date().toISOString(), event:"inquiry", action:act, entity_id:b.entity_id, note:"no-message inquiry -> short greeting (contentless pings de-duped), no escalation", hadMessage:false, arrival, departure});
          return res.status(200).json({ok:true, type:"inquiry", greeted:true, sent:(_gs.sent===true), no_escalation:true});
        }
        await writeWhStatus({ranAt:new Date().toISOString(), event:"inquiry", action:act, entity_id:b.entity_id, entityKeys:Object.keys(e),
          guestKeys: Object.keys(g), hasThread: !!threadId, propertyId: e.property_id||e.listing_id||null, hadMessage, msgLen: question.length, arrival, departure});
        try{ const out=await processGuestQuestion(req,{question, threadId, bookingId, guestName, unit:String(e.property_id||e.listing_id||""), source:"ownerrez_inquiry"});
          return res.status(200).json({ok:true, processed:true, type:"inquiry", hadMessage, auto_approved:!!out.auto_approved, queued:!!out.queued, emailed:!!(out.victorEmail&&out.victorEmail.sent), emailReason:out.victorEmail&&(out.victorEmail.reason||out.victorEmail.detail||null), replyThread:!!threadId, guestEmail:guestEmail||null}); }
        catch(err){ return res.status(200).json({ok:true, processed:false, type:"inquiry", error:String(err&&err.message||err)}); }
      }

      // thread_message direction is determined by OwnerRez's from_role + is_draft.
      // INBOUND (process)  = guest/traveler. OUTBOUND (ignore) = host/owner/pm/etc.
      // Drafts and our own outbound replies (from_role=host) are ignored -> no reply loop.
      const role=String(e.from_role||"").toLowerCase().trim();
      const isDraft = e.is_draft===true || e.is_draft==="true";
      const inboundRole = /guest|travel|renter|customer|inquir/.test(role);
      const direction = isDraft ? "draft" : (inboundRole ? "inbound" : (role ? "outbound" : "unknown"));
      await writeWhStatus({ranAt:new Date().toISOString(), event:"thread_message", action:act, entity_id:b.entity_id, entityKeys:Object.keys(e),
        dir:{from_role:e.from_role, from_contact_id:e.from_contact_id, is_draft:e.is_draft, resolved:direction}});

      const msgBody=String(e.body||e.message||e.content||e.text||"").trim();
      if(isDraft) return res.status(200).json({ok:true, ignored:"draft"});
      if(!inboundRole){
        // Outbound on this thread — either the ENGINE's own send (OwnerRez echoes it back to us) OR a HUMAN
        // replying to the guest directly in OwnerRez (front desk / owner). Log it; and if it is a human reply
        // (NOT an echo of a message the engine already sent), CLOSE any open escalation/approval on this thread
        // so a later "Q# yes"/fact from Victor can NEVER send the guest a SECOND message. Single resolution
        // across the Victor <-> front-desk boundary. We only close items older than 60s so the engine's own
        // holding-message echo (which arrives seconds after we open the escalation) can never self-close it.
        let closedExternally=[];
        try{
          const _norm=function(x){ return String(x||"").replace(/\s+/g," ").trim(); };
          const _nb=_norm(msgBody);
          const _log=await getThreadLog(threadId, bookingId);
          const _engineSent = !!_nb && _log.some(function(m){ return m && m.d==="out" && _norm(m.b)===_nb; });
          if(role && msgBody) await appendThreadLog(threadId, bookingId, "out", msgBody, "");
          if(_nb && !_engineSent && (threadId||bookingId)){
            const _al=await getApprovals(); let _ch=false; const _cut=Date.now()-60000;
            for(const it of _al){ if(!it) continue;
              if((it.status==="pending"||it.status==="escalated")
                 && ((threadId&&it.thread_id===threadId)||(bookingId&&String(it.booking_id)===String(bookingId)))
                 && (Date.parse(it.primaryNotifiedAt||it.ts||"")||0) < _cut){
                it.status="closed"; it.decidedAt=new Date().toISOString(); it.closedExternally=true; it.closedBy=String(e.from_role||"staff"); it.externalReply=_nb.slice(0,300);
                _ch=true; closedExternally.push(it.smsLabel||it.id);
              }
            }
            if(_ch) await setApprovals(_al);
          }
        }catch(e2){}
        return res.status(200).json({ok:true, logged_outbound:!!(role&&msgBody), closedExternally:closedExternally, ignored_for_reply:"from_role="+(e.from_role||"")});
      }

      const question=msgBody;
      if(!question) return res.status(200).json({ok:true, ignored:"no text"});
      const guestName=nameFrom();
      try{ const out=await processGuestQuestion(req,{question, threadId, bookingId, guestName, unit:"", source:"ownerrez_webhook"});
        const mode=out.auto_answered?"auto_answered":(out.escalated?"escalated":(out.no_response_needed?"no_response":(out.queued?"queued":"?")));
        return res.status(200).json({ok:true, processed:true, type:"thread_message", mode, sent:(out.sent===true||out.holding_sent===true), id:out.id||null}); }
      catch(err){ return res.status(200).json({ok:true, processed:false, error:String(err&&err.message||err)}); }
    }
    // View the approved bank (password) — the high-weight, physically-approved Q&A.
    if(action==="approved_bank"){
      if((req.headers["x-app-password"]||"")!==(process.env.APP_PASSWORD||"")) return res.status(401).json({error:"unauthorized"});
      const bank=await getApprovedBank();
      return res.status(200).json({count:bank.length, items:bank.slice(-200).reverse()});
    }
    // Prune a bad approved answer. Auth: x-app-password OR ?token=<approve secret>.
    // Target (query or body): id | ts | q (normalized match) | default = latest.
    if(action==="delete_approved"){
      const secret=(await getNotifyConfig()).secret; const tok=String((req.query&&req.query.token)||"");
      const pwOk=(req.headers["x-app-password"]||"")===(process.env.APP_PASSWORD||"");
      if(!pwOk && !(secret && tok===secret)) return res.status(401).json({error:"unauthorized"});
      let b=req.body; if(typeof b==="string"){try{b=JSON.parse(b);}catch{b={};}} b=b||{};
      const q=req.query||{};
      const byId=String(b.id||q.id||""); const byTs=String(b.ts||q.ts||""); const byQ=String(b.q||q.q||"");
      const bank=await getApprovedBank();
      if(!bank.length) return res.status(200).json({ok:true, deleted:null, approvedBankCount:0, note:"bank empty"});
      let idx=-1;
      if(byId) idx=bank.findIndex(e=>String(e.id||"")===byId);
      else if(byTs) idx=bank.findIndex(e=>String(e.ts||"")===byTs);
      else if(byQ) idx=bank.findIndex(e=>normQ(e.q)===normQ(byQ));
      else idx=bank.length-1; // latest (entries are appended)
      if(idx<0) return res.status(200).json({ok:false, error:"no matching approved entry", approvedBankCount:bank.length});
      const removed=bank.splice(idx,1)[0];
      await setApprovedBank(bank);
      // Also remove the mirrored editable-KB item (topic = question.slice(0,60)).
      let kbRemoved=0;
      try{ const st=await getState(); const kb=st.kb||{items:[]}; kb.items=kb.items||[];
        const target=normQ(String(removed.q||"").slice(0,60));
        const before=kb.items.length;
        kb.items=kb.items.filter(x=>normQ(String(x.topic||""))!==target);
        kbRemoved=before-kb.items.length; if(kbRemoved) await setState({kb}); }catch(e){}
      return res.status(200).json({ok:true, deleted:{id:removed.id||null, ts:removed.ts||null, qPreview:String(removed.q||"").slice(0,80)}, kbMirrorRemoved:kbRemoved, approvedBankCount:bank.length});
    }

    if(action==="ask"){
      if((req.headers["x-app-password"]||"")!==(process.env.APP_PASSWORD||"")) return res.status(401).json({error:"unauthorized"});
      let b=req.body; if(typeof b==="string"){try{b=JSON.parse(b);}catch{b={};}} b=b||{};
      const question=String(b.question||"").trim();
      if(!question) return res.status(400).json({error:"no question"});
      const out=await processGuestQuestion(req, {question, bookingId:b.booking_id||null,
        unit:String(b.unit||"").trim(), guestName:String(b.guest_name||b.guestName||"").trim(), source:"manual"});
      return res.status(out.error?400:200).json(out);
    }
    // VICTOR'S: view the approval queue (password). ?status=pending|approved|rejected|all
    // ===== Message Audit (READ-ONLY diagnostic) — expose the guest history that already lives in Redis.
    // Gated app-or-gavin (same staff scheme as timeoff). NO writes/deletes anywhere in these handlers.
    // `threads`: list parkside:thr:* keys; ?key=<k> returns that thread's stored two-way messages.
    if(action==="threads"){
      if((req.headers["x-app-password"]||"")!==(process.env.APP_PASSWORD||"__y") && (req.headers["x-gavin-password"]||"")!==(process.env.GAVIN_PASSWORD||"__x")) return res.status(401).json({error:"unauthorized"});
      if(!redis) return res.status(200).json({keys:[], count:0});
      const key=String((req.query&&req.query.key)||"").trim();
      if(key){
        const safe=key.replace(/^parkside:thr:/,"");
        let msgs=[]; try{ msgs=(await redis.get("parkside:thr:"+safe))||[]; }catch(e){ msgs=[]; }
        if(!Array.isArray(msgs)) msgs=[];
        return res.status(200).json({key:safe, messages:msgs.map(function(m){ return {dir:m.d, body:m.b, at:m.t, name:m.n}; })});
      }
      let keys=[]; try{ keys=(await redis.keys("parkside:thr:*"))||[]; }catch(e){ keys=[]; }
      keys=keys.map(function(k){ return String(k).replace(/^parkside:thr:/,""); });
      return res.status(200).json({keys, count:keys.length});
    }
    // `msg_audit`: reconstruct the past ?days (default 10) of guest interactions by joining each
    // parkside:approvals item to its parkside:thr:<key> transcript (by thread/booking). Newest first.
    if(action==="msg_audit"){
      if((req.headers["x-app-password"]||"")!==(process.env.APP_PASSWORD||"__y") && (req.headers["x-gavin-password"]||"")!==(process.env.GAVIN_PASSWORD||"__x")) return res.status(401).json({error:"unauthorized"});
      const days=Math.max(1, Math.min(60, Number((req.query&&req.query.days))||10));
      const since=Date.now()-days*86400000;
      const list=await getApprovals();
      const atMs=function(it){ const cs=[it&&it.decidedAt, it&&it.revisedAt, it&&it.ts, it&&it.primaryNotifiedAt]; for(const x of cs){ const t=x?new Date(x).getTime():NaN; if(isFinite(t)) return t; } return 0; };
      const byThread={};
      for(const it of (list||[])){ if(!it) continue; if(atMs(it)<since) continue;
        const tkey=threadKey(it.thread_id, it.booking_id)||("id:"+it.id);
        (byThread[tkey]=byThread[tkey]||[]).push(it); }
      const cards=[];
      for(const tkey in byThread){
        const items=byThread[tkey].slice().sort(function(a,b){ return new Date(a.ts||0)-new Date(b.ts||0); });
        const first=items[0]||{};
        let transcript=[]; try{ if(first && (first.thread_id||first.booking_id)) transcript=await getThreadLog(first.thread_id, first.booking_id); }catch(e){}
        const questions=items.map(function(it){ return {
          id:it.id, question:it.question||"",
          draft:it.firstProposed||it.proposed||"",
          revised_draft:(it.proposed && it.proposed!==it.firstProposed)?it.proposed:null,
          escalated:(!!it.escalate)||it.status==="escalated",
          complaint:!!it.complaint,
          fact_from_victor:(it.factFromVictor!=null && String(it.factFromVictor).trim())?String(it.factFromVictor):null,
          status:it.status||"", source:it.source||null, sms_label:it.smsLabel||null,
          created_at:it.ts||null, decided_at:it.decidedAt||null, revised_at:it.revisedAt||null,
          reject_reason:it.rejectReason||null, auto_rejected:!!it.autoRejected,
          final_answer:(it.answer!=null && String(it.answer).trim())?String(it.answer):null
        }; });
        cards.push({
          thread_key:tkey, guest_name:(first.guest_name)||"", unit:(first.unit)||"",
          booking_id:(first.booking_id)||null, thread_id:(first.thread_id)||null,
          last_activity:Math.max.apply(null, items.map(atMs)),
          transcript:(transcript||[]).map(function(m){ return {dir:m.d, body:m.b, at:m.t, name:m.n}; }),
          questions:questions
        });
      }
      cards.sort(function(a,b){ return (b.last_activity||0)-(a.last_activity||0); });
      return res.status(200).json({days, count:cards.length, cards});
    }
    if(action==="approvals"){
      if((req.headers["x-app-password"]||"")!==(process.env.APP_PASSWORD||"")) return res.status(401).json({error:"unauthorized"});
      const list=await getApprovals(); const status=(req.query&&req.query.status)||"pending";
      const out=status==="all"?list:list.filter(x=>x.status===status);
      return res.status(200).json({approvals:out.slice(-200).reverse(), counts:{pending:list.filter(x=>x.status==="pending").length, approved:list.filter(x=>x.status==="approved").length, rejected:list.filter(x=>x.status==="rejected").length}});
    }
    // Add/edit the WHY for a rejected item after the fact (teaches the assistant — feeds aiDraftAnswer's PAST REJECTIONS).
    if(action==="set_reject_reason"){
      if((req.headers["x-app-password"]||"")!==(process.env.APP_PASSWORD||"")) return res.status(401).json({error:"unauthorized"});
      let b=req.body; if(typeof b==="string"){try{b=JSON.parse(b);}catch{b={};}} b=b||{};
      const id=String(b.id||""); const reason=String(b.reason||"").slice(0,500).trim();
      const list=await getApprovals(); const it=list.find(x=>x.id===id);
      if(!it) return res.status(404).json({error:"item not found"});
      it.rejectReason=reason; await setApprovals(list);
      try{ const rk=(redis?(await redis.get("parkside:kb_rejected")):_memRejected)||[]; const r=rk.find(x=>x.id===id);
        if(r){ r.reason=reason; } else { rk.push({id:it.id,q:it.question,draft:it.proposed||"",reason:reason,source:it.source||null,ts:new Date().toISOString()}); }
        const t=rk.slice(-500); if(redis) await redis.set("parkside:kb_rejected",t); else _memRejected=t; }catch(e){}
      return res.status(200).json({ok:true, id, reason});
    }
    // Edit & send: a tiny mobile page to write/correct the reply, then send THAT.
    // Auth: x-app-password OR ?token=<approve secret>.
    if(action==="edit_approval"){
      res.setHeader("Content-Type","text/html; charset=utf-8");
      const q=req.query||{}; const secret=(await getNotifyConfig()).secret;
      const pwOk=((req.headers||{})["x-app-password"]||"")===(process.env.APP_PASSWORD||"");
      const tok=String(q.token||"");
      if(!pwOk && !(secret && tok===secret)){ res.statusCode=403; return res.end(htmlPage("Link error","This edit link is invalid or expired.")); }
      const id=String(q.id||"");
      const list=await getApprovals(); const it=list.find(x=>x.id===id);
      if(req.method==="POST"){
        let b=req.body; if(typeof b==="string"){ try{b=JSON.parse(b);}catch{ try{b=Object.fromEntries(new URLSearchParams(b));}catch{b={};} } } b=b||{};
        const answer=String(b.answer||"").trim();
        if(!it){ res.statusCode=200; return res.end(htmlPage("Not found","This request was not found (it may already be handled).")); }
        if(it.status!=="pending"){ res.statusCode=200; return res.end(htmlPage("Already "+it.status+" ✓", "This request was already "+it.status+", most likely by the other recipient. The guest was not messaged twice — nothing was changed.")); }
        if(!answer){ res.statusCode=200; return res.end(editPageHtml(it, tok, it.unit, it.guest_name, "Please enter a reply before sending.")); }
        const out=await decideApproval(id, "yes", answer); // sends owner's edited text + learns it into the approved bank/KB
        if(out.ok && out.decision==="approved"){ res.statusCode=200; return res.end(htmlPage("Sent \u2713", "Your reply was sent to the guest and saved so similar questions suggest it next time.")); }
        res.statusCode=200; return res.end(htmlPage("Couldn\u2019t send", (out.error||"Unknown error")+".")); }
      // GET -> render editor
      if(!it){ res.statusCode=200; return res.end(htmlPage("Not found","This request was not found (it may already be handled).")); }
      if(it.status!=="pending"){ res.statusCode=200; return res.end(htmlPage("Already "+it.status+" ✓", "This request was already "+it.status+", most likely by the other recipient. The guest was not messaged twice.")); }
      res.statusCode=200; return res.end(editPageHtml(it, tok, it.unit, it.guest_name, ""));
    }
    // item RES: reservations/front-desk FACT SUPPLY. GET -> fact form; POST step=draft -> model composes the
    // reply and shows it for review; POST step=send -> sends via decideApproval (single-resolution lock).
    if(action==="supply_fact"){
      res.setHeader("Content-Type","text/html; charset=utf-8");
      const q=req.query||{}; const secret=(await getNotifyConfig()).secret;
      const pwOk=((req.headers||{})["x-app-password"]||"")===(process.env.APP_PASSWORD||"");
      const tok=String(q.token||"");
      if(!pwOk && !(secret && tok===secret)){ res.statusCode=403; return res.end(htmlPage("Link error","This link is invalid or expired.")); }
      const id=String(q.id||"");
      const list=await getApprovals(); const it=list.find(x=>x.id===id);
      if(!it){ res.statusCode=200; return res.end(htmlPage("Not found","This request was not found (it may already be handled).")); }
      if(it.status && it.status!=="pending" && it.status!=="escalated"){ res.statusCode=200; return res.end(htmlPage("Already handled ✓","This guest question was already handled ("+escHtml(it.status)+(it.closedExternally?", the front desk answered the guest directly":"")+"). The guest was not messaged twice.")); }
      if(req.method==="POST"){
        let b=req.body; if(typeof b==="string"){ try{b=JSON.parse(b);}catch{ try{b=Object.fromEntries(new URLSearchParams(b));}catch{b={};} } } b=b||{};
        const fact=String(b.fact||"").trim();
        if(!fact){ res.statusCode=200; return res.end(supplyFactFormHtml(it, tok, "Please enter the answer / fact first.")); }
        // STEP 1 (mirrors Victor's SMS flow exactly): capture ONLY the fact. The model composes the guest reply and
        // the item is re-staged to 'pending' (reviseFromSms). NOTHING is sent to the guest here. We then email a
        // FRESH approval email (composed reply + Approve & Send) — the ACTUAL send happens when they approve THAT
        // second email, routed through decideApproval (single-resolution lock). Reservations never sees the draft
        // on this page; it comes back as its own email, exactly like the engine texting Victor the draft to approve.
        let rev=null; try{ rev=await reviseFromSms(req, it, fact); }catch(e){ rev={failed:true}; }
        if(rev && rev.alreadyHandled){ res.statusCode=200; return res.end(htmlPage("Already handled ✓","This was already handled by someone else. The guest was not messaged twice.")); }
        const draft=(rev && rev.proposed && !rev.failed)?String(rev.proposed):"";
        if(!draft){ res.statusCode=200; return res.end(supplyFactFormHtml(it, tok, "Couldn’t draft a reply from that — try rephrasing the fact.")); }
        // #4 FIX: reviseFromSms re-staged the item to 'pending' with proposed=draft in a SEPARATE list copy, so the
        // 'it' fetched at the top is STALE (still status 'escalated' + old holding) — passing it made sendApprovalEmail
        // render the wrong (esc2 'answer this') template, not the approval email, so the real approval email only
        // arrived later from a sweep (the ~8-min lag). RE-FETCH the fresh item and send the approval email INLINE,
        // awaited, right now. Also mark it emailed (+ set the one-shot key) so the sweep can't duplicate it.
        const _cfg=await getNotifyConfig(); const _cands=[_cfg.to2, _cfg.to].filter(Boolean);
        let _to=String(q.to||"").trim(); if(!_to || _cands.indexOf(_to)===-1) _to=_cfg.to2||_cfg.to||"";
        const _list2=await getApprovals(); const _it2=_list2.find(x=>x&&x.id===id)||it;
        // ABSOLUTE GUARD: never send an approval email whose suggested reply is the holding note. If the composed
        // draft is somehow empty or holding-like, FAIL LOUDLY and ask for the fact again — do NOT email a holding.
        if(!_it2.proposed || isHoldingLike(_it2.proposed)){ res.statusCode=200; return res.end(supplyFactFormHtml(it, tok, "That didn’t produce a real answer yet. Please re-enter the actual fact to tell the guest (e.g. the availability, price, or specific detail) and we’ll compose the reply.")); }
        // DEDUPE the approval email: a double-submit / concurrent request must not send two "Approve & Send" emails.
        let _sendOk=true; try{ if(redis){ const _r=await redis.set("parkside:approval_email:"+id, new Date().toISOString(), {nx:true, ex:300}); _sendOk=(_r!==null && _r!==false); } }catch(e){}
        let emailed=null;
        if(_sendOk){ try{ emailed=await sendApprovalEmail(req, _it2, _to, false, {hideReject:true}); }catch(e){ emailed={sent:false, error:String(e.message||e)}; } }
        else { emailed={sent:true, deduped:true}; } // an approval email for this item already went out moments ago
        // mark it so the backup sweep never re-asks and never nudges this (now-pending) item.
        try{ _it2.backupAskSent=true; _it2.escalatedTo2=true; _it2.escalatedTo2At=new Date().toISOString(); _it2.escalatedTo2Sent=!!(emailed&&emailed.sent); await setApprovals(_list2); }catch(e){}
        try{ if(redis) await redis.set("parkside:backup_ask:"+id, new Date().toISOString(), {ex:30*24*3600}); }catch(e){}
        const _ok=!!(emailed && emailed.sent);
        res.statusCode=200; return res.end(htmlPage("Got it — reply drafted"+(_ok?" ✓":""),
          _ok ? "Thanks! We drafted a reply from that and just emailed it to you. Open that new email and tap “Approve & Send” to send it to the guest. Nothing goes to the guest until you approve."
              : "We drafted the reply but couldn’t email it just now"+((emailed&&(emailed.reason||emailed.error))?(" ("+String(emailed.reason||emailed.error)+")"):"")+". It’s saved and waiting for approval; Victor was also texted. (Ref "+it.id+")"));
      }
      res.statusCode=200; return res.end(supplyFactFormHtml(it, tok, ""));
    }
    // View rejected drafts (password) so the owner can see what was wrong.
    if(action==="rejected_log"){
      if((req.headers["x-app-password"]||"")!==(process.env.APP_PASSWORD||"")) return res.status(401).json({error:"unauthorized"});
      const rk=(redis?(await redis.get("parkside:kb_rejected")):_memRejected)||[];
      return res.status(200).json({count:rk.length, items:rk.slice(-200).reverse()});
    }
    // VICTOR'S decision. Two ways in:
    //  (1) Email link (GET ?id=&decision=&token=APPROVE_LINK_SECRET) -> HTML confirmation page.
    //  (2) Victor's UI (POST {id,decision,answer?} with x-app-password) -> JSON.
    if(action==="approve"){
      const q=(req.query)||{};
      const isLink = (req.method==="GET") || !!q.token;
      if(isLink){
        const secret=(await getNotifyConfig()).secret;
        res.setHeader("Content-Type","text/html; charset=utf-8");
        if(!secret || String(q.token||"")!==secret){ res.statusCode=403; return res.end(htmlPage("Link error","This approval link is invalid or expired.")); }
        // REJECT path: capture a "why" reason first (so it can learn), then reject on submit. Approve (yes) falls through unchanged.
        if(String(q.decision||"").toLowerCase()==="no"){
          let _lb=req.body; if(typeof _lb==="string"){ try{_lb=JSON.parse(_lb);}catch{ try{_lb=Object.fromEntries(new URLSearchParams(_lb));}catch{_lb={};} } } _lb=_lb||{};
          const _id=String(q.id||""); const _confirmed=(req.method==="POST")||q.confirm==="1";
          if(!_confirmed){ const _list=await getApprovals(); const _it=_list.find(x=>x.id===_id);
            if(!_it){ res.statusCode=200; return res.end(htmlPage("Not found","This request was not found (it may already be handled).")); }
            if(_it.status!=="pending"){ res.statusCode=200; return res.end(htmlPage("Already "+_it.status,"This request was already "+_it.status+", most likely by the other recipient. The guest was not messaged twice.")); }
            res.statusCode=200; return res.end(rejectPageHtml(_it, secret)); }
          const _reason=String((_lb&&_lb.reason)||q.reason||"").trim();
          const _o=await decideApproval(_id,"no",null,_reason);
          if(_o.ok&&_o.decision==="rejected"){ res.statusCode=200; return res.end(htmlPage("Rejected","Nothing was sent to the guest."+(_reason?" Thanks for the reason — future drafts will learn from it.":""))); }
          if(_o.ok===false && /^already /i.test(String(_o.error||""))){ res.statusCode=200; return res.end(htmlPage("Already handled","This request was already handled. Nothing was sent to the guest twice.")); }
          res.statusCode=200; return res.end(htmlPage("Couldn't complete",(_o.error||"Unknown error")+"."));
        }
        const out=await decideApproval(String(q.id||""), String(q.decision||"").toLowerCase(), null);
        let title, msg;
        if(out.ok && out.decision==="approved"){ title="Approved — reply sent"; msg="The guest reply was sent and saved to the knowledge base."; }
        else if(out.ok && out.decision==="rejected"){ title="Rejected"; msg="This request was rejected. Nothing was sent to the guest."; }
        else if(out.ok===false && /^already /i.test(String(out.error||""))){ const st=((out.item&&out.item.status)||String(out.error||"").replace(/^already\s+/i,"")||"handled"); title="Already handled ✓"; msg="This guest message was already "+st+", most likely by the other recipient. Don’t worry — nothing was sent to the guest twice."; }
        else { title="Couldn't complete"; msg=(out.error||"Unknown error")+"."; }
        res.statusCode=200; return res.end(htmlPage(title,msg));
      }
      if((req.headers["x-app-password"]||"")!==(process.env.APP_PASSWORD||"")) return res.status(401).json({error:"unauthorized"});
      let b=req.body; if(typeof b==="string"){try{b=JSON.parse(b);}catch{b={};}} b=b||{};
      const out=await decideApproval(String(b.id||""), String(b.decision||"").toLowerCase(), b.answer!=null?String(b.answer):null, b.reason!=null?String(b.reason):null);
      return res.status(out.ok?200:400).json(out);
    }
    // PUBLIC provider webhook: Victor replies YES/NO via text. Provider-agnostic body parse.
    // ===== StayDeck phone intake: Victor calls the number once/day to report; Twilio records + transcribes =====
    if(action==="voice"){
      // Twilio Voice webhook ("A call comes in"). RECORD ONLY (no paid Twilio transcription); we transcribe the
      // recording ourselves for free via Groq Whisper in the voice_recording callback.
      const origin=process.env.APP_PUBLIC_ORIGIN||"https://project-jvyw3.vercel.app";
      const tokQ=(req.query&&req.query.token)?("&amp;token="+encodeURIComponent(req.query.token)):"";
      const cb=origin+"/api/app?action=voice_transcription"+tokQ;
      const xml='<?xml version="1.0" encoding="UTF-8"?>'
        +'<Response>'
        +'<Say voice="alice">Hi, you have reached Parkside Tepees. After the tone, please walk me through your whole day hour by hour \u2014 what you worked on and roughly when, from start to finish. Then hang up when you are done.</Say>'
        +'<Record maxLength="180" playBeep="true" transcribe="true" transcribeCallback="'+cb+'" />'
        +'<Say voice="alice">Thanks. Goodbye.</Say>'
        +'</Response>';
      res.setHeader("Content-Type","text/xml"); res.status(200); return res.end(xml);
    }
    if(action==="voice_recording"){
      // Twilio recording-complete callback. Fetch the audio and transcribe it FREE via Groq Whisper (no Twilio
      // transcription charge). Stores transcript to the call log and, for Victor, into the daily scorecard report.
      const cfg=await getNotifyConfig();
      let b=req.body; if(typeof b==="string"){ try{b=JSON.parse(b);}catch(e){ try{ b=Object.fromEntries(new URLSearchParams(b)); }catch(e2){ b={}; } } } b=b||{};
      const tok=(req.query&&req.query.token)||""; if(cfg.secret && tok && tok!==cfg.secret){ res.status(200); return res.end(""); }
      const from=String(b.From||b.from||"").trim();
      const recUrl=String(b.RecordingUrl||b.recording_url||"").trim();
      const date=etDate(new Date().toISOString());
      const vn=cfg.smsTo||victorNumber();
      const isVictor=!!(vn && from && from.replace(/\D/g,"").slice(-10)===vn.replace(/\D/g,"").slice(-10));
      let transcript="";
      try{
        const groqKey=process.env.GROQ_API_KEY;
        const twSid=process.env.SMS_TWILIO_SID||process.env.TWILIO_ACCOUNT_SID;
        const twTok=process.env.SMS_TWILIO_TOKEN||process.env.TWILIO_AUTH_TOKEN;
        if(groqKey && twSid && twTok && recUrl){
          const audioRes=await fetch(recUrl+".mp3",{headers:{Authorization:"Basic "+Buffer.from(twSid+":"+twTok).toString("base64")}});
          const audioBuf=await audioRes.arrayBuffer();
          const fd=new FormData(); fd.append("file", new Blob([audioBuf],{type:"audio/mpeg"}), "call.mp3"); fd.append("model","whisper-large-v3"); fd.append("response_format","json");
          const gr=await fetch("https://api.groq.com/openai/v1/audio/transcriptions",{method:"POST",headers:{Authorization:"Bearer "+groqKey},body:fd});
          const gj=await gr.json(); transcript=(gj&&gj.text)?String(gj.text).trim():"";
        }
      }catch(e){}
      try{ if(redis){
        const entry={ id:"c"+Date.now().toString(36)+Math.random().toString(36).slice(2,7), from, date, text:transcript, recordingUrl:recUrl, status:(transcript?"transcribed":"recorded"), isVictor, at:new Date().toISOString() };
        const log=(await redis.get("parkside:calllog"))||[]; log.unshift(entry); await redis.set("parkside:calllog", log.slice(0,500));
        if(isVictor && transcript){ const prev=(await redis.get("parkside:report:"+date))||""; const merged=(prev && prev.indexOf(transcript)===-1)?(prev+"\n\n[call] "+transcript):transcript; await redis.set("parkside:report:"+date, merged); }
      } }catch(e){}
      res.setHeader("Content-Type","text/xml"); res.status(200); return res.end('<?xml version="1.0" encoding="UTF-8"?><Response/>');
    }
    if(action==="voice_transcription"){
      // Twilio transcription callback (POST urlencoded): TranscriptionText, RecordingUrl, From, TranscriptionStatus.
      const cfg=await getNotifyConfig();
      let b=req.body; if(typeof b==="string"){ try{b=JSON.parse(b);}catch(e){ try{ b=Object.fromEntries(new URLSearchParams(b)); }catch(e2){ b={}; } } } b=b||{};
      const tok=(req.query&&req.query.token)||""; if(cfg.secret && tok && tok!==cfg.secret){ res.status(200); return res.end(""); }
      const from=String(b.From||b.from||"").trim();
      const text=String(b.TranscriptionText||b.transcription_text||b.text||"").trim();
      const rec=String(b.RecordingUrl||b.recording_url||"").trim();
      const status=String(b.TranscriptionStatus||b.status||"").trim();
      const date=etDate(new Date().toISOString());
      const vn=cfg.smsTo||victorNumber();
      const isVictor=!!(vn && from && from.replace(/\D/g,"").slice(-10)===vn.replace(/\D/g,"").slice(-10));
      try{ if(redis){
        const entry={ id:"c"+Date.now().toString(36)+Math.random().toString(36).slice(2,7), from, date, text, recordingUrl:rec, status, isVictor, at:new Date().toISOString() };
        const log=(await redis.get("parkside:calllog"))||[]; log.unshift(entry); await redis.set("parkside:calllog", log.slice(0,500));
        // Victor's daily verbal report -> auto-fills the scorecard self-report for that date (the AI truth-score then uses it)
        if(isVictor && text){ const prev=(await redis.get("parkside:report:"+date))||""; const merged=(prev && prev.indexOf(text)===-1) ? (prev+"\n\n[call] "+text) : text; await redis.set("parkside:report:"+date, merged); }
      } }catch(e){}
      res.setHeader("Content-Type","text/xml"); res.status(200); return res.end('<?xml version="1.0" encoding="UTF-8"?><Response/>');
    }
    if(action==="signal_debug"){
      if((req.headers["x-gavin-password"]||"")!==(process.env.GAVIN_PASSWORD||"__x")) return res.status(401).json({error:"unauthorized (Gavin login)"});
      const out={ hasKey:!!process.env.PRICELABS_API_KEY, refId:process.env.PRICELABS_REF_ID||"486915", refPms:process.env.PRICELABS_REF_PMS||"ownerrez", today:new Date().toISOString().slice(0,10) };
      try{ if(redis){ const ov=await redis.get("parkside:signal_override"); out.signal_override=ov; const c=await redis.get("parkside:signal"); out.cache_day=c&&c.day; out.cache_map_size=c&&c.map?Object.keys(c.map).length:0; out.cache_sample=c&&c.map?Object.entries(c.map).slice(0,3):[]; } }catch(e){ out.redisErr=String(e.message||e); }
      // live PriceLabs probe (does not write cache)
      try{ const key=process.env.PRICELABS_API_KEY; if(key){ const t=new Date(), e2=new Date(); e2.setDate(e2.getDate()+30);
        const rr=await fetch("https://api.pricelabs.co/v1/listing_prices",{method:"POST",headers:{"X-API-Key":key,"Content-Type":"application/json"},body:JSON.stringify({listings:[{id:out.refId,pms:out.refPms,dateFrom:t.toISOString().slice(0,10),dateTo:e2.toISOString().slice(0,10),reason:false}]})});
        out.pl_status=rr.status; const dt=await rr.text(); let dj=null; try{ dj=JSON.parse(dt); }catch(_){}
        if(dj){ const rows=(dj[0]&&dj[0].data)||[]; out.pl_rows=rows.length; out.pl_priceable=rows.filter(x=>x.date&&!x.booking_status&&!x.unbookable&&x.price>0).length; out.pl_row_sample=rows.slice(0,3); if(dj[0]&&dj[0].error) out.pl_listing_error=dj[0].error; if(!Array.isArray(dj)&&dj.error) out.pl_error=dj.error; }
        else out.pl_body=dt.slice(0,300);
      } else out.pl_note="no PRICELABS_API_KEY"; }catch(e){ out.pl_fetchErr=String(e.message||e); }
      return res.status(200).json(out);
    }
    if(action==="calls_get"){
      if((req.headers["x-gavin-password"]||"")!==(process.env.GAVIN_PASSWORD||"__x")) return res.status(401).json({error:"unauthorized (Gavin login)"});
      let log=[]; try{ if(redis) log=(await redis.get("parkside:calllog"))||[]; }catch(e){}
      return res.status(200).json({calls:log.slice(0,100)});
    }
    if(action==="calls_delete"){
      if((req.headers["x-gavin-password"]||"")!==(process.env.GAVIN_PASSWORD||"__x")) return res.status(401).json({error:"unauthorized (Gavin login)"});
      const key=(req.query&&(req.query.id||req.query.at))||(req.body&&(req.body.id||req.body.at))||"";
      if(!key) return res.status(400).json({error:"need id"});
      try{ if(redis){ let log=(await redis.get("parkside:calllog"))||[]; const before=log.length; log=log.filter(c=>String(c.id||"")!==String(key) && String(c.at||"")!==String(key)); await redis.set("parkside:calllog", log); return res.status(200).json({deleted:before-log.length, remaining:log.length}); } }catch(e){ return res.status(500).json({error:String(e.message||e)}); }
      return res.status(200).json({deleted:0});
    }
    // Reassign a phoned-in call/transcript to a different ET day. Gavin-gated. POST {id, date:"YYYY-MM-DD"}. Flat list -> just update the date field (keeps text + recording).
    if(action==="call_move"){
      if((req.headers["x-gavin-password"]||"")!==(process.env.GAVIN_PASSWORD||"__x")) return res.status(401).json({error:"unauthorized (Gavin login)"});
      let b=req.body; if(typeof b==="string"){ try{b=JSON.parse(b);}catch(e){ b={}; } } b=b||{};
      const id=String(b.id||(req.query&&req.query.id)||"");
      const date=String(b.date||(req.query&&req.query.date)||"").slice(0,10);
      if(!id) return res.status(400).json({error:"need id"});
      if(!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({error:"need date YYYY-MM-DD"});
      try{ if(redis){ let log=(await redis.get("parkside:calllog"))||[]; let found=false, oldDate=""; for(const c of log){ if(c && (String(c.id||"")===id || String(c.at||"")===id)){ oldDate=String(c.date||""); c.date=date; found=true; break; } }
        if(!found) return res.status(404).json({error:"call not found"}); await redis.set("parkside:calllog", log); return res.status(200).json({ok:true, id, from:oldDate, to:date}); } }catch(e){ return res.status(500).json({error:String(e.message||e)}); }
      return res.status(200).json({ok:false, error:"no redis"});
    }
    if(action==="mms_media"){
      const gp=(req.query&&req.query.gp)||(req.headers["x-gavin-password"]||"");
      if(gp!==(process.env.GAVIN_PASSWORD||"__x")) return res.status(401).end("unauthorized");
      const rid=(req.query&&req.query.rid)||"";
      let blob={}; try{ if(redis) blob=(await redis.get("parkside:fraud"))||{}; }catch(e){}
      const rc=(blob.receipts||[]).find(function(r){return String(r.id)===String(rid);});
      if(!rc||!rc.media) return res.status(404).end("not found");
      const url=String(rc.media);
      const sid=process.env.SMS_TWILIO_SID||process.env.TWILIO_ACCOUNT_SID;
      const tok=process.env.SMS_TWILIO_TOKEN||process.env.TWILIO_AUTH_TOKEN;
      const headers={}; if(/twilio\.com/i.test(url)&&sid&&tok) headers.Authorization="Basic "+Buffer.from(sid+":"+tok).toString("base64");
      try{ const rr=await fetch(url,{headers,redirect:"follow"}); if(!rr.ok) return res.status(502).end("fetch "+rr.status);
        const ct=rr.headers.get("content-type")||"image/jpeg"; const buf=Buffer.from(await rr.arrayBuffer());
        res.setHeader("Content-Type",ct); res.setHeader("Cache-Control","private, max-age=86400"); return res.status(200).end(buf);
      }catch(e){ return res.status(502).end("err "+String(e.message||e)); }
    }
    if(action==="sms_debug"){
      // Re-gated now that transport is confirmed (kept as a diagnostic). App or Gavin password required.
      if((req.headers["x-app-password"]||"")!==(process.env.APP_PASSWORD||"__y") && (req.headers["x-gavin-password"]||"")!==(process.env.GAVIN_PASSWORD||"__x")) return res.status(401).json({error:"unauthorized"});
      res.setHeader("Cache-Control","no-store, max-age=0");
      let _arr=[]; try{ if(redis){ _arr=(await redis.get("parkside:sms_debug"))||[]; if(!Array.isArray(_arr)) _arr=[]; } }catch(e){}
      const _c=await getNotifyConfig();
      return res.status(200).json({ count:_arr.length, smsToConfigured:!!_c.smsTo, smsToL10:String(_c.smsTo||"").replace(/\D/g,"").slice(-10), recent:_arr.slice(-20).reverse() });
    }
    if(action==="sms_inbound"){
      const cfg=await getNotifyConfig();
      let b=req.body; if(typeof b==="string"){ try{b=JSON.parse(b);}catch(e){ try{ b=Object.fromEntries(new URLSearchParams(b)); }catch(e2){ b={}; } } } b=b||{};
      const pl=(b&&b.payload)?b.payload:b;
      const from=String(pl.phoneNumber||pl.from||b.From||b.from||b.source||"").trim();
      const bodyRaw=String(pl.message||pl.text||b.Body||b.body||b.text||b.message||"").trim();
      const tok=(req.query&&req.query.token)||"";
      if(cfg.secret && tok && tok!==cfg.secret) return res.status(200).json({ignored:true, reason:"bad token"});
      // Duplicate-webhook guard: Twilio can POST the same MMS twice (the number AND its Messaging Service). Dedup by MessageSid.
      const _msgSid=String(pl.MessageSid||b.MessageSid||pl.SmsMessageSid||b.SmsMessageSid||pl.SmsSid||b.SmsSid||pl.messageId||b.messageId||"").trim();
      // ===== inbound-SMS DIAGNOSTIC: record each inbound + the branch/outcome to parkside:sms_debug (read via action=sms_debug) =====
      const _dbgRec={ at:new Date().toISOString(), from:String(from), fromL10:String(from).replace(/\D/g,"").slice(-10), smsToL10:String(cfg.smsTo||"").replace(/\D/g,"").slice(-10), bodyRaw:String(bodyRaw).slice(0,240), sid:_msgSid, numMedia:(parseInt(pl.NumMedia||b.NumMedia||b.num_media||0,10)||0), bKeys:(b&&typeof b==="object")?Object.keys(b).slice(0,30):[], plKeys:(pl&&typeof pl==="object"&&pl!==b)?Object.keys(pl).slice(0,30):[], outcome:"received" };
      const _dbg=async(oc)=>{ try{ if(redis){ _dbgRec.outcome=oc||_dbgRec.outcome; _dbgRec.tsOut=new Date().toISOString(); let _a=(await redis.get("parkside:sms_debug"))||[]; if(!Array.isArray(_a)) _a=[]; _a.push(Object.assign({},_dbgRec)); await redis.set("parkside:sms_debug", _a.slice(-20)); } }catch(e){} };
      if(_msgSid && redis){ try{ const _fresh=await redis.set("parkside:mms_seen:"+_msgSid,"1",{nx:true,ex:900}); if(_fresh===null||_fresh===false){ await _dbg("dedup"); return res.status(200).json({ok:true,dedup:true,reason:"duplicate webhook",sid:_msgSid}); } }catch(e){} }
      // ROBUST MMS/media intake \u2014 runs BEFORE the sender filter so a receipt photo from ANY number (incl. Gavin's own tests) is captured into the Fraud tab.
      { const media=[]; const seen={};
        const isImg=x=>typeof x==="string"&&x.length<4000&&(/^https?:\/\/[^\s]+\.(jpe?g|png|gif|webp|heic|heif|bmp|tiff?)(\?|#|$)/i.test(x)||/^data:image\//i.test(x)||/^https?:\/\/[^\s]*(mediaurl|media\/|\/mms|attachment|\/image|\/photo|cloudinary|amazonaws|blob)/i.test(x));
        const push=u=>{ u=String(u); if(u&&!seen[u]){ seen[u]=1; media.push(u); } };
        (function walk(o,depth){ if(o==null||depth>6) return; if(typeof o==="string"){ if(isImg(o)) push(o); return; } if(Array.isArray(o)){ o.forEach(function(x){walk(x,depth+1);}); return; } if(typeof o==="object"){ for(const k in o){ const v=o[k]; if(/attach|media|image|photo|file|url/i.test(k)&&typeof v==="string"){ if(isImg(v)||/^https?:\/\//i.test(v)) push(v); } else walk(v,depth+1); } } })(b,0);
        const nm=parseInt(pl.NumMedia||b.NumMedia||b.num_media||0,10)||0; for(let _i=0;_i<nm;_i++){ const mu=b["MediaUrl"+_i]||pl["MediaUrl"+_i]; if(mu) push(mu); }
        if(media.length){
          try{ if(redis){ let blob=(await redis.get("parkside:fraud"))||{accounts:{},checks:[],receipts:[],alerts:[]}; blob.receipts=blob.receipts||[]; const now=new Date().toISOString();
            for(const mu of media){ blob.receipts.unshift({ id:Date.now().toString(36)+Math.random().toString(36).slice(2,7), source:"mms", vendor:"", amount:"", date:etDate(now), ref:"", note:bodyRaw||"", media:mu, from, sid:_msgSid||"", status:"unreviewed", at:now }); }
            blob.receipts=blob.receipts.slice(0,2000); await redis.set("parkside:fraud",blob); } }catch(e){}
          try{ await sendSmsGateway(cfg, "\uD83E\uDDFE Receipt received ("+media.length+" image"+(media.length>1?"s":"")+") \u2014 saved to the fraud log. Thanks!"); }catch(e){}
          await _dbg("media_receipt:"+media.length); return res.status(200).json({receipt:true, count:media.length, via:"robust"});
        }
      }
      const vn=cfg.smsTo||victorNumber();
      if(vn && from && from.replace(/\D/g,"").slice(-10)!==vn.replace(/\D/g,"").slice(-10)){
        await _dbg("sender_mismatch from="+_dbgRec.fromL10+" smsTo="+_dbgRec.smsToL10);
        return res.status(200).json({ignored:true, reason:"sender is not the owner's number"}); }
      // MMS receipt intake: Victor texts a photo of a receipt to the StayDeck number -> store in the Fraud Alert receipts.
      const numMedia=parseInt(pl.NumMedia||b.NumMedia||b.num_media||0,10)||0; const mediaUrls=[];
      if(numMedia>0){ for(let _i=0;_i<numMedia;_i++){ const mu=b["MediaUrl"+_i]||pl["MediaUrl"+_i]; if(mu) mediaUrls.push(String(mu)); } }
      if(!mediaUrls.length){ const alt=pl.mediaUrl||b.mediaUrl||pl.media||b.media; if(alt){ if(Array.isArray(alt)) alt.forEach(x=>mediaUrls.push(String(x))); else mediaUrls.push(String(alt)); } }
      if(mediaUrls.length){
        try{ if(redis){ let blob=(await redis.get("parkside:fraud"))||{accounts:{},checks:[],receipts:[],alerts:[]}; blob.receipts=blob.receipts||[]; const now=new Date().toISOString();
          for(const mu of mediaUrls){ blob.receipts.unshift({ id:Date.now().toString(36)+Math.random().toString(36).slice(2,7), source:"mms", vendor:"", amount:"", date:etDate(now), ref:"", note:bodyRaw||"", media:mu, sid:_msgSid||"", status:"unreviewed", at:now }); }
          blob.receipts=blob.receipts.slice(0,2000); await redis.set("parkside:fraud",blob); } }catch(e){}
        try{ await sendSmsGateway(cfg, "\uD83E\uDDFE Receipt received ("+mediaUrls.length+" image"+(mediaUrls.length>1?"s":"")+") \u2014 saved to the fraud log. Thanks!"); }catch(e){}
        return res.status(200).json({receipt:true, count:mediaUrls.length});
      }
      if(!bodyRaw){ await _dbg("empty_body"); return res.status(200).json({ignored:true, reason:"empty"}); }
      const ackBack=async(t)=>{ if(!(cfg.smsUrl&&cfg.smsTo)) return {sent:false}; let _r=null; for(let _i=0;_i<3;_i++){ try{ _r=await sendSmsGateway(cfg, t); if(_r && _r.sent) return _r; }catch(e){ _r={sent:false, error:String(e.message||e)}; } if(_i<2) await new Promise(function(res){setTimeout(res,1200);}); } return _r||{sent:false}; };
      // TAPBACK/REACTION GUARD: a reaction (or emoji-only) inbound is NOT a reply. Ignore it entirely — no prompt,
      // no processing, and there is NO path from here to a guest message (guest sends only happen on decideApproval
      // via an explicit "Q# yes"). Silently drop.
      if(isReaction(bodyRaw)){ await _dbg("reaction_ignored"); return res.status(200).json({ignored:true, reason:"tapback/reaction"}); }
      const list=await getApprovals(); const pend=list.filter(x=>x.status==="pending"||x.status==="escalated");
      const lm=bodyRaw.match(/^\s*q\s*0*(\d+)\b\s*([\s\S]*)$/i);
      let target=null, rest=bodyRaw;
      if(lm){ target=findByLabel(list, "Q"+lm[1]); rest=String(lm[2]||"").trim();
        if(!target){ _dbgRec.matchedQ="Q"+lm[1]; _dbgRec.itemFound=false; await _dbg("label_not_found:Q"+lm[1]); await ackBack("I don't see a pending Q"+lm[1]+". Pending: "+(pend.map(x=>x.smsLabel||"?").join(", ")||"none")+"."); return res.status(200).json({ignored:true, reason:"label not found"}); } }
      // STRICT: only a BARE affirmation/negation counts as a yes/no COMMAND. Anything longer is
      // a correction or (for an escalation) the FACT Victor is supplying — so "no pets allowed"
      // or "yes we have parking" is treated as content, NEVER misread as reject/approve.
      const _bare=(t)=>String(t||"").trim().replace(/\s+/g," ").replace(/[.!,]+$/,"").toLowerCase();
      const isYes=(t)=>/^(y|yes|yep|yeah|yup|ok|okay|okey|sure|send|send it|yes send|yes send it|approve|approve it|approved|confirm|confirmed|go|looks good|lgtm)$/i.test(_bare(t));
      const isNo=(t)=>/^(n|no|nope|reject|reject it|skip|cancel|decline|stop|do not send|dont send|don't send)$/i.test(_bare(t));
      if(!target){
        if(isYes(rest)||isNo(rest)){
          if(pend.length===1) target=pend[0];
          else if(pend.length===0){ await ackBack("Nothing pending right now."); return res.status(200).json({ignored:true}); }
          else { await ackBack("You have "+pend.length+" pending ("+pend.map(x=>x.smsLabel).join(", ")+"). Reply e.g. \""+pend[0].smsLabel+" yes\"."); return res.status(200).json({need_label:true}); }
        } else {
          // Only nag ("which one?" / "start with a label") when the text PLAUSIBLY looks like an attempted answer/fact
          // (reactions are already filtered above). Stray non-reply noise is ignored silently.
          const _clean=String(rest).trim();
          const _looksLikeAnswer = /\d/.test(_clean) || _clean.split(/\s+/).filter(Boolean).length>=2 || _clean.replace(/[^A-Za-z]/g,"").length>=8;
          if(!_looksLikeAnswer){ await _dbg("ignored_noise"); return res.status(200).json({ignored:true, reason:"non-reply noise"}); }
          if(pend.length===1){ target=pend[0]; rest=bodyRaw; }
          else if(pend.length===0){ await ackBack("Nothing pending. Replies start with the label, e.g. \"Q1 yes\"."); return res.status(200).json({ignored:true}); }
          else { await ackBack("Which one? Start with the label, e.g. \""+pend[0].smsLabel+" "+bodyRaw.slice(0,40)+"\"."); return res.status(200).json({need_label:true}); }
        }
      }
      rest=cleanVictorFact(rest); // item #5: unwrap <...> / drop literal placeholder tokens before interpreting his reply
      const lbl=target.smsLabel||"Q?";
      // SINGLE-RESOLUTION LOCK: if this Q# was already resolved by ANYONE — approved/sent, rejected, or CLOSED
      // because the front desk answered the guest directly in OwnerRez — do NOT act again (no re-draft, no send).
      // Tell Victor it's handled. This is what guarantees one-and-only-one guest message per escalation.
      if(target.status && target.status!=="pending" && target.status!=="escalated"){
        await ackBack(lbl+" was already handled ("+target.status+(target.closedExternally?", the front desk answered the guest directly":"")+"). Nothing more was sent to the guest.");
        return res.status(200).json({ok:true, already:target.status, label:lbl, closedExternally:!!target.closedExternally});
      }
      // Auto-message escalations: the holding message already went to the guest. Victor only ever
      // provides a FACT here — it is NEVER sent to the guest directly. We draft a reply from his
      // fact and text it BACK to him; only his "Q# yes" then sends it to the guest.
      if(target.status==="escalated"){
        if(rest===""){ await ackBack(lbl+": I don\u2019t have the answer yet. To answer, text: "+lbl+" then your answer. Example: "+lbl+" checkout is 11am. Nothing is sent to the guest until you reply "+lbl+" yes."); return res.status(200).json({need_facts:true, label:lbl}); }
        if(isNo(rest)){ const it2=list.find(x=>x.id===target.id); if(it2){ it2.status="closed"; it2.decidedAt=new Date().toISOString(); await setApprovals(list); } await ackBack(lbl+" closed — nothing more sent to the guest."); return res.status(200).json({closed:true, label:lbl}); }
        if(isYes(rest)){ await ackBack(lbl+": I don\u2019t have your answer yet. To answer, text: "+lbl+" then your answer. Example: "+lbl+" checkout is 11am. Nothing is sent to the guest until you reply "+lbl+" yes."); return res.status(200).json({need_facts:true, label:lbl}); }
        // Compose the guest reply from Victor's fact and TEXT THE DRAFT BACK to him for approval. This step MUST
        // always reply — it can never dead-end (that was the bug: reviseFromSms was called without a try/catch, so
        // a compose throw/hang killed the handler and no SMS went back). reviseFromSms composes (Anthropic) + stages
        // the item pending; if it throws or returns nothing, fall back to a deterministic reply built from the fact
        // and stage the item pending here so a later "Q# yes" can send it.
        let _draft="";
        try{ const rev2=await reviseFromSms(req, target, rest); if(rev2 && !rev2.failed && !rev2.alreadyHandled) _draft=String(rev2.proposed||"").trim(); }catch(e){}
        if(!_draft){
          let _hasHist=false; try{ const _h=await getThreadLog(target.thread_id, target.booking_id); _hasHist=(_h||[]).some(function(m){ return m && m.d==="out"; }); }catch(e){}
          _draft=directReplyFromFact(target.guest_name, rest, _hasHist);
          try{ const _l2=await getApprovals(); const _it3=_l2.find(function(x){ return x && x.id===target.id; }); if(_it3){ if(_draft) _it3.proposed=_draft; _it3.status="pending"; _it3.escalate=false; _it3.factFromVictor=rest; const _n=new Date().toISOString(); _it3.revisedAt=_n; _it3.ts=_n; _it3.primaryNotifiedAt=_n; await setApprovals(_l2); } }catch(e){}
        }
        if(!_draft){ _dbgRec.matchedQ=lbl; _dbgRec.itemFound=true; _dbgRec.itemStatus=target.status; await _dbg("escalated_fact_no_draft"); await ackBack(lbl+": couldn't draft a guest reply from that — please text the fact again in a few plain words."); return res.status(200).json({revised:false, failed:true, label:lbl}); }
        const _dbAck=await ackBack(lbl+" — draft reply for the guest:\n"+String(_draft).slice(0,600)+"\n\nReply \""+lbl+" yes\" to send it to the guest, or text a correction. Nothing is sent until you reply "+lbl+" yes.");
        _dbgRec.matchedQ=lbl; _dbgRec.itemFound=true; _dbgRec.itemStatus=target.status; _dbgRec.draftBackSent=!!(_dbAck&&_dbAck.sent); await _dbg("escalated_draftback sent="+!!(_dbAck&&_dbAck.sent));
        return res.status(200).json({escalation_drafted:true, label:lbl, sentDraftBack:!!(_dbAck&&_dbAck.sent)});
      }
      if((lm && rest==="")||isYes(rest)){
        const out=await decideApproval(target.id, "yes", null);
        await ackBack(out && out.sent ? (lbl+" sent to the guest. ✅") : (lbl+" NOT sent: "+((out&&out.error)||"error")));
        return res.status(200).json({decided:"yes", label:lbl, out});
      }
      if(isNo(rest)){
        const out=await decideApproval(target.id, "no", null, "rejected via text");
        await ackBack(lbl+" skipped — nothing was sent to the guest.");
        return res.status(200).json({decided:"no", label:lbl, out});
      }
      let _draft2="";
      try{ const rev=await reviseFromSms(req, target, rest); if(rev && !rev.failed && !rev.alreadyHandled) _draft2=String(rev.proposed||"").trim(); }catch(e){}
      if(!_draft2){
        let _hh=false; try{ const _h2=await getThreadLog(target.thread_id, target.booking_id); _hh=(_h2||[]).some(function(m){ return m && m.d==="out"; }); }catch(e){}
        _draft2=directReplyFromFact(target.guest_name, rest, _hh);
        try{ const _l3=await getApprovals(); const _it4=_l3.find(function(x){ return x && x.id===target.id; }); if(_it4){ if(_draft2) _it4.proposed=_draft2; _it4.status="pending"; _it4.revisedAt=new Date().toISOString(); await setApprovals(_l3); } }catch(e){}
      }
      if(!_draft2){ await ackBack(lbl+": couldn't re-draft. Reply \""+lbl+" yes\" to send the current draft as-is, or text a clearer correction."); return res.status(200).json({revised:false, failed:true, label:lbl}); }
      await ackBack(lbl+" (updated) — draft reply for the guest:\n"+String(_draft2).slice(0,600)+"\n\nReply \""+lbl+" yes\" to send it to the guest, or text another correction.");
      return res.status(200).json({revised:true, label:lbl, proposed:_draft2});
    }

    // ===== Auto-message toggle (app-gated) =====
    if(action==="auto_message"){
      if((req.headers["x-app-password"]||"")!==(process.env.APP_PASSWORD||"__y")) return res.status(401).json({error:"unauthorized"});
      if(req.method==="POST"){ let b=req.body; if(typeof b==="string"){try{b=JSON.parse(b);}catch(e){b={};}} b=b||{}; const raw=await getNotifyRaw(); raw.autoMessage=!!b.enabled; await setNotifyRaw(raw); return res.status(200).json({ok:true, enabled:!!b.enabled}); }
      return res.status(200).json({enabled: await autoMessageOn()});
    }
    // ===== Pending "learned facts" review (app-gated) =====
    if(action==="pending_facts"){
      if((req.headers["x-app-password"]||"")!==(process.env.APP_PASSWORD||"__y")) return res.status(401).json({error:"unauthorized"});
      const list=(await getPendingFacts()).filter(x=>x&&x.status==="pending").slice().reverse();
      return res.status(200).json({facts:list, count:list.length});
    }
    if(action==="pending_fact"){
      if((req.headers["x-app-password"]||"")!==(process.env.APP_PASSWORD||"__y")) return res.status(401).json({error:"unauthorized"});
      let b=req.body; if(typeof b==="string"){try{b=JSON.parse(b);}catch(e){b={};}} b=b||{};
      const id=String(b.id||""); const act=String(b.action||"");
      const list=await getPendingFacts(); const rec=list.find(x=>x&&x.id===id);
      if(!rec) return res.status(200).json({ok:false, error:"not found"});
      if(act==="edit"){ if(typeof b.topic==="string") rec.topic=b.topic.slice(0,80); if(typeof b.a==="string") rec.a=b.a.slice(0,1500); await setPendingFacts(list); return res.status(200).json({ok:true, fact:rec}); }
      if(act==="reject"){ const kept=list.filter(x=>x.id!==id); await setPendingFacts(kept); return res.status(200).json({ok:true, removed:true}); }
      if(act==="approve"){
        const topic=(typeof b.topic==="string"&&b.topic.trim())?b.topic.trim().slice(0,80):String(rec.topic||rec.q||"").slice(0,80);
        const a=(typeof b.a==="string"&&b.a.trim())?b.a.trim().slice(0,1500):String(rec.a||"").slice(0,1500);
        const st=await getState(); const kb=st.kb||JSON.parse(JSON.stringify(KB_SEED)); kb.items=kb.items||[];
        const nt=normQ(topic); const ex=nt?kb.items.find(x=>normQ(x.topic)===nt):null;
        if(ex) ex.a=a; else kb.items.push({topic, a, src:"approved-fact"});
        await setState({kb});
        const kept=list.filter(x=>x.id!==id); await setPendingFacts(kept);
        return res.status(200).json({ok:true, approved:true, kbSize:kb.items.length});
      }
      return res.status(200).json({ok:false, error:"unknown action"});
    }
    // Queryable KB so future response generation can pull approved answers.
    if(action==="kb_query"){

      const st=await getState(); const kb=st.kb||KB_SEED; const q=(req.query&&req.query.q)||"";
      const m=kbAutoMatch(kb, q);
      return res.status(200).json({query:q, match:m, knownTopics:(kb.items||[]).filter(i=>String(i.a||"").trim()).map(i=>i.topic)});
    }
    // Save email-notification config from Victor's UI (password). Stored in Redis,
    // read first by the email flow (env vars remain the fallback). Blank/omitted
    // fields are left unchanged; send "" explicitly to clear a field.
    if(action==="set_notify_config"){
      if((req.headers["x-app-password"]||"")!==(process.env.APP_PASSWORD||"")) return res.status(401).json({error:"unauthorized"});
      let b=req.body; if(typeof b==="string"){try{b=JSON.parse(b);}catch{b={};}} b=b||{};
      const cur=await getNotifyRaw(); const next={...cur};
      // Only write non-empty values, so a blank field never wipes a saved one.
      const setIf=(k,v)=>{ if(v===undefined||v===null) return; const t=String(v).trim(); if(t==="") return; next[k]=t; };
      setIf("victorEmail", b.victorEmail);
      if(typeof b.victorEmail2==="string"){ const t=b.victorEmail2.trim(); if(t!=="") next.victorEmail2=t; else delete next.victorEmail2; }
      if(b.escalateMins!==undefined && b.escalateMins!==null && String(b.escalateMins).trim()!==""){ const m=Number(b.escalateMins); if(isFinite(m)&&m>0) next.escalateMins=Math.round(m); }
      setIf("from", b.from);
      setIf("approveSecret", b.approveSecret);
      // Only overwrite the API key when a non-empty value is provided (so saving other
      // fields never wipes a previously stored key). Pass apiKey:"" to clear it.
      if(typeof b.resendApiKey==="string" && b.resendApiKey.trim()!=="") next.resendApiKey=b.resendApiKey.trim();
      else if(b.resendApiKey==="") delete next.resendApiKey;
      if(typeof b.ownerrez_oauth_token==="string" && b.ownerrez_oauth_token.trim()!=="") next.ownerrez_oauth_token=b.ownerrez_oauth_token.trim();
      else if(b.ownerrez_oauth_token==="") delete next.ownerrez_oauth_token;
      if(b.primaryChannel==="sms"||b.primaryChannel==="email") next.primaryChannel=b.primaryChannel;
      if(typeof b.smsGatewayUrl==="string"){ const t=b.smsGatewayUrl.trim(); if(t!=="") next.smsGatewayUrl=t; else delete next.smsGatewayUrl; }
      if(typeof b.smsTo==="string"){ const t=b.smsTo.trim(); if(t!=="") next.smsTo=t; else delete next.smsTo; }
      if(typeof b.smsBody==="string"){ if(b.smsBody.trim()!=="") next.smsBody=b.smsBody; else delete next.smsBody; }
      if(typeof b.smsHeaders==="string"){ if(b.smsHeaders.trim()!=="") next.smsHeaders=b.smsHeaders; else delete next.smsHeaders; }
      if(typeof b.smsUser==="string"){ const t=b.smsUser.trim(); if(t!=="") next.smsUser=t; else delete next.smsUser; }
      if(typeof b.smsPass==="string" && b.smsPass!=="") next.smsPass=b.smsPass; else if(b.smsPass==="") delete next.smsPass;
      if(typeof b.scoreAlertEmails==="string"){ const t=b.scoreAlertEmails.trim(); if(t!=="") next.scoreAlertEmails=t; else delete next.scoreAlertEmails; }
      await setNotifyRaw(next);
      const cfg=await getNotifyConfig();
      return res.status(200).json({ok:true, saved:{ victorEmailSet:!!cfg.to, victorEmail2Set:!!cfg.to2, escalateMins:cfg.escalateMins, resendFromSet:!!cfg.from, resendKeySet:!!cfg.apiKey, approveSecretSet:!!cfg.secret, ownerrezOauthSet:!!cfg.ownerrezOauth, primaryChannel:cfg.primaryChannel, smsUrlSet:!!cfg.smsUrl, smsToSet:!!cfg.smsTo }});
    }
    // Send ONE sample approval email to the configured Victor address (password).
    if(action==="sms_register_webhook"){
      if((req.headers["x-app-password"]||"")!==(process.env.APP_PASSWORD||"")) return res.status(401).json({error:"unauthorized"});
      const cfg=await getNotifyConfig();
      if(!cfg.smsUrl||!cfg.smsUser) return res.status(200).json({ ok:false, reason:"Set the SMS gateway URL + username/password and Save first." });
      const base=String(cfg.smsUrl).replace(/\/messages\/?$/,"");
      const hooksUrl=base+"/webhooks";
      const origin=(process.env.APP_PUBLIC_ORIGIN||"https://project-jvyw3.vercel.app");
      const cbUrl=origin+"/api/app?action=sms_inbound"+(cfg.secret?("&token="+encodeURIComponent(cfg.secret)):"");
      const auth="Basic "+Buffer.from(String(cfg.smsUser)+":"+String(cfg.smsPass||"")).toString("base64");
      try{
        let existing=[]; try{ const lr=await fetch(hooksUrl,{headers:{Authorization:auth}}); if(lr.ok) existing=await lr.json(); }catch(e){}
        const dup=Array.isArray(existing)&&existing.find(w=>w&&w.url===cbUrl&&(w.event==="sms:received"));
        if(dup) return res.status(200).json({ ok:true, already:true, callback:cbUrl });
        const r=await fetch(hooksUrl,{method:"POST",headers:{Authorization:auth,"Content-Type":"application/json"},body:JSON.stringify({url:cbUrl, event:"sms:received"})});
        const t=await r.text(); let j=null; try{j=JSON.parse(t);}catch(e){}
        return res.status(200).json({ ok:r.ok, status:r.status, callback:cbUrl, result:(j||String(t).slice(0,300)) });
      }catch(e){ return res.status(200).json({ ok:false, error:String(e.message||e) }); }
    }
    if(action==="send_test_sms"){
      if((req.headers["x-app-password"]||"")!==(process.env.APP_PASSWORD||"")) return res.status(401).json({error:"unauthorized"});
      const cfg=await getNotifyConfig();
      if(!cfg.smsUrl) return res.status(200).json({ ok:false, reason:"No SMS gateway URL set \u2014 fill the SMS fields and Save first." });
      if(!cfg.smsTo)  return res.status(200).json({ ok:false, reason:"No phone number set \u2014 fill \u2018Your phone number\u2019 and Save first." });
      const sample="Parkside test \u2705 your SMS approval alerts are working. (Sent from your control panel \u2014 no guest involved.)";
      const r=await sendSmsGateway(cfg, sample);
      const ok=r.sent===true;
      return res.status(200).json({ ok, sent:ok, to:cfg.smsTo, status:(r.status||null),
        error: ok?null:(r.error||r.body||r.reason||("HTTP "+(r.status||"?"))),
        note: ok?("Test text sent to "+cfg.smsTo+" \u2014 check your phone."):"Gateway did not accept it \u2014 check the username/password and URL." });
    }
    // Config visibility for the email/notify channel. Booleans only (no secrets);
    // if a Resend key is present, also lists the account's verified sender domains.
    if(action==="notify_status"){
      res.setHeader("Cache-Control","no-store, max-age=0");
      const _wcreds=await ensureWebhookCreds();
      const _origin=appOrigin(req)||("https://"+(req.headers&&(req.headers["x-forwarded-host"]||req.headers.host)||"project-jvyw3.vercel.app"));
      const webhook={ url:_origin+"/api/app?action=or_message_inbound", user:_wcreds.user, password:_wcreds.pass, entityTypesToEnable:["thread_message","inquiry"], lastEvent:await getWhStatus() };
      let _diag={redisPresent:!!redis};
      try{ if(redis){ const ping="pong-"+Date.now(); await redis.set("parkside:diag_ping",ping); _diag.redisRoundTrip=((await redis.get("parkside:diag_ping"))===ping); } }catch(e){ _diag.redisErr=String(e.message||e); }
      // Safe tepee-persistence probe (no coordinates/secrets — just presence + count) so the saved-config
      // round-trip can be verified without the Gavin password. Confirms whether a Save actually persisted.
      try{ if(redis){ let _tk=await redis.get("parkside:tepees"); if(typeof _tk==="string"){ try{ _tk=JSON.parse(_tk); }catch(e){} } _diag.tepeesKey=Array.isArray(_tk)?("present:"+_tk.length):(_tk?"present:nonarray":"absent"); _diag.tepeesConfirmed=Array.isArray(_tk)?_tk.filter(function(x){return x&&x.confirmed;}).length:0;
        if(Array.isArray(_tk)&&_tk.length){ const _dr=tepeeDisplayRadius(_tk); _diag.tepeeLayout=_tk.map(function(t,i){ return {name:t.name, lat:Number(Number(t.lat).toFixed(6)), lon:Number(Number(t.lon).toFixed(6)), nn_m:_dr[i].nn_m, display_r:_dr[i].display_radius_m}; }); } } }catch(e){ _diag.tepeesErr=String(e.message||e); }
      try{ const raw=await getNotifyRaw(); _diag.notifyConfigKeys=Object.keys(raw); _diag.ownerrezLen=String(raw.ownerrez_oauth_token||"").length; _diag.resendKeyLen=String(raw.resendApiKey||"").length; }catch(e){ _diag.rawErr=String(e.message||e); }
      const cfg=await getNotifyConfig(); const raw=await getNotifyRaw(); const reqAll=await requireApprovalAll();
      const lastSend=(redis?await redis.get("parkside:last_send"):_memLastSend)||null;
      let oauthProbe=null;
      if(cfg.ownerrezOauth){ try{ const pr=await fetch("https://api.ownerrez.com/v2/messages",{headers:{Authorization:"Bearer "+cfg.ownerrezOauth,"User-Agent":"parkside-control/1.0"}});
        oauthProbe={endpoint:"GET /v2/messages", status:pr.status, meaning:(pr.status===401?"token INVALID/expired (401)":(pr.status===405?"GET route-rejected (NOT an auth test — see sendProbe POST for the real token check)":"status "+pr.status))}; }
        catch(e){ oauthProbe={error:String(e.message||e)}; } }
      // SAFE send probe: POST /v2/messages with NO thread_id/recipient -> reveals whether
      // the SEND endpoint is reachable (400 validation = sending works; 401/403 = access/
      // messaging-agreement issue; 405 = method blocked) without messaging anyone.
      let sendProbe=null;
      if(cfg.ownerrezOauth){ try{ const sp=await fetch("https://api.ownerrez.com/v2/messages",{method:"POST",headers:{Authorization:"Bearer "+cfg.ownerrezOauth,"Content-Type":"application/json","User-Agent":"parkside-control/1.0"},body:JSON.stringify({body:"(probe)"})});
        const st=await sp.text(); sendProbe={endpoint:"POST /v2/messages (no thread_id)", status:sp.status, body:st.slice(0,200),
          meaning:(sp.status===400?"SEND reachable (needs thread_id) — token+endpoint OK":(sp.status===401?"token invalid":(sp.status===403?"forbidden — messaging SEND may need the agreement":(sp.status===405?"method blocked":"status "+sp.status))))}; }
        catch(e){ sendProbe={error:String(e.message||e)}; } }
      // Summary of the most recent DECIDED approval (no message content) — did it have a thread?
      let lastDecided=null;
      try{ const _all=await getApprovals(); const dec=_all.filter(x=>x.status==="approved"||x.status==="rejected").sort((a,b)=>String(b.decidedAt||"").localeCompare(String(a.decidedAt||"")));
        if(dec[0]){ const d=dec[0]; lastDecided={status:d.status, source:d.source, decidedAt:d.decidedAt, hasThread:!!d.thread_id, hasBooking:!!d.booking_id, sent:d.sent===true||(d.guestSend&&d.guestSend.sent===true)||undefined}; } }catch(e){}
      // Drive intake on load (throttled) so the pipeline runs without a Vercel cron/paid plan.
      const polledNow=await maybePollMessages(req);
      const escNow=await escalateStaleApprovals(req);
      const stN=await getState(); const apprN=await getApprovals();
      const out={ resendKey:!!cfg.apiKey, resendFromSet:!!cfg.from, victorEmailSet:!!cfg.to, victorEmail2Set:!!cfg.to2, escalateMins:cfg.escalateMins, escalation:escNow, approveSecretSet:!!cfg.secret,
        resendConfigured:!!(cfg.apiKey&&cfg.from&&cfg.to), requireApprovalAll:reqAll, ownerrez_oauth_set:!!cfg.ownerrezOauth, ownerrezOauthLen:(cfg.ownerrezOauth||"").length, oauthProbe, sendProbe, lastDecided, lastSend, webhook, _diag,
        messaging_enabled:!!stN.messaging_enabled,
        counts:{ pendingApprovals:apprN.filter(x=>x.status==="pending").length, approvedBank:(await getApprovedBank()).length, webhookSeen:((redis&&await redis.get("parkside:wh_seen"))||[]).length, msgSeen:((redis&&await redis.get("parkside:msg_seen"))||[]).length },
        lastPoll: polledNow||await getPollStatus(),
        from:cfg.from||null, to:cfg.to||null, to2:cfg.to2||null, primaryChannel:cfg.primaryChannel, smsUrl:cfg.smsUrl||null, smsTo:cfg.smsTo||null, smsBody:cfg.smsBody||null, smsHeaders:cfg.smsHeaders||null, smsUser:cfg.smsUser||null, smsPassSet:!!cfg.smsPass,
        source:{ apiKey: raw.resendApiKey?"ui":(process.env.RESEND_API_KEY?"env":null), from: raw.from?"ui":(process.env.RESEND_FROM?"env":null), to: raw.victorEmail?"ui":(process.env.VICTOR_EMAIL?"env":null), secret: raw.approveSecret?"ui":(process.env.APPROVE_LINK_SECRET?"env":null) } };
      if(cfg.apiKey){
        try{ const r=await fetch("https://api.resend.com/domains",{headers:{Authorization:"Bearer "+cfg.apiKey}});
          out.domainsStatus=r.status; const j=await r.json().catch(()=>null);
          const arr=(j&&(j.data||j.domains))||[]; out.verifiedDomains=arr.map(d=>({name:d.name,status:d.status})); }
        catch(e){ out.domainsErr=String(e.message||e); }
      }
      return res.status(200).json(out);
    }
    // Config visibility for the SMS provider (password) — never reveals secrets.
    if(action==="sms_status"){
      if((req.headers["x-app-password"]||"")!==(process.env.APP_PASSWORD||"")) return res.status(401).json({error:"unauthorized"});
      return res.status(200).json({provider:smsProvider(), configured:smsConfigured(), fromSet:!!smsFrom(), victorSet:!!victorNumber()});
    }

    res.status(400).json({error:"unknown action"});
  }catch(e){ try{ console.error("[handler-500] action="+((req.query&&req.query.action)||"")+" err="+String((e&&e.stack)||(e&&e.message)||e)); }catch(_){} res.status(500).json({error:String(e.message||e)}); }
};

module.exports.__model={compute,paceMult,scarMult,gapGm,deriveLearned,interp,SENS,MODEL,UNIT_PREM,GAP_SEED,signalFallback,buildLearnedPace,paceFrac,buildAgg,median};
module.exports.__msg={kbAutoMatch,normQ,smsProvider,smsConfigured,sendSms,decideApproval};
// item MW-12: expose pure helpers for unit tests (attaches to the handler export).
module.exports.onDutyActivePct=onDutyActivePct;
module.exports.timeOffForDate=timeOffForDate;
