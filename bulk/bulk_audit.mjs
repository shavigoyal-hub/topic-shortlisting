#!/usr/bin/env node
/**
 * Bulk published-page audit — standalone (no Apps Script, no 6-min limit).
 *
 * For every account (domain) it: pulls PUBLISHED pages from Metabase, looks up the
 * account's offering from the Client Knowledge Bases CSV, runs the SAME rules + AI
 * classify as the Sheets tool, and writes only the REJECTED (off-offering) rows.
 *
 * Usage:
 *   node bulk/bulk_audit.mjs --kb "Client Knowledge Bases.csv" --accounts domains.txt --out rejected.csv
 * Requires a .env in this folder (see .env.example). Node 18+ (built-in fetch).
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
loadEnv(path.dirname(fileURLToPath(import.meta.url)));

/* --------------------------- args -------------------------------- */
function arg(name, def){ const i=process.argv.indexOf('--'+name); return i>=0 ? process.argv[i+1] : def; }
const KB_FILE   = arg('kb', 'Client Knowledge Bases.csv');
const ACC_FILE  = arg('accounts', 'domains.txt');
const OUT_FILE  = arg('out', 'rejected.csv');
const CONC      = Number(arg('concurrency', 6));
const AI_BATCH  = Number(arg('batch', 50));
const USE_SITE  = arg('site', 'true') !== 'false';
// SERP is OPT-IN (--serp true). With gpt-4o-mini it BACKFIRED: it read competitors ranking for a client's
// own core service as proof of a "different industry" (theredpen: 0 -> 34 false rejects on 'study abroad consultants').
// It does fix word-sense misses ('application roadmap'), so revisit with a stronger model.
const USE_SERP  = arg('serp', 'true') !== 'false';
const MODEL     = arg('model', (arg('serp','true')!=='false') ? 'gpt-4o' : 'gpt-4o-mini');   // SERP reasoning needs gpt-4o; no-SERP uses cheap mini

const MB_URL  = (process.env.METABASE_URL||'').replace(/\/$/,'');
const MB_USER = process.env.METABASE_USER || process.env.METABASE_USERNAME;
const MB_PASS = process.env.METABASE_PASSWORD;
const MB_DB   = process.env.METABASE_DB || process.env.METABASE_DATABASE_ID || 'gw_stormbreaker';
const OPENAI_KEY = process.env.OPENAI_API_KEY;
for(const [k,v] of Object.entries({METABASE_URL:MB_URL,METABASE_USER:MB_USER,METABASE_PASSWORD:MB_PASS,OPENAI_API_KEY:OPENAI_KEY}))
  if(!v){ console.error('Missing '+k+' in .env'); process.exit(1); }

/* ------------------------- CSV helpers --------------------------- */
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

/* ===================================================================
 *  PORTED VERBATIM FROM gsheet/Code.gs  (rules + prompt must match)
 * =================================================================== */
