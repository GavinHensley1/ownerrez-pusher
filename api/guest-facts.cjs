// The ONLY reusable authority for guest answers. Old replies and learning queues
// are evidence for review, never independent answer sources.
const crypto=require('node:crypto');
const str=x=>String(x==null?'':x).trim();
const hash=x=>crypto.createHash('sha256').update(x).digest('hex').slice(0,20);
const statuses=new Set(['approved','needs_review','retired']);
const scopes=new Set(['property','unit','booking','thread','internal']);
function scopeKey(scope={type:'property'}){return JSON.stringify([scope.type||'property',scope.type==='property'||scope.type==='internal'?'':str(scope.value),str(scope.validFrom),str(scope.validUntil)]);}
function normalizeItem(raw={},index=0){
  const item={...raw,topic:str(raw.topic),a:str(raw.a)};
  item.id=str(raw.id)||'fact-'+hash(JSON.stringify([index,item.topic,item.a,raw.src||'']));
  item.status=statuses.has(raw.status)?raw.status:'needs_review';
  item.kind=raw.kind==='instruction'?'instruction':'fact';
  item.scope=raw.scope&&typeof raw.scope==='object'?{...raw.scope}:{type:'property'};
  if(!scopes.has(item.scope.type)) item.scope.type='internal';
  item.provenance=Array.isArray(raw.provenance)?raw.provenance.map(p=>({...p})):[];
  item.reusable=raw.reusable===true;
  return item;
}
function normalize(kb={}){return {...kb,version:1,revision:kb.revision||'legacy',items:(Array.isArray(kb.items)?kb.items:[]).map(normalizeItem)};}
function matches(item,ctx={}){
  if(item.status!=='approved'||!item.reusable||!item.a||item.supersededBy||item.scope.type==='internal')return false;
  const scope=item.scope;
  if(scope.type!=='property'){
    const actual=ctx[scope.type];
    if(!str(scope.value)||!str(actual)||str(scope.value)!==str(actual))return false;
  }
  const day=str(ctx.date)||new Date().toISOString().slice(0,10);
  if(scope.validFrom&&(!/^\d{4}-\d{2}-\d{2}$/.test(scope.validFrom)||day<scope.validFrom))return false;
  if(scope.validUntil&&(!/^\d{4}-\d{2}-\d{2}$/.test(scope.validUntil)||day>scope.validUntil))return false;
  return true;
}
function select(kb,ctx={}){
  const eligible=normalize(kb).items.filter(i=>matches(i,ctx)),rank={property:0,unit:1,booking:2,thread:3};
  // A scoped replacement of the same topic wins; competing answers at the same
  // scope level are unresolved, not a license for the model to pick a favorite.
  const groups=new Map();for(const i of eligible){const key=i.kind+'|'+i.topic.toLowerCase();const group=groups.get(key)||[];group.push(i);groups.set(key,group);}
  return [...groups.values()].flatMap(group=>{const max=Math.max(...group.map(i=>rank[i.scope.type]));const chosen=group.filter(i=>rank[i.scope.type]===max);return new Set(chosen.map(i=>i.a)).size>1?[]:chosen.slice(0,1);});
}
function prompt(kb,ctx={}){
  const selected=select(kb,ctx),line=i=>'['+i.id+'] '+i.topic+': '+i.a;
  return 'APPROVED FACTS:\n'+(selected.filter(i=>i.kind==='fact').map(line).join('\n')||'(none)')+
    '\n\nAPPROVED OWNER INSTRUCTIONS (behavior/style only; never evidence for a new property fact):\n'+
    (selected.filter(i=>i.kind==='instruction').map(line).join('\n')||'(none)');
}
// Only remove the machine-authored prefix. Never mine the rejected draft or
// edited guest reply for facts, and never auto-approve the remaining text.
function ownerNote(reason){
  let note=str(reason);
  if(/^auto[- ]?rejected\b/i.test(note)||/^no decision within\b/i.test(note)){
    const match=note.match(/^(?:auto[- ]?rejected[^\n]*?no decision within\s+\d+\s*(?:minutes?|mins?|hours?|hrs?)[^\n]*?)(?:\.\s+|\n+|\s+[—–|]\s+)([\s\S]+)$/i);
    if(match)note=match[1].trim();
    else return '';
  }
  return note;
}
function recover(records=[]){
  return records.flatMap(r=>{const note=ownerNote(r.reason);if(!note||/^(wrong info|made something up|wrong tone|too long|off-topic|not allowed|rejected via link)$/i.test(note))return [];
    const sourceId=str(r.id)||hash(JSON.stringify([r.ts,r.q,r.reason]));
    return [{id:'rejection-'+sourceId,topic:str(r.q).slice(0,180),a:note,status:'needs_review',reusable:false,scope:{type:'property'},kind:'fact',src:'owner-note-review',provenance:[{type:'owner-rejection-note',id:sourceId,at:str(r.ts),originalReason:str(r.reason)}]}];});
}
// A current client's metadata omission must not erase scope/provenance. Changes
// to text are a new version of that same ID, not another hidden authority.
function mergeSave(previous,incoming){
  const old=normalize(previous); if((incoming.revision||'legacy')!==old.revision)throw Error('Facts changed in another session. Reload the current facts before saving; your edits have not been applied.');
  const byId=new Map(old.items.map(i=>[i.id,i]));
  const items=(Array.isArray(incoming.items)?incoming.items:[]).map((raw,index)=>{
    const prior=byId.get(str(raw.id))||old.items.find(i=>i.topic===str(raw.topic)&&scopeKey(i.scope)===scopeKey(raw.scope));
    const next=normalizeItem({...prior,...raw},index);
    if(prior&&(prior.a!==next.a||prior.topic!==next.topic))next.revision=(Number(prior.revision)||1)+1;
    return next;
  });
  if(new Set(items.map(i=>i.id)).size!==items.length)throw Error('Duplicate fact IDs; reload the knowledge base and retry.');
  return normalize({...old,...incoming,items});
}
module.exports={scopeKey,normalize,normalizeItem,select,prompt,matches,recover,ownerNote,mergeSave};
