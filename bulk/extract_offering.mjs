#!/usr/bin/env node
/**
 * Extract each domain's REAL products/services from its website (for the
 * "Website Products / Services" column in Client Knowledge Bases).
 *
 * Shares site_cache.json with bulk_audit.mjs, so anything already fetched is
 * reused and never re-fetched.
 *
 *   node bulk/extract_offering.mjs --accounts domains.txt --out kb_website_offering.csv
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
function loadEnv(dir){
  const p = path.join(dir, '.env'); if(!fs.existsSync(p)) return;
  for(const line of fs.readFileSync(p,'utf8').split(/\r?\n/)){
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if(m && !line.trim().startsWith('#')){ let v=m[2].trim(); if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'"))) v=v.slice(1,-1); if(!(m[1] in process.env)) process.env[m[1]]=v; }
  }
}
loadEnv(DIR);
const OPENAI_KEY = process.env.OPENAI_API_KEY;
if(!OPENAI_KEY){ console.error('Missing OPENAI_API_KEY in bulk/.env'); process.exit(1); }

const arg=(n,d)=>{ const i=process.argv.indexOf('--'+n); return i>=0?process.argv[i+1]:d; };
const ACC=arg('accounts','domains.txt'), OUT=arg('out','kb_website_offering.csv'), CONC=Number(arg('concurrency',6));
const FORCE = process.argv.includes('--force');   // re-fetch even if cached

const csvCell=v=>{ v=(v==null?'':String(v)); return /[",\n]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v; };
const normDomain=s=>String(s||'').toLowerCase().replace(/^https?:\/\//,'').replace(/^www\./,'').replace(/\/.*$/,'').trim();
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function mapLimit(items, limit, fn){
  const out=new Array(items.length); let idx=0;
  async function w(){ while(idx<items.length){ const i=idx++; try{ out[i]=await fn(items[i],i); }catch(e){ out[i]=null; } } }
  await Promise.all(Array.from({length:Math.min(limit,items.length)},w));
  return out;
}
async function openai(messages){
  for(let a=0;a<4;a++){
    const r=await fetch('https://api.openai.com/v1/chat/completions',{method:'POST',headers:{'Authorization':'Bearer '+OPENAI_KEY,'Content-Type':'application/json'},
      body:JSON.stringify({model:'gpt-4o-mini',temperature:0,response_format:{type:'json_object'},messages})});
    if(r.status===429||r.status>=500){ await sleep(1500*(a+1)); continue; }
    if(!r.ok) throw new Error('OpenAI '+r.status);
    try{ return JSON.parse(JSON.parse(await r.text()).choices[0].message.content); }catch(e){ return {}; }
  }
  return {};
}
const htmlToText=h=>String(h).replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&[a-z#0-9]+;/gi,' ').replace(/\s+/g,' ').trim();
async function fetchSiteText(domain){
  const paths=['','services','solutions','products','what-we-do','offerings','about'];
  let text='';
  for(const p of paths){ if(text.length>9000) break;
    try{ const r=await fetch('https://'+domain+'/'+p,{headers:{'User-Agent':'Mozilla/5.0 (compatible; TopicAudit/1.0)'},redirect:'follow',signal:AbortSignal.timeout(12000)});
      if(r.ok){ const t=htmlToText(await r.text()); if(t) text+=' '+t; } }catch(e){}
  }
  return text.slice(0,9000);
}
async function deriveOffering(text){
  if(!text || text.length<50) return [];
  const j=await openai([
    {role:'system',content:'From this company website text, list the concrete PRODUCTS and SERVICES the company offers — short noun phrases, most important first, max 25. Ignore nav/blog/legal boilerplate. Return ONLY JSON: {"offering":["..."]}.'},
    {role:'user',content:text.slice(0,9000)}]);
  return (j.offering||[]).map(s=>String(s).trim()).filter(Boolean).slice(0,30);
}
const cachePath=path.resolve(DIR,'site_cache.json');
const loadCache=()=>{ try{ return JSON.parse(fs.readFileSync(cachePath,'utf8')); }catch(e){ return {}; } };
const saveCache=m=>{ try{ fs.writeFileSync(cachePath, JSON.stringify(m)); }catch(e){} };

const accPath=path.resolve(process.cwd(), ACC);
if(!fs.existsSync(accPath)){ console.error('Accounts file not found: '+accPath); process.exit(1); }
let domains=fs.readFileSync(accPath,'utf8').split(/\r?\n/).map(normDomain).filter(d=>d && d!=='example.com');
domains=[...new Set(domains)];
const cache=loadCache();
const hit=domains.filter(d=>!FORCE && Array.isArray(cache[d])).length;
console.log(domains.length+' domains | '+hit+' already cached (reused, not re-fetched) | '+(domains.length-hit)+' to fetch');

const rows=await mapLimit(domains, CONC, async d=>{
  if(!FORCE && Array.isArray(cache[d])) return {domain:d, offering:cache[d], cached:true};
  let off=[]; try{ off=await deriveOffering(await fetchSiteText(d)); }catch(e){ off=[]; }
  cache[d]=off; return {domain:d, offering:off, cached:false};
});
saveCache(cache);

const outPath=path.resolve(process.cwd(), OUT);
fs.writeFileSync(outPath, [['Client','Website Products / Services (from site)'].join(',')]
  .concat(rows.filter(Boolean).map(r=>[r.domain, (r.offering||[]).join(', ')].map(csvCell).join(','))).join('\n'));

console.log('\n=== extracted ===');
for(const r of rows.filter(Boolean)) console.log('  '+r.domain.padEnd(32)+String((r.offering||[]).length).padStart(2)+' items'+(r.cached?' (cached)':' (fetched)')+(r.offering.length?'':'  <- site blocked/JS-only'));
console.log('\nWrote '+outPath);
