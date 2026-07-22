#!/usr/bin/env node
/**
 * AKR Enricher — standalone (no Apps Script, no 6-min limit, no batching/clicking).
 *
 * Three steps only:
 *   1) input an AKR csv   (--akr)
 *   2) set the client config (--config: a .json OR the Config-tab key/value .csv)
 *   3) get an ENRICHED AKR csv back (--out) with Status / Confidence / Reason / Matched Services / ICP
 *
 * It runs the SAME SERP + OpenAI classify as the Sheets/bulk tools, over the WHOLE list in one run.
 *
 * Usage:
 *   node bulk/akr_enrich.mjs --akr akr.csv --config client.json --out enriched.csv
 *   node bulk/akr_enrich.mjs --akr akr.csv --config config.csv --site          (also fetch the client site)
 *   node bulk/akr_enrich.mjs --akr akr.csv --config client.json --serp false   (fast, keyword-only)
 *
 * Requires bulk/.env with OPENAI_API_KEY and SERPER_KEY. Node 18+ (built-in fetch).
 *
 * NOTE: the classify prompt, rules and guards below are copied verbatim from bulk_audit.mjs so the
 * verdicts match the audit tool; kept self-contained on purpose so this file can't break that one.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* ----------------------------- .env ------------------------------ */
function loadEnv(dir){
  const p = path.join(dir, '.env');
  if(!fs.existsSync(p)) return;
  for(const line of fs.readFileSync(p,'utf8').split(/\r?\n/)){
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if(m && !line.trim().startsWith('#')){ let v=m[2].trim(); if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'"))) v=v.slice(1,-1); if(!(m[1] in process.env)) process.env[m[1]]=v; }
  }
}
const __dir = path.dirname(fileURLToPath(import.meta.url));
loadEnv(__dir);

/* --------------------------- args -------------------------------- */
function arg(name, def){ const i=process.argv.indexOf('--'+name); return i>=0 ? process.argv[i+1] : def; }
const AKR_FILE  = arg('akr');
const CFG_FILE  = arg('config');
const OUT_FILE  = arg('out', 'enriched.csv');
const USE_SERP  = arg('serp', 'true') !== 'false';
const USE_SITE  = process.argv.includes('--site');
const MODEL     = arg('model', USE_SERP ? 'gpt-4o' : 'gpt-4o-mini');
const CONC      = Number(arg('concurrency', 6));
const AI_BATCH  = Number(arg('batch', 30));
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const SERPER_KEY = process.env.SERPER_KEY;
if(!AKR_FILE || !CFG_FILE){ console.error('Usage: node akr_enrich.mjs --akr akr.csv --config client.json|config.csv --out enriched.csv [--site] [--serp false]'); process.exit(1); }
if(!OPENAI_KEY){ console.error('Missing OPENAI_API_KEY in bulk/.env'); process.exit(1); }
if(USE_SERP && !SERPER_KEY){ console.error('Missing SERPER_KEY in bulk/.env (or pass --serp false)'); process.exit(1); }

const sleep = ms => new Promise(r=>setTimeout(r,ms));
async function mapLimit(items, limit, fn){
  const out=new Array(items.length); let idx=0;
  async function worker(){ while(idx<items.length){ const i=idx++; try{ out[i]=await fn(items[i],i); }catch(e){ out[i]={__error:e.message}; } } }
  await Promise.all(Array.from({length:Math.min(limit,items.length)},worker));
  return out;
}

/* ----------------------------- CSV ------------------------------- */
function parseCSV(text){
  const rows=[]; let row=[], cur='', q=false;
  for(let i=0;i<text.length;i++){ const c=text[i];
    if(q){ if(c==='"'){ if(text[i+1]==='"'){ cur+='"'; i++; } else q=false; } else cur+=c; }
    else { if(c==='"') q=true; else if(c===','){ row.push(cur); cur=''; } else if(c==='\n'){ row.push(cur); rows.push(row); row=[]; cur=''; } else if(c==='\r'){} else cur+=c; }
  }
  if(cur.length||row.length){ row.push(cur); rows.push(row); }
  return rows.filter(r=>r.length>1 || (r[0]&&r[0].trim()));
}
function csvCell(v){ v=(v==null?'':String(v)); return /[",\n]/.test(v) ? '"'+v.replace(/"/g,'""')+'"' : v; }

/* =================================================================
 *  ENGINE — copied verbatim from bulk_audit.mjs (rules + prompt must match)
 * ================================================================= */
const norm = s => (s==null?'':String(s)).toLowerCase();
const INFO_RX=/\b(how to|how-to|what is|what's|meaning|definition|define|youtube|you ?tube|video|videos|pdf|template|reddit|wiki|free download|guide|tutorial|at home|diy|recording|app|login|download|coupon|reviews?|quotes?|images?|examples?)\b/;
const JOBS_RX=/\b(jobs?|salary|salaries|hiring|career|careers|certification|certified|certificate|course|courses|degree|class schedule|teacher training|become a|how to become|exam|syllabus)\b/;
const FORMAT_RX=/\b(login|sign in|apk|download|coupon|promo code|discount code|cracked|torrent|free pdf)\b/;
// JUNK / wrong-intent words that reject BY DEFAULT — unless the word is genuinely part of the client's own
// offering/category (guarded), so "insurance quotes", "image printing", "video production" survive for those clients.
const JUNK_RX=/\b(news|quotes?|images?|videos?|movies?|wiki|wikis|www|login|log ?in|trends?|trending)\b/;
const BOFU_RX=/\b(buy|buying|purchase|purchasing|order|ordering|reorder|for sale|price|prices|pricing|cost|costs|how much|cheap|cheapest|affordable|discount|quote|quotation|estimate|near me|nearby|supplier|suppliers|wholesale|bulk|vendor|vendors|manufacturer|manufacturers|distributor|distributors|compan(y|ies)|service|services|shop|store|online|hire|rent|rental|custom|customi(z|s)ed?|personali(z|s)ed?|monogram|monogrammed|engraved|branded|promotional|made to order|best|top)\b/;
const ORG_RX=/\b(institutes?|academ(y|ies)|society|societies|foundations?|associations?|ashram|sangha|vihara|monastery|university|college|ll[cp]|gmbh|pvt|dhamma|goenka|chopra|mindvalley|headspace|deepak|sadhguru|isha)\b/;
const BIG_BRANDS_RX=/\b(nvidia|google|apple|microsoft|amazon|meta|tesla|samsung|intel|ibm|oracle|salesforce|adobe|cisco|netflix|spotify|uber|airbnb|openai|nike|adidas|disney|coca[- ]?cola|pepsi|ces|wwdc|davos|web summit)\b/;
const US_STATES=['alabama','alaska','arizona','arkansas','california','colorado','connecticut','delaware','florida','georgia','hawaii','idaho','illinois','indiana','iowa','kansas','kentucky','louisiana','maine','maryland','massachusetts','michigan','minnesota','mississippi','missouri','montana','nebraska','nevada','new hampshire','new jersey','new mexico','new york','north carolina','north dakota','ohio','oklahoma','oregon','pennsylvania','rhode island','south carolina','south dakota','tennessee','texas','utah','vermont','virginia','washington','west virginia','wisconsin','wyoming'];
const MODIFIER_WORDS=['corporate','executive','executives','online','virtual','in-person','remote','hybrid','offsite','best','top','free','cheap','affordable','budget','luxury','premium','private','group','public','beginner','beginners','advanced','intermediate','basic','intro','quick','short','intensive','guided','daily','morning','evening','weekend','weekday','annual','monthly','weekly','near','local','nearby','custom','customized','customised','tailored','bespoke','professional','expert','certified','accredited','licensed','small','large','team','teams','employee','employees','staff','workplace','company','business','b2b','women','men','kids','senior','seniors','youth','student','students','new','popular','famous','rated','top-rated'];
const MODSET={}; MODIFIER_WORDS.forEach(w=>MODSET[w]=1);
const STATEset={}; US_STATES.forEach(w=>STATEset[w]=1);
const isBofu = kw => { const t=norm(kw); if(INFO_RX.test(t)||JOBS_RX.test(t)) return false; return BOFU_RX.test(t); };
function modifiersOf(kw, cfg){
  const inds={}; (cfg&&cfg.industries||[]).forEach(i=>norm(i).split(/\s+/).forEach(w=>{ if(w) inds[w]=1; }));
  const seen={}, out=[];
  norm(kw).split(/[^a-z0-9]+/).filter(Boolean).forEach(w=>{ if((MODSET[w]||STATEset[w]||inds[w]) && !seen[w]){ seen[w]=1; out.push(w); } });
  return out.join('; ');
}
function evalRules(row, cfg){
  const R=cfg.rules, t=norm(row.kw), hits=[];
  if(R.free && /\bfree\b/.test(t)) hits.push('Free keyword');
  if(R.nearme && /\bnear me\b/.test(t)) hits.push('"Near me" query');
  if(R.info && !/blog/i.test(String(row.pageType||'')) && INFO_RX.test(t)) hits.push('Informational/DIY intent');
  if(R.jobs && JOBS_RX.test(t)) hits.push('Job / education-seeker intent');
  if(R.format && FORMAT_RX.test(t)) hits.push('Wrong-format / login/app intent');
  if(R.org && (ORG_RX.test(t)||BIG_BRANDS_RX.test(t))) hits.push('Other company / brand');
  return hits.length ? {reason:hits.join('; '), layer:'Rule'} : null;
}
function clientDesc(cfg){
  const sells=(cfg.services||[]).concat(cfg.products||[]);
  return [cfg.category?('BUSINESS CATEGORY (this IS the client\'s field — anything in this category is in-field): '+cfg.category+'.'):'', cfg.identity?('This company is: '+cfg.identity+'.'):'',
    (cfg.does&&cfg.does.length)?('WHAT THEY DO (their real capabilities — treat any of these, incl. underlying materials/methods, as in-field): '+cfg.does.join(', ')+'.'):'',
    (cfg.doesNot&&cfg.doesNot.length)?('WHAT THEY DO NOT DO (adjacent things they do NOT offer — these are off-topic): '+cfg.doesNot.join(', ')+'.'):'',
    cfg.offering?('Offering: '+cfg.offering+'.'):'', sells.length?('Sells: '+sells.join(', ')+'.'):'',
    cfg.industries.length?('Ideal customers (ICP): '+cfg.industries.join(', ')+'.'):'',
    (cfg.targetProfessions&&cfg.targetProfessions.length)?('TARGET BUYER ROLES: '+cfg.targetProfessions.join(', ')+'.'):'',
    cfg.website?('Site: '+cfg.website+'.'):''].filter(Boolean).join(' ') || '(client profile not provided)';
}
const CLASSIFY_SYS = cfg => 'You audit a client\'s candidate SEO topics. Decide ONLY one thing, the same way for EVERY industry: is the topic within the client\'s field/offering, or a genuinely DIFFERENT product / service / industry?\n\nCLIENT: '+clientDesc(cfg)+'\n\nKEEP (off=false) if the topic is one of the client\'s products/services, OR a category, type, model, variant, brand, color, size, feature, part, or accessory of what they sell, OR content about their field — INCLUDING how-to, guide, ideas, "what is", certification, exam, course, training, comparison, "best X", cost/price, reviews, or "near me". The client\'s listed offerings are EXAMPLES, NOT an exhaustive list — judge the whole field/category they operate in, not only the exact items listed. When a topic is a SERVICE applied to a target market ("<service> for <industry>"), judge it by the SERVICE, not the market — the named industry is merely who the service is sold to, NOT a different offering. Search INTENT and whether the searcher looks like a student / researcher / job-seeker DO NOT matter and are NEVER a reason to reject.\n\nHOW TO READ ranking_titles (the actual top-10 Google results — do this in two steps):\n  STEP 1: From the ranking_titles, name the single INDUSTRY / FIELD these results belong to, ignoring the client entirely (e.g. "software product management", "overseas education consulting", "commercial signage", "automotive glass").\n  STEP 2: Compare that field to the client\'s BUSINESS CATEGORY (stated in CLIENT above). Treat them as the SAME whenever they describe the same KIND of business, even if worded differently. CRITICAL: if the ranking pages are the client\'s COMPETITORS, or a directory / "best X in <city>" / "top X consultants" list of businesses in the client\'s own category, that is PROOF the keyword IS the client\'s category → off=false (KEEP). A SERP full of competitors is the strongest possible signal that the client belongs there — it is NEVER a reason to reject.\n    Set off=true ONLY when the ranking field is a clearly DIFFERENT business category from the client\'s — e.g. the keyword shares the word "application" but the results are all software product-roadmap tools while the client does university admissions. A shared word with a different meaning is a coincidence, not a match. When the field matches the client\'s category, KEEP even if the exact wording isn\'t in the client\'s item list.\n\nconfidence = how sure you are of the REJECT: "high" = clearly a different industry; "medium" = probably off but the client MIGHT do it; "low" = unsure / borderline. When off=false, confidence is not used.\n\nREJECT (off=true) ONLY when you are CONFIDENT the topic is a DIFFERENT product, service, or industry the client clearly does NOT provide. If the topic could plausibly belong to the client\'s field or product line, KEEP. When unsure, KEEP.\n\nAlso return audience/type/profession for reporting only (they never drive the decision).\n\nTARGET ICP (customer segments this client sells to): '+(cfg.anyBusiness ? 'ANY business or consumer — this is a HORIZONTAL offering, so EVERY keyword fits the ICP (icpFit is always true).' : ((cfg.icps&&cfg.icps.length) ? cfg.icps.join('; ') : 'not specified — treat icpFit as true'))+'\nFor each keyword ALSO return: "icp" = the single customer segment/industry the page targets (short phrase, e.g. "restaurants", "hospitals", "homeowners", "general business"); "icpFit" = true if that segment is one of the client\'s target ICPs above OR the client is horizontal, else false. icpFit is INDEPENDENT of off (a page can be on-topic but target a segment the client does not serve). If unsure, icpFit=true.\nAlso return "services": the client\'s own listed products/services (copied from the CLIENT offering above, verbatim) that this keyword maps to — an array, most relevant first, max 4; [] if the keyword maps to none of them.\nReturn ONLY JSON: {"results":[{"id":<id>,"off":true|false,"reason":"<if off: the different product/industry, <=12 words; else \'\'>","confidence":"high|medium|low","audience":"...","type":"...","profession":"...","icp":"...","icpFit":true|false,"services":["..."]}]}.';
function parseClassify(j){
  const byId={};
  (j.results||[]).forEach(o=>{ byId[String(o.id)]={ off:o.off===true, reason:String(o.reason||'').slice(0,160), conf:(['high','medium','low'].includes(String(o.confidence||'').toLowerCase())?String(o.confidence).toLowerCase():'low'), audience:String(o.audience||'General').slice(0,40), type:String(o.type||'').slice(0,40), profession:String(o.profession||'').slice(0,40), icp:String(o.icp||'').slice(0,50), icpFit:o.icpFit!==false, services:(Array.isArray(o.services)?o.services:[]).map(s=>String(s).trim()).filter(Boolean).slice(0,4) }; });
  return byId;
}
const GENERIC=new Set(['the','and','for','with','your','you','are','can','how','what','why','does','from','that','this','into','best','top','near','free','cost','price','guide','tips','ideas','service','services','product','products','solution','solutions','company','companies','custom','professional','online','list','types','type','about','more','other','their','they','when','where','which','will','make','made','need','using','used','vs']);
const stem = t => t.replace(/ies$/,'y').replace(/s$/,'');
function inOffering(kw, names){
  if(!names || !names.length) return false;
  const hayToks = names.join(' ').toLowerCase().replace(/[^a-z0-9]+/g,' ').split(' ').filter(Boolean).map(stem);
  const hay = new Set(hayToks), hayStr = ' '+hayToks.join(' ')+' ';
  const toks = String(kw||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').split(' ').filter(t=>t && t.length>=4 && !GENERIC.has(t)).map(stem);
  for(let i=0;i<toks.length-1;i++){ if(hayStr.includes(' '+toks[i]+' '+toks[i+1]+' ')) return true; }
  return toks.some(t => t.length>=4 && hay.has(t));
}
// Generic words that must NOT trigger the category guard — otherwise a client whose category is described with
// common words ("... training for support teams") would have EVERY keyword protected from reject. The guard should
// only fire on DISTINCTIVE category words (windshield, signage, admissions, plumbing), never on filler like these.
const CATSTOP=new Set(['services','service','solutions','solution','company','companies','group','agency','firm','and','the','for','with','your','business','industry','provider','providers','professional',
  'training','trainings','course','courses','coaching','coach','skill','skills','customer','customers','support','supporting','team','teams','staff','employee','employees','online','virtual','corporate','program','programs','programme','management','consulting','consultant','consultants','marketing','digital','software','technology','technologies','systems','system','media','design','studio','learning','education','academy','platform','tools','products','product']);
function inCategory(kw, category){
  if(!category) return false;
  const catToks = String(category).toLowerCase().replace(/[^a-z0-9]+/g,' ').split(' ').filter(t=>t.length>=5 && !CATSTOP.has(t)).map(t=>t.slice(0,5));
  if(!catToks.length) return false;
  const kwToks = String(kw||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').split(' ').filter(t=>t.length>=5).map(t=>t.slice(0,5));
  const set = new Set(catToks);
  return kwToks.some(t=>set.has(t));
}

/* --------------------------- OpenAI ------------------------------ */
async function openai(messages){
  for(let attempt=0; attempt<4; attempt++){
    const resp = await fetch('https://api.openai.com/v1/chat/completions',{ method:'POST', headers:{'Authorization':'Bearer '+OPENAI_KEY,'Content-Type':'application/json'},
      body:JSON.stringify({ model:MODEL, temperature:0, response_format:{type:'json_object'}, messages }) });
    if(resp.status===429 || resp.status>=500){ await sleep(1500*(attempt+1)); continue; }
    if(!resp.ok) throw new Error('OpenAI '+resp.status+': '+(await resp.text()).slice(0,200));
    try{ return JSON.parse(JSON.parse(await resp.text()).choices[0].message.content); }catch(e){ return {}; }
  }
  return {};
}
async function classifyBatch(items, cfg){
  const lines = items.map(it=>JSON.stringify({id:it.id, keyword:it.kw, page_title:it.topic||'', ranking_titles:(it.titles||[]).slice(0,6).join(' | ')})).join('\n');
  const j = await openai([{role:'system',content:CLASSIFY_SYS(cfg)},{role:'user',content:'Classify these:\n'+lines}]);
  return parseClassify(j);
}

/* ----------------------------- SERP ------------------------------ */
const IGNORE_DOMAINS=/(wikipedia|wikihow|britannica|fandom|youtube|youtu\.be|vimeo|reddit|quora|stackexchange|stackoverflow|medium\.com|tumblr|facebook|instagram|tiktok|twitter|x\.com|pinterest|linkedin\.com|snapchat|threads\.net|discord|news\.ycombinator)/;
const hostOf = u => { try{ return String(u).replace(/^https?:\/\//,'').replace(/^www\./,'').split('/')[0].toLowerCase(); }catch(e){ return ''; } };
async function serper(kw, gl){
  if(!SERPER_KEY) return {titles:[], domains:[]};
  for(let a=0;a<3;a++){
    try{
      const r = await fetch('https://google.serper.dev/search',{ method:'POST', headers:{'X-API-KEY':SERPER_KEY,'Content-Type':'application/json'},
        body:JSON.stringify({q:kw, gl:gl||'us', num:10}), signal:AbortSignal.timeout(15000) });
      if(r.status===429 || r.status>=500){ await sleep(1200*(a+1)); continue; }
      if(!r.ok) return {titles:[], domains:[]};
      const j = await r.json(), titles=[], domains=[];
      for(const o of (j.organic||[]).slice(0,10)){
        const h = hostOf(o.link||''); if(!h) continue; domains.push(h);
        if(!IGNORE_DOMAINS.test(h)) titles.push(((o.title||'')+' '+(o.snippet||'')).trim());
      }
      return {titles, domains};
    }catch(e){ await sleep(800); }
  }
  return {titles:[], domains:[]};
}
function loadSerpCache(dir){ try{ return JSON.parse(fs.readFileSync(path.resolve(dir,'serp_cache.json'),'utf8')); }catch(e){ return {}; } }
function saveSerpCache(dir, m){ try{ fs.writeFileSync(path.resolve(dir,'serp_cache.json'), JSON.stringify(m)); }catch(e){} }

/* --------------------- website grounding (optional) --------------------- */
function htmlToText(html){ return String(html).replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&[a-z#0-9]+;/gi,' ').replace(/\s+/g,' ').trim(); }
async function fetchSiteText(domain){
  const paths=['','services','solutions','products','what-we-do','offerings','about'];
  let text='';
  for(const p of paths){ if(text.length>9000) break;
    try{ const r=await fetch('https://'+domain+'/'+p, {headers:{'User-Agent':'Mozilla/5.0 (compatible; AkrEnrich/1.0)'}, redirect:'follow', signal:AbortSignal.timeout(12000)});
      if(r.ok){ const t=htmlToText(await r.text()); if(t) text+=' '+t; } }catch(e){}
  }
  return text.slice(0,9000);
}
async function deriveOffering(text){
  if(!text || text.length<50) return [];
  const j=await openai([
    {role:'system',content:'From this company website text, list the concrete PRODUCTS and SERVICES the company offers — short noun phrases, most important first, max 25. Ignore nav/blog/legal boilerplate. Return ONLY JSON: {"offering":["..."]}.'},
    {role:'user',content:text.slice(0,9000)}
  ]);
  return (j.offering||[]).map(s=>String(s).trim()).filter(Boolean).slice(0,30);
}

/* --------------------------- config load --------------------------- */
const toList = v => Array.isArray(v) ? v.map(x=>String(x).trim()).filter(Boolean)
  : String(v==null?'':v).split(/[\n;,]+/).map(s=>s.trim()).filter(Boolean);
const truthy = v => v===true || /^(true|yes|y|1|on)$/i.test(String(v==null?'':v).trim());
function loadConfig(file){
  const raw = fs.readFileSync(file,'utf8');
  let o;
  if(raw.trim().startsWith('{')){ o = JSON.parse(raw); }
  else { o={}; for(const r of parseCSV(raw)){ if(r.length>=2 && String(r[0]).trim() && String(r[0]).toLowerCase()!=='key') o[String(r[0]).trim().toLowerCase()] = r[1]; } }
  const g = (...keys)=>{ for(const k of keys){ if(o[k]!=null && o[k]!=='') return o[k]; } return ''; };
  const services=toList(g('services','service'));
  const products=toList(g('products','product'));
  const industries=toList(g('industries','industry','icp','icps'));
  const cfg = {
    name: String(g('name','client','company')||'').trim(),
    category: String(g('category','business_category')||'').trim(),
    offering: String(g('offering')||'').trim(),
    website: String(g('website','site','domain')||'').trim().replace(/^https?:\/\//,'').replace(/\/.*$/,''),
    services, products, industries,
    competitors: toList(g('competitors','competitor')),
    locations: toList(g('locations','location')),
    targetProfessions: toList(g('target_professions','targetprofessions','target roles','roles')),
    does: toList(g('does','what_they_do')),
    doesNot: toList(g('doesnot','does_not','doesnt','what_they_dont')),
    serpGl: String(g('serpgl','gl','geo')||'').trim().toLowerCase() || (toList(g('locations','location')).some(l=>/^(in|india)$/i.test(l))?'in':'us'),
    rules: {
      free:     truthy(g('rule_free')),
      nearme:   truthy(g('rule_nearme')),
      info:     truthy(g('rule_info')),
      jobs:     truthy(g('rule_jobs')),
      format:   o['rule_format']==null ? true : truthy(g('rule_format')),   // format on by default (junk-only)
      org:      truthy(g('rule_org')),
    },
  };
  cfg.icps = industries.slice();
  cfg.anyBusiness = industries.length ? truthy(g('anybusiness','horizontal')) : true;   // no ICP listed => treat as horizontal
  cfg.identity = [cfg.name||cfg.website, cfg.category?('— a '+cfg.category):'', cfg.locations.length?('serving '+cfg.locations.join(', ')):''].filter(Boolean).join(' ');
  return cfg;
}

/* ----------------------------- AKR load ----------------------------- */
function loadAkr(file){
  const rows = parseCSV(fs.readFileSync(file,'utf8'));
  if(rows.length<2) throw new Error('AKR csv has no data rows');
  const head = rows[0].map(h=>String(h).toLowerCase().trim());
  const find = (...subs)=>{ for(const s of subs){ for(let i=0;i<head.length;i++) if(head[i].includes(s)) return i; } return -1; };
  const findExact = (...vals)=>{ for(const v of vals){ for(let i=0;i<head.length;i++) if(head[i]===v) return i; } return -1; };
  const ci = { kw:find('primary keyword','keyword'), pt:find('page type','type'), topic:find('topic'), sec:find('secondary'), vol:find('search volume','volume','msv'), rel:find('relevance','score') };
  if(ci.vol<0) ci.vol = findExact('sv','vol','total sv','search vol');   // "SV" == search volume (exact, safe)
  if(ci.kw<0) ci.kw = 0;
  const items = [];
  for(let i=1;i<rows.length;i++){ const r=rows[i]; const kw=String(r[ci.kw]||'').trim(); if(!kw) continue;
    items.push({ kw,
      pageType: ci.pt>=0?String(r[ci.pt]||'').trim():'',
      topic:    ci.topic>=0?String(r[ci.topic]||'').trim():'',
      sec:      ci.sec>=0?String(r[ci.sec]||'').trim():'',
      vol:      ci.vol>=0?(parseInt(String(r[ci.vol]||'').replace(/[^0-9]/g,''),10)||0):0,
      rel:      ci.rel>=0?String(r[ci.rel]||'').trim():'' });
  }
  return items;
}

/* ----------------------------- main ----------------------------- */
(async function main(){
  const dir = __dir;
  const cfg = loadConfig(CFG_FILE);
  const items = loadAkr(AKR_FILE);
  console.log('AKR rows: '+items.length+' | client: '+(cfg.name||cfg.website||'(unnamed)')+' | gl='+cfg.serpGl+' | SERP: '+(USE_SERP?'ON':'off')+' | model='+MODEL);
  console.log('Offering: '+([...cfg.services,...cfg.products].slice(0,6).join(', ')||'(none listed)')+(cfg.services.length+cfg.products.length>6?' …':''));

  // optional website grounding: fetch site → derive real offering → merge into services
  if(USE_SITE && cfg.website){
    try{ const site = await deriveOffering(await fetchSiteText(cfg.website));
      const seen=new Set(cfg.services.concat(cfg.products).map(x=>x.toLowerCase()));
      const add = site.filter(x=>!seen.has(x.toLowerCase()));
      cfg.services = cfg.services.concat(add);
      console.log('Website grounding: +'+add.length+' offering(s) from '+cfg.website);
    }catch(e){ console.log('Website grounding failed: '+e.message); }
  }
  const names = [...cfg.services, ...cfg.products];

  // 1) SERP per keyword (cached)
  const serpCache = loadSerpCache(dir);
  if(USE_SERP){
    let done=0;
    await mapLimit(items, CONC, async (it)=>{
      const key = cfg.serpGl+'|'+it.kw.toLowerCase();
      if(!serpCache[key]){ const s = await serper(it.kw, cfg.serpGl); serpCache[key] = {titles:s.titles, domains:s.domains}; }
      it.titles = serpCache[key].titles || [];
      if((++done % 50)===0) console.log('  SERP '+done+'/'+items.length);
    });
    saveSerpCache(dir, serpCache);
    console.log('SERP done: '+items.length+' lookups');
  } else { items.forEach(it=>it.titles=[]); }

  // 2) classify in batches
  const byKw = {};
  const batches = [];
  for(let i=0;i<items.length;i+=AI_BATCH) batches.push(items.slice(i,i+AI_BATCH));
  let bdone=0;
  await mapLimit(batches, CONC, async (batch)=>{
    const payload = batch.map((it,idx)=>({id:String(idx), kw:it.kw, topic:it.topic, titles:it.titles}));
    let res; try{ res = await classifyBatch(payload, cfg); }catch(e){ res={}; }
    batch.forEach((it,idx)=>{ byKw[it.kw] = res[String(idx)] || null; });
    bdone += batch.length; if(bdone % 90 < AI_BATCH) console.log('  classified ~'+bdone+'/'+items.length);
  });

  // 3) rules + guards + status + ICP explainer
  let keep=0, reject=0, review=0;
  const out = items.map(it=>{
    const c = byKw[it.kw] || {off:false, conf:'low', reason:'', audience:'General', type:'', profession:'', icp:'', icpFit:true, services:[]};
    const rule = evalRules({kw:it.kw, pageType:it.pageType}, cfg);
    // guards: a keyword in the client's own category (or, without SERP, its offering) can never be rejected
    const guarded = inCategory(it.kw, cfg.category) || (!USE_SERP && inOffering(it.kw, names));
    // JUNK words reject by default — UNLESS that exact word is part of the client's own offering/category
    // (so "insurance quotes" / "video production" survive, but "customer service quotes/news/trends" don't).
    const junkM = norm(it.kw).match(JUNK_RX);
    const junkWord = junkM ? junkM[0].replace(/\s+/g,'') : '';
    const junkStem = junkWord.length>5 ? junkWord.replace(/s$/,'') : junkWord;
    const offeringText = ' '+names.join(' ').toLowerCase()+' '+String(cfg.category||'').toLowerCase()+' ';
    const junk = !!junkWord && !(junkStem && offeringText.includes(junkStem));
    let status='', reason='', explained='', layer='';
    if(rule){ status='0'; reason=rule.reason; explained=rule.reason; layer='Rule'; }
    else if(junk){ status='0'; reason='Wrong intent/format ("'+junkWord+'")'; explained=reason; layer='Rule'; }
    else if(c.off && c.conf!=='low' && !guarded){ status='0'; reason=c.reason||'Off-topic (different product)'; explained=c.reason||''; layer='AI'; }
    else if(c.off && c.conf==='low' && !guarded){ status=''; explained=c.reason||''; layer='review'; }   // borderline reject → leave for human
    else { status='1'; reason='In-field'; layer=guarded?'Guard':'AI'; }
    // ICP explainer on rejects
    if(status==='0' && c.icp){ explained = (explained?explained+' — ':'')+'people searching this are most likely '+c.icp+(c.icpFit===false?", which is NOT the client's target ICP":''); }
    if(status==='1') keep++; else if(status==='0') reject++; else review++;
    return [ it.kw, it.pageType, it.topic, it.sec, it.vol, it.rel,
      status, (status===''?'':c.conf), reason, explained,
      c.audience||'', c.profession||'', c.type||'',
      modifiersOf(it.kw, cfg), isBofu(it.kw)?'Yes':'No',
      (c.services||[]).join(', '), c.icp||'', c.icpFit===false?'no':'yes' ];
  });

  const HDR = ['Primary Keyword','Page Type','Topic','Secondary Keywords','Total Search Volume','Relevance',
    'Status','Confidence','Reason','Reason Explained','Audience','Profession','Type','Modifier','BOFU','Matched Services','ICP (keyword)','ICP fit'];
  const outPath = path.isAbsolute(OUT_FILE) ? OUT_FILE : path.resolve(dir, OUT_FILE);
  fs.writeFileSync(outPath, [HDR].concat(out).map(r=>r.map(csvCell).join(',')).join('\n')+'\n');
  console.log('\nEnriched '+items.length+' topics → '+outPath);
  console.log('  keep (1): '+keep+'   reject (0): '+reject+'   review (blank): '+review);
})().catch(e=>{ console.error('FATAL: '+e.stack); process.exit(1); });