const norm = s => (s==null?'':String(s)).toLowerCase();
const US_STATES=['alabama','alaska','arizona','arkansas','california','colorado','connecticut','delaware','florida','georgia','hawaii','idaho','illinois','indiana','iowa','kansas','kentucky','louisiana','maine','maryland','massachusetts','michigan','minnesota','mississippi','missouri','montana','nebraska','nevada','new hampshire','new jersey','new mexico','new york','north carolina','north dakota','ohio','oklahoma','oregon','pennsylvania','rhode island','south carolina','south dakota','tennessee','texas','utah','vermont','virginia','washington','west virginia','wisconsin','wyoming'];
const BIG_CITIES=['seattle','portland','atlanta','dallas','austin','houston','chicago','boston','denver','miami','phoenix','orlando','tacoma','india','france','mumbai','asia','usa','united states','uk','london','canada','toronto','nyc','new york','dubai','abu dhabi','singapore','sydney','melbourne','auckland','hong kong','shanghai','beijing','tokyo','kuala lumpur','jakarta','manila','bangkok','thailand','bali','goa','rishikesh','kerala','delhi','bangalore','bengaluru','chennai','pune','hyderabad','dublin','paris','berlin','munich','amsterdam','madrid','barcelona','rome','milan','zurich','geneva','vienna','stockholm','copenhagen','oslo','lisbon','athens','istanbul','tel aviv','riyadh','doha','qatar','kuwait','cape town','johannesburg','nairobi','lagos','cairo','mexico','spain','italy','germany','australia','new zealand','ireland','scotland','wales','europe','africa','middle east','vancouver','montreal','calgary','costa rica','las vegas','san francisco','los angeles','san diego','vegas','nashville','aspen','sedona','tulum'];
const MODIFIER_WORDS=['corporate','executive','executives','online','virtual','in-person','remote','hybrid','offsite','best','top','free','cheap','affordable','budget','luxury','premium','private','group','public','beginner','beginners','advanced','intermediate','basic','intro','quick','short','intensive','guided','daily','morning','evening','weekend','weekday','annual','monthly','weekly','near','local','nearby','custom','customized','customised','tailored','bespoke','professional','expert','certified','accredited','licensed','small','large','team','teams','employee','employees','staff','workplace','company','business','b2b','women','men','kids','senior','seniors','youth','student','students','new','popular','famous','rated','top-rated'];
const MODSET={}; MODIFIER_WORDS.forEach(w=>MODSET[w]=1);
const STATEset={}; US_STATES.forEach(w=>STATEset[w]=1); const CITYset={}; BIG_CITIES.forEach(w=>CITYset[w]=1);
const INFO_RX=/\b(how to|how-to|what is|what's|meaning|definition|define|youtube|you ?tube|video|videos|pdf|template|reddit|wiki|free download|guide|tutorial|at home|diy|recording|app|login|download|coupon|reviews?|quotes?|images?|examples?)\b/;
const JOBS_RX=/\b(jobs?|salary|salaries|hiring|career|careers|certification|certified|certificate|course|courses|degree|class schedule|teacher training|become a|how to become|exam|syllabus)\b/;
// NOTE: bare 'app' removed — it is a legitimate product word for any software client ("dispatch app", "booking app").
const FORMAT_RX=/\b(login|sign in|apk|download|coupon|promo code|discount code|cracked|torrent|free pdf)\b/;
const BOFU_RX=/\b(buy|buying|purchase|purchasing|order|ordering|reorder|for sale|price|prices|pricing|cost|costs|how much|cheap|cheapest|affordable|discount|quote|quotation|estimate|near me|nearby|supplier|suppliers|wholesale|bulk|vendor|vendors|manufacturer|manufacturers|distributor|distributors|compan(y|ies)|service|services|shop|store|online|hire|rent|rental|custom|customi(z|s)ed?|personali(z|s)ed?|monogram|monogrammed|engraved|branded|promotional|made to order|best|top)\b/;
const ORG_RX=/\b(institutes?|academ(y|ies)|society|societies|foundations?|associations?|ashram|sangha|vihara|monastery|university|college|ll[cp]|gmbh|pvt|dhamma|goenka|chopra|mindvalley|headspace|deepak|sadhguru|isha)\b/;
const BIG_BRANDS_RX=/\b(nvidia|google|apple|microsoft|amazon|meta|tesla|samsung|intel|ibm|oracle|salesforce|adobe|cisco|netflix|spotify|uber|airbnb|openai|nike|adidas|disney|coca[- ]?cola|pepsi|ces|wwdc|davos|web summit)\b/;
const isBofu = kw => { const t=norm(kw); if(INFO_RX.test(t)||JOBS_RX.test(t)) return false; return BOFU_RX.test(t); };
function modifiersOf(kw, cfg){
  const inds={}; (cfg&&cfg.industries||[]).forEach(i=>norm(i).split(/\s+/).forEach(w=>{ if(w) inds[w]=1; }));
  const seen={}, out=[];
  norm(kw).split(/[^a-z0-9]+/).filter(Boolean).forEach(w=>{ if((MODSET[w]||STATEset[w]||CITYset[w]||inds[w]) && !seen[w]){ seen[w]=1; out.push(w); } });
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
const AUDIENCES=['B2B / Corporate','Healthcare / Clinical','Aspiring Practitioner','Athlete / Sports','Local Seeker','Individual / Consumer','Researcher / Student','General'];
const REJECT_REASONS=['Job-seeker intent','Researcher/student intent','Branded query','Off-ICP audience','No commercial intent'];
function clientDesc(cfg){
  const sells=(cfg.services||[]).concat(cfg.products||[]);
  return [cfg.category?('BUSINESS CATEGORY (this IS the client\'s field — anything in this category is in-field): '+cfg.category+'.'):'', cfg.identity?('This company is: '+cfg.identity+'.'):'', cfg.offering?('Offering: '+cfg.offering+'.'):'', sells.length?('Sells: '+sells.join(', ')+'.'):'',
    cfg.industries.length?('Ideal customers (ICP): '+cfg.industries.join(', ')+'.'):'',
    (cfg.targetProfessions&&cfg.targetProfessions.length)?('TARGET BUYER ROLES: '+cfg.targetProfessions.join(', ')+'.'):'',
    cfg.website?('Site: '+cfg.website+'.'):''].filter(Boolean).join(' ') || '(client profile not provided)';
}
// AUDIT prompt — ONE decision: is the page TOPIC about what the client offers, or a genuinely DIFFERENT product/industry?
// Deliberately ignores search intent / audience / student-researcher / branded — those over-rejected on-topic pages.
const CLASSIFY_SYS = cfg => 'You audit a client\'s already-PUBLISHED web pages. Decide ONLY one thing, the same way for EVERY industry: is the page TOPIC within the client\'s field/offering, or a genuinely DIFFERENT product / service / industry?\n\nCLIENT: '+clientDesc(cfg)+'\n\nKEEP (off=false) if the topic is one of the client\'s products/services, OR a category, type, model, variant, brand, color, size, feature, part, or accessory of what they sell, OR content about their field — INCLUDING how-to, guide, ideas, "what is", certification, exam, course, training, comparison, "best X", cost/price, reviews, or "near me". The client\'s listed offerings are EXAMPLES, NOT an exhaustive list — judge the whole field/category they operate in, not only the exact items listed. When a topic is a SERVICE applied to a target market ("<service> for <industry>"), judge it by the SERVICE, not the market — the named industry is merely who the service is sold to, NOT a different offering. Search INTENT and whether the searcher looks like a student / researcher / job-seeker DO NOT matter and are NEVER a reason to reject.\n\nHOW TO READ ranking_titles (the actual top-10 Google results — do this in two steps):\n  STEP 1: From the ranking_titles, name the single INDUSTRY / FIELD these results belong to, ignoring the client entirely (e.g. "software product management", "overseas education consulting", "commercial signage", "automotive glass").\n  STEP 2: Compare that field to the client\'s BUSINESS CATEGORY (stated in CLIENT above). Treat them as the SAME whenever they describe the same KIND of business, even if worded differently. CRITICAL: if the ranking pages are the client\'s COMPETITORS, or a directory / "best X in <city>" / "top X consultants" list of businesses in the client\'s own category, that is PROOF the keyword IS the client\'s category → off=false (KEEP). A SERP full of competitors is the strongest possible signal that the client belongs there — it is NEVER a reason to reject. Example: for an overseas-admissions consultancy, "study abroad consultants in <city>" returns competing consultancies = the client\'s category = KEEP.\n    Set off=true ONLY when the ranking field is a clearly DIFFERENT business category from the client\'s — e.g. the keyword shares the word "application" but the results are all software product-roadmap tools while the client does university admissions. A shared word with a different meaning is a coincidence, not a match. When the field matches the client\'s category, KEEP even if the exact wording isn\'t in the client\'s item list.\n\nREJECT (off=true) ONLY when you are CONFIDENT the topic is a DIFFERENT product, service, or industry the client clearly does NOT provide. If the topic could plausibly belong to the client\'s field or product line, KEEP. When unsure, KEEP.\n\nAlso return audience/type/profession for reporting only (they never drive the decision).\n\nTARGET ICP (customer segments this client sells to): '+(cfg.anyBusiness ? 'ANY business or consumer — this is a HORIZONTAL offering, so EVERY keyword fits the ICP (icpFit is always true).' : ((cfg.icps&&cfg.icps.length) ? cfg.icps.join('; ') : 'not specified — treat icpFit as true'))+'\nFor each keyword ALSO return: "icp" = the single customer segment/industry the page targets (short phrase, e.g. "restaurants", "hospitals", "homeowners", "general business"); "icpFit" = true if that segment is one of the client\'s target ICPs above OR the client is horizontal, else false. icpFit is INDEPENDENT of off (a page can be on-topic but target a segment the client does not serve). If unsure, icpFit=true.\nAlso return "services": the client\'s own listed products/services (copied from the CLIENT offering above, verbatim) that this keyword maps to — an array, most relevant first, max 4; [] if the keyword maps to none of them.\nReturn ONLY JSON: {"results":[{"id":<id>,"off":true|false,"reason":"<if off: the different product/industry, <=12 words; else \'\'>","confidence":"high|low","audience":"...","type":"...","profession":"...","icp":"...","icpFit":true|false,"services":["..."]}]}.';
function parseClassify(j){
  const byId={};
  (j.results||[]).forEach(o=>{ byId[String(o.id)]={ off:o.off===true, reason:String(o.reason||'').slice(0,160), conf:(String(o.confidence||'').toLowerCase()==='high'?'high':'low'), audience:String(o.audience||'General').slice(0,40), type:String(o.type||'').slice(0,40), profession:String(o.profession||'').slice(0,40), icp:String(o.icp||'').slice(0,50), icpFit:o.icpFit!==false, services:(Array.isArray(o.services)?o.services:[]).map(s=>String(s).trim()).filter(Boolean).slice(0,4) }; });
  return byId;
}
// audit config for an account (matches mbAuditCfg_): offering always from KB, rules free/jobs/format/org on
// blunt rules (free/jobs/org) over-reject whole client types (training, certification, education, recruiting,
// professional bodies) — the AI judges intent client-aware, so keep only the truly-junk 'format' rule here.
/* DETERMINISTIC IN-FIELD GUARD — the model sometimes rejects a keyword whose exact product/service is
   sitting in the client's own offering list (long lists especially). Prompting didn't fix it, so this is a
   hard code-level veto: if a meaningful term from the keyword appears in the offering, it CANNOT be rejected.
   Industry-agnostic, and it errs toward keep — which is the stated priority (never reject a relevant keyword). */
const GENERIC=new Set(['the','and','for','with','your','you','are','can','how','what','why','does','from','that','this','into','best','top','near','free','cost','price','guide','tips','ideas','service','services','product','products','solution','solutions','company','companies','custom','professional','online','list','types','type','about','more','other','their','they','when','where','which','will','make','made','need','using','used','vs']);
const stem = t => t.replace(/ies$/,'y').replace(/s$/,'');
function inOffering(kw, names){
  if(!names || !names.length) return false;
  const hayToks = names.join(' ').toLowerCase().replace(/[^a-z0-9]+/g,' ').split(' ').filter(Boolean).map(stem);
  const hay = new Set(hayToks), hayStr = ' '+hayToks.join(' ')+' ';
  const toks = String(kw||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').split(' ').filter(t=>t && t.length>=4 && !GENERIC.has(t)).map(stem);
  for(let i=0;i<toks.length-1;i++){ if(hayStr.includes(' '+toks[i]+' '+toks[i+1]+' ')) return true; }   // phrase match (strong)
  return toks.some(t => t.length>=4 && hay.has(t));   // single term — 4 chars matters ("sign","door","wrap","skin","gel")
}
/* CATEGORY GUARD — applies EVEN with SERP on. A keyword containing a distinctive word from the client's own
   BUSINESS CATEGORY (admissions, consultants, signage, windshield…) is their field by definition, so SERP must
   not reject it (that was the residual failure: 'stanford admissions', 'study abroad consultants in <city>').
   Uses 5-char prefix matching so consulting~consultants, admissions~admission, educational~education. */
const CATSTOP=new Set(['services','service','solutions','solution','company','companies','group','agency','firm','and','the','for','with','your','business','industry','provider','providers','professional']);
function inCategory(kw, category){
  if(!category) return false;
  const catToks = String(category).toLowerCase().replace(/[^a-z0-9]+/g,' ').split(' ').filter(t=>t.length>=5 && !CATSTOP.has(t)).map(t=>t.slice(0,5));
  if(!catToks.length) return false;
  const kwToks = String(kw||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').split(' ').filter(t=>t.length>=5).map(t=>t.slice(0,5));
  const set = new Set(catToks);
  return kwToks.some(t=>set.has(t));
}
const auditCfg = (names, icps, anyBusiness) => ({ offering:'Both', website:'', services:names||[], products:[], industries:[], targetProfessions:[], competitors:[], locations:[], negatives:[], geoMode:'all', icps:icps||[], anyBusiness:!!anyBusiness, rules:{zero:false,free:false,nearme:false,competitor:false,location:false,info:false,jobs:false,format:true,org:false,lowrel:false}, lowRel:1 });

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

/* ------------------- SERP (what the keyword actually MEANS) -------------------
   Word overlap alone can't tell "college application" from "application roadmap" (software).
   The ranking pages can. Fetched per keyword using the client's REAL target_geographies gl,
   cached to serp_cache.json so re-runs cost nothing. */
const SERPER_KEY = process.env.SERPER_KEY;
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

/* ------------------- WEBSITE GROUNDING ------------------- */
// fetch the client's real site (homepage + likely service pages) and reduce to text
function htmlToText(html){ return String(html).replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&[a-z#0-9]+;/gi,' ').replace(/\s+/g,' ').trim(); }
async function fetchSiteText(domain){
  const paths=['','services','solutions','products','what-we-do','offerings','about'];
  let text='';
  for(const p of paths){ if(text.length>9000) break;
    try{ const r=await fetch('https://'+domain+'/'+p, {headers:{'User-Agent':'Mozilla/5.0 (compatible; TopicAudit/1.0)'}, redirect:'follow', signal:AbortSignal.timeout(12000)});
      if(r.ok){ const t=htmlToText(await r.text()); if(t) text+=' '+t; } }catch(e){}
  }
  return text.slice(0,9000);
}
// one AI call → the concrete products/services the site actually sells
async function deriveOffering(text){
  if(!text || text.length<50) return [];
  const j=await openai([
    {role:'system',content:'From this company website text, list the concrete PRODUCTS and SERVICES the company offers — short noun phrases, most important first, max 25. Ignore nav/blog/legal boilerplate. Return ONLY JSON: {"offering":["..."]}.'},
    {role:'user',content:text.slice(0,9000)}
  ]);
  return (j.offering||[]).map(s=>String(s).trim()).filter(Boolean).slice(0,30);
}
function loadSiteCache(dir){ try{ return JSON.parse(fs.readFileSync(path.resolve(dir,'site_cache.json'),'utf8')); }catch(e){ return {}; } }
function saveSiteCache(dir, m){ try{ fs.writeFileSync(path.resolve(dir,'site_cache.json'), JSON.stringify(m,null,0)); }catch(e){} }

/* ------------------- TARGET ICP (experimental, separate column) ------------------- */
// from the merged offering, derive the EXHAUSTIVE list of customer segments the client can sell to (+ horizontal flag)
async function deriveICP(names, domain){
  if(!names || !names.length) return {icps:[], anyBusiness:false};
  const j=await openai([
    {role:'system',content:'You are an ICP analyst. Given a company\'s products/services, list EXHAUSTIVELY every customer segment / industry / business type they could realistically sell to — be generous and complete (aim for 10-40 segments). Also set "anyBusiness" true when the offering is HORIZONTAL — sold to essentially ANY business or consumer (e.g. signage, printing, general marketing, office supplies, generic B2B software, cleaning, logistics) — so ICP filtering should effectively be OFF. Return ONLY JSON: {"icps":["..."],"anyBusiness":true|false}.'},
    {role:'user',content:'Company: '+domain+'\nOffers: '+names.slice(0,40).join(', ')}
  ]);
  return {icps:(j.icps||[]).map(s=>String(s).trim()).filter(Boolean).slice(0,60), anyBusiness:j.anyBusiness===true};
}
function loadIcpCache(dir){ try{ return JSON.parse(fs.readFileSync(path.resolve(dir,'icp_cache.json'),'utf8')); }catch(e){ return {}; } }
function saveIcpCache(dir, m){ try{ fs.writeFileSync(path.resolve(dir,'icp_cache.json'), JSON.stringify(m,null,0)); }catch(e){} }

/* ------------------- BUSINESS CATEGORY (the fix that makes SERP safe) -------------------
   Both models wrongly reject a client's OWN category keyword because that SERP is full of competitors.
   The cure is a reliable high-level category so the judge can see "study abroad consultants" == the client. */
async function deriveCategory(name, names, icps){
  const j = await openai([
    {role:'system',content:'In 3-8 words, name this company\'s single primary BUSINESS CATEGORY / industry as a searcher would recognise it — the umbrella term for what they do, broad enough that a directory of their competitors would sit under it. Examples: "overseas university admissions consulting", "commercial signage manufacturer & installer", "freight brokerage software", "executive recruiting firm", "aircraft windshield manufacturer". Return ONLY JSON: {"category":"..."}.'},
    {role:'user',content:'Company: '+(name||'')+'\nOffers: '+(names||[]).slice(0,30).join(', ')+'\nSells to: '+(icps||[]).slice(0,10).join(', ')}
  ]);
  return String(j.category||'').trim().slice(0,80);
}
function loadCatCache(dir){ try{ return JSON.parse(fs.readFileSync(path.resolve(dir,'category_cache.json'),'utf8')); }catch(e){ return {}; } }
function saveCatCache(dir, m){ try{ fs.writeFileSync(path.resolve(dir,'category_cache.json'), JSON.stringify(m,null,0)); }catch(e){} }

/* --------------------------- Metabase ---------------------------- */
let SESSION=null;
async function mbLogin(){
  if(SESSION) return SESSION;
  const r = await fetch(MB_URL+'/api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:MB_USER,password:MB_PASS})});
  if(!r.ok) throw new Error('Metabase login failed: '+(await r.text()).slice(0,300));
  SESSION=(await r.json()).id; return SESSION;
}
async function mbDbId(){
  if(/^\d+$/.test(String(MB_DB))) return Number(MB_DB);
  const r = await fetch(MB_URL+'/api/database',{headers:{'X-Metabase-Session':SESSION}});
  const list=((await r.json()).data)||[]; const m=list.find(db=>(db.name||'').toLowerCase()===String(MB_DB).toLowerCase());
  if(!m) throw new Error('DB not found. Available: '+list.map(d=>d.name).join(', ')); return m.id;
}
async function mbRunSql(db, sql){
  const r = await fetch(MB_URL+'/api/dataset',{method:'POST',headers:{'X-Metabase-Session':SESSION,'Content-Type':'application/json'},
    body:JSON.stringify({type:'native',native:{query:sql},database:db,constraints:{'max-results':1000000,'max-results-bare-rows':1000000}})});
  if(r.status!==200 && r.status!==202) throw new Error('Query failed: '+r.status+' '+(await r.text()).slice(0,400));
  const body=await r.json(); if(body.status==='failed'||body.error) throw new Error('Metabase error: '+String(body.error||'').slice(0,300));
  const d=body.data||{}; return {cols:(d.cols||[]).map(c=>c.name||c.display_name), rows:d.rows||[]};
}
// Real per-client geo + ICP straight from Metabase (public.projects.company_info jsonb).
// target_geographies is already ISO ("us","in") -> Serper gl. target_customer_segments is the actual ICP,
// so we don't have to guess it with an AI call.
async function mbCompanyInfo(db, domains){
  const list = domains.map(d=>"'"+mbEsc(d)+"'").join(',');
  const r = await mbRunSql(db, "SELECT LOWER(root_domain), company_info->>'target_geographies', company_info->>'target_customer_segments', company_info->>'service_areas', company_info->>'business_category', company_info->>'name', company_info->>'value_propositions' FROM public.projects WHERE LOWER(root_domain) IN ("+list+")");
  const parse = s => { try{ const a=JSON.parse(s||'[]'); return Array.isArray(a)?a.map(String).filter(Boolean):[]; }catch(e){ return []; } };
  const nm = s => { try{ const o=JSON.parse(s||'{}'); return o.company_name||o.dba_name||o.legal_name||''; }catch(e){ return String(s||''); } };
  const m = {};
  for(const row of r.rows){ const cats=parse(row[4]);
    m[String(row[0])] = { geo:parse(row[1]), icps:parse(row[2]), areas:parse(row[3]), category:cats, name:nm(row[5]), valueProps:parse(row[6]) }; }
  return m;
}
async function mbClusterCols(db){
  const r = await mbRunSql(db, "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='clusters'");
  const names=r.rows.map(x=>String(x[0]));
  const find=cands=>{ for(const c of cands){ const e=names.find(n=>n.toLowerCase()===c); if(e) return e; } for(const c of cands){ const p=names.find(n=>n.toLowerCase().includes(c)); if(p) return p; } return null; };
  return { pk:find(['primary_kw','primary_keyword','keyword']), topic:find(['topic']), pt:find(['page_type','type']), vol:find(['volume','search_volume','msv']), url:find(['published_url','page_url','url']), slug:find(['slug']) };
}
const mbEsc = s => String(s).replace(/'/g,"''");
const mbNormDomain = s => String(s||'').toLowerCase().replace(/^https?:\/\//,'').replace(/^www\./,'').replace(/\/.*$/,'').trim();
const mbCore = s => String(s||'').toLowerCase().replace(/^https?:\/\//,'').replace(/^www\./,'').split('/')[0].split('.')[0].replace(/[^a-z0-9]/g,'');

/* --------------------------- utils ------------------------------- */
const sleep = ms => new Promise(r=>setTimeout(r,ms));
async function mapLimit(items, limit, fn){
  const out=new Array(items.length); let idx=0;
  async function worker(){ while(idx<items.length){ const i=idx++; try{ out[i]=await fn(items[i],i); }catch(e){ out[i]={__error:e.message}; } } }
  await Promise.all(Array.from({length:Math.min(limit,items.length)},worker));
  return out;
}

/* --------------------------- KB lookup --------------------------- */
function buildKb(csvText){
  const rows=parseCSV(csvText); if(!rows.length) return {};
  const head=rows[0].map(h=>String(h).toLowerCase());
  const hf=(...subs)=>{ for(let i=0;i<head.length;i++) for(const s of subs) if(head[i].includes(s)) return i; return -1; };
  const kd=hf('website','url','domain'), kc=hf('client','company','account','brand'), pc=hf('product'), sc=hf('service'), oc=hf('offering','description');
  const map={};
  for(let i=1;i<rows.length;i++){ const r=rows[i]; const nm=[];
    [pc,sc,oc].forEach(c=>{ if(c>=0) String(r[c]||'').split(/[,\n;\/]+/).forEach(x=>{ x=x.trim(); if(x) nm.push(x); }); });
    if(!nm.length) continue;
    [kd,kc].forEach(c=>{ if(c>=0){ const k=mbCore(r[c]); if(k) map[k]=nm; } });
  }
  return map;
}
function bestKb(core, kb){
  if(!core) return []; if(kb[core]) return kb[core];
  for(const k of Object.keys(kb)){ if(k.length>=5 && core.length>=5 && (k.includes(core)||core.includes(k))) return kb[k]; }
  return [];
}

/* ============================== main ============================== */
async function main(){
  const dir = process.cwd();
  const kbPath = path.resolve(dir, KB_FILE), accPath = path.resolve(dir, ACC_FILE);
  if(!fs.existsSync(kbPath)){ console.error('KB CSV not found: '+kbPath); process.exit(1); }
  if(!fs.existsSync(accPath)){ console.error('Accounts file not found: '+accPath); process.exit(1); }

  const kb = buildKb(fs.readFileSync(kbPath,'utf8'));
  console.log('KB entries loaded: '+Object.keys(kb).length);

  // accounts: one domain per line (txt), or first column of a CSV
  let accountsRaw = fs.readFileSync(accPath,'utf8');
  let domains;
  if(/\.csv$/i.test(accPath)){ const rows=parseCSV(accountsRaw); const start=/domain|client|website|url/i.test(String(rows[0]&&rows[0][0]))?1:0; domains=rows.slice(start).map(r=>r[0]); }
  else domains = accountsRaw.split(/\r?\n/);
  domains = domains.map(d=>({raw:d, domain:mbNormDomain(d)})).filter(d=>d.domain && d.domain!=='example.com');
  // de-dup
  const seen=new Set(); domains=domains.filter(d=>!seen.has(d.domain)&&seen.add(d.domain));
  console.log('Accounts to audit: '+domains.length);

  await mbLogin(); const db = await mbDbId(); const C = await mbClusterCols(db);
  const urlExpr = C.url ? ('c.'+C.url) : (C.slug ? "('https://' || p.root_domain || '/' || COALESCE(c."+C.slug+",''))" : 'NULL');
  console.log('Metabase columns:', JSON.stringify(C));

  // 1) fetch PUBLISHED pages + ground the offering in the client's real website + derive target ICP (parallel)
  const siteCache = USE_SITE ? loadSiteCache(dir) : {};
  const icpCache = loadIcpCache(dir);
  const catCache = loadCatCache(dir);
  if(USE_SITE) console.log('Website grounding: ON (fetching each client site + merging with KB)');
  const company = await mbCompanyInfo(db, domains.map(d=>d.domain));
  const nGeo = Object.values(company).filter(c=>c.geo.length).length, nIcp = Object.values(company).filter(c=>c.icps.length).length;
  console.log('Metabase company_info: geo for '+nGeo+'/'+domains.length+' domains, real ICP for '+nIcp+'/'+domains.length+' (AI-derived ICP only as fallback)');
  const fetched = await mapLimit(domains, CONC, async (d)=>{
    const sql = 'SELECT '+(C.pk?'c.'+C.pk:'NULL')+' AS kw, '+(C.topic?'c.'+C.topic:'NULL')+' AS topic, '+(C.pt?'c.'+C.pt:'NULL')+' AS pt, '+(C.vol?'c.'+C.vol:'NULL')+' AS vol, '+urlExpr+' AS url'
      +" FROM public.clusters c JOIN public.projects p ON p.id=c.p_id WHERE LOWER(p.root_domain)='"+mbEsc(d.domain)+"' AND c.page_status='PUBLISHED'"+(C.vol?' ORDER BY c.'+C.vol+' DESC NULLS LAST':'');
    const rows = (await mbRunSql(db, sql)).rows;
    const kbNames = bestKb(mbCore(d.raw), kb);
    let siteNames = [];
    if(USE_SITE){
      if(Array.isArray(siteCache[d.domain])) siteNames = siteCache[d.domain];
      else { try{ siteNames = await deriveOffering(await fetchSiteText(d.domain)); }catch(e){ siteNames = []; } siteCache[d.domain] = siteNames; }
    }
    const seen=new Set(), names=[]; [...kbNames, ...siteNames].forEach(x=>{ const k=String(x).toLowerCase(); if(x && !seen.has(k)){ seen.add(k); names.push(x); } });
    const ci = company[d.domain] || {geo:[], icps:[], areas:[], category:''};
    let icp;
    if(ci.icps.length){ icp = {icps:ci.icps, anyBusiness:false}; }                                   // real ICP from Metabase — no AI guess needed
    else { icp = icpCache[d.domain]; if(!icp){ try{ icp = await deriveICP(names, d.domain); }catch(e){ icp = {icps:[], anyBusiness:false}; } icpCache[d.domain] = icp; } }
    const gl = (ci.geo[0]||'us').toLowerCase();                                                      // target_geographies is already ISO ("us","in")
    // BUSINESS CATEGORY — from Metabase business_category if present, else derived once (cached)
    let category = (ci.category&&ci.category.length) ? ci.category.slice(0,4).join(', ') : catCache[d.domain];
    if(category===undefined || category===null){ try{ category = await deriveCategory(ci.name, names, icp.icps); }catch(e){ category=''; } catCache[d.domain]=category; }
    const identity = [ (ci.name||d.domain), category?('— a '+category):'',
      (ci.areas&&ci.areas.length)?('serving '+ci.areas.slice(0,4).join(', ')):'' ].filter(Boolean).join(' ');
    return { domain:d.domain, rows, names, kbNames, siteNames, matched:!!names.length, nKb:kbNames.length, nSite:siteNames.length,
             icps:icp.icps||[], anyBusiness:!!icp.anyBusiness, gl, areas:ci.areas||[], icpFromMetabase:!!ci.icps.length, identity, category };
  });
  if(USE_SITE) saveSiteCache(dir, siteCache);
  saveIcpCache(dir, icpCache);
  saveCatCache(dir, catCache);
  // dump the derived ICP list per account for review
  fs.writeFileSync(path.resolve(dir,'icp_by_account.csv'), [['client','anyBusiness','targetICPs'].join(',')].concat(
    fetched.filter(f=>!f.__error).map(f=>[f.domain, f.anyBusiness?'ANY business':'no', (f.icps||[]).join('; ')].map(csvCell).join(','))).join('\n'));

  // 2) build classify tasks (batches of AI_BATCH) across all accounts
  const tasks=[];
  for(const f of fetched){ if(f.__error){ console.error('  ! fetch failed '+f.domain+': '+f.__error); continue; }
    for(let i=0;i<f.rows.length;i+=AI_BATCH) tasks.push({ f, slice:f.rows.slice(i,i+AI_BATCH) });
  }
  const totalPages = fetched.reduce((n,f)=>n+((f&&f.rows)?f.rows.length:0),0);
  console.log('Total PUBLISHED pages: '+totalPages+' across '+fetched.length+' accounts, '+tasks.length+' AI batches\n');

  // 3) classify + apply rules (parallel); flag OFF-TOPIC and (separately) NOT-TARGET-ICP
  let doneBatches=0, vetoed=0, catVetoed=0, serpFetched=0; const vetoRows=[]; const serpCache = USE_SERP ? loadSerpCache(dir) : {};
  const results = await mapLimit(tasks, CONC, async (task)=>{
    const { f, slice } = task; const cfg = auditCfg(f.names, f.icps, f.anyBusiness); cfg.identity = f.identity; cfg.category = f.category;
    const serps = await mapLimit(slice, 8, async row=>{
      if(!USE_SERP) return {titles:[],domains:[]};
      const k=(f.gl||'us')+'|'+String(row[0]||'').toLowerCase();
      if(serpCache[k]) return serpCache[k];
      const r=await serper(row[0], f.gl); serpCache[k]=r; serpFetched++; return r;
    });
    const items = slice.map((row,idx)=>({id:String(idx), kw:row[0], topic:String(row[1]||''), titles:(serps[idx]&&serps[idx].titles)||[]}));
    let res={}; try{ res=await classifyBatch(items, cfg); }catch(e){ res={}; }
    const out=[];
    slice.forEach((row,idx)=>{ const o=res[String(idx)]||{};
      const hit=evalRules({kw:row[0],topic:row[1],vol:row[3],pageType:row[2]}, cfg);
      let reason='', rexp='';
      if(hit){ reason=hit.reason; rexp=hit.reason; }                                             // rule junk
      else if(o.off===true && inCategory(row[0], f.category)){ catVetoed++; }   // client's OWN category term — never reject, even with SERP
      else if(o.off===true && !(serps[idx]&&serps[idx].titles.length) && inOffering(row[0], f.names)){ vetoed++; vetoRows.push([f.domain, row[0], row[1], o.reason||'']); }   // offering guard only where SERP gave no evidence
      else if(o.off===true){ reason='Off-topic (different product)'; rexp=o.reason||''; }         // different product/industry
      else if(!f.anyBusiness && o.icpFit===false){ reason='Not our target ICP'; rexp=''; }        // outside ICP only
      if(reason){
        // explainer: name the likely searcher segment, and flag when it's outside the client's ICP (vertical clients only)
        if(o.icp && !f.anyBusiness){ rexp = (rexp ? rexp+' — ' : '') + 'people searching this are most likely ' + o.icp + (o.icpFit===false ? ", which is NOT the client's target ICP" : ''); }
        out.push([f.domain, row[0], row[2], row[1], row[3], row[4],
          (f.kbNames||[]).join(', '), (f.siteNames||[]).join(', '),
          (o.services||[]).join(', '), o.audience||'', o.profession||'', o.type||'',
          (o.icp||''), (f.icps||[]).join(', '),
          modifiersOf(row[0],cfg), isBofu(row[0])?'Yes':'No', 0, reason, rexp, o.conf||'']);
      }
    });
    doneBatches++; if(doneBatches%10===0||doneBatches===tasks.length) process.stdout.write('\r  classified '+doneBatches+'/'+tasks.length+' batches');
    return out;
  });
  if(USE_SERP) saveSerpCache(dir, serpCache);
  console.log('\n  SERP: '+serpFetched+' new lookups | category-guard kept '+catVetoed+' (own-category terms) | offering-guard kept '+vetoed+'\n');
  if(vetoRows.length) fs.writeFileSync(path.resolve(dir,'vetoed.csv'), [['client','primaryKeyword','topic','AI wanted to reject because'].join(',')].concat(vetoRows.map(r=>r.map(csvCell).join(','))).join('\n'));

  // 4) write output — one merged reject list (off-topic OR not-target-ICP); Reason says which, Reason Explained names the likely ICP
  const HDR=['client','primaryKeyword','pageType','topic','volume','publishedUrl',
    'Products/Services (KB/Metabase)','Products/Services (Website)',
    'Matched Services','Audience','Profession','Type',
    'ICP (keyword)','Target ICP (client, from products/services)',
    'Modifier','BOFU','Status','Reason','Reason Explained','Confidence'];
  const allRows=[]; results.forEach(r=>{ if(Array.isArray(r)) r.forEach(row=>allRows.push(row)); });
  fs.writeFileSync(path.resolve(dir,OUT_FILE), [HDR].concat(allRows).map(r=>r.map(csvCell).join(',')).join('\n'));

  // 5) per-account summary (total rejected, of which ICP-reason)
  const byDom={}; fetched.forEach(f=>{ if(!f.__error) byDom[f.domain]={pages:f.rows.length, rej:0, icp:0}; });
  allRows.forEach(r=>{ const b=byDom[r[0]]; if(b){ b.rej++; if(r[17]==='Not our target ICP') b.icp++; } });
  console.log('=== per-account   (ICP* = real, from Metabase | ICP~ = AI-guessed fallback) ===');
  for(const f of fetched){ if(f.__error) continue; const b=byDom[f.domain];
    console.log('  '+f.domain.padEnd(30)+' pages '+String(b.pages).padStart(4)+'  rejected '+String(b.rej).padStart(4)+'  gl='+(f.gl||'us')+'  '+(f.anyBusiness?'[ANY business]':'[ICP'+(f.icpFromMetabase?'*':'~')+': '+(f.icps||[]).slice(0,3).join(', ')+']')); }
  console.log('\nWrote '+allRows.length+' rejected rows to '+OUT_FILE+'; ICP lists in icp_by_account.csv');
}
main().catch(e=>{ console.error('\nFATAL: '+e.message); process.exit(1); });
