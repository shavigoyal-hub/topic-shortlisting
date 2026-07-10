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
const FORMAT_RX=/\b(login|sign in|app|apk|download|coupon|promo code|discount code|cracked|torrent|free pdf)\b/;
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
  return [cfg.offering?('Offering: '+cfg.offering+'.'):'', sells.length?('Sells: '+sells.join(', ')+'.'):'',
    cfg.industries.length?('Ideal customers (ICP): '+cfg.industries.join(', ')+'.'):'',
    (cfg.targetProfessions&&cfg.targetProfessions.length)?('TARGET BUYER ROLES: '+cfg.targetProfessions.join(', ')+'.'):'',
    cfg.website?('Site: '+cfg.website+'.'):''].filter(Boolean).join(' ') || '(client profile not provided)';
}
const CLASSIFY_SYS = cfg => 'You are an SEO analyst classifying keywords for a client by INTENT, using the keyword and the titles of pages currently ranking.\n\nCLIENT: '+clientDesc(cfg)+'\n\nFor each keyword return: "audience" (one of: '+AUDIENCES.join(' | ')+'); "type" (broad product/service category, 1-2 words, reuse a small vocabulary); "keep" (true/false); "reason" (when keep=false, one of: '+REJECT_REASONS.join(' | ')+'; else ""); plus confidence/explain/profession below.\n\nPRIMARY TEST — topic vs the client\'s OFFERING: KEEP if the keyword is one of the client\'s listed products/services, a specific type/variant of them, or a DIRECTLY ADJACENT need for them (repair, installation, maintenance, replacement, parts, design, cost, "near me" for that product). Example: a signage client that lists "Vehicle Wraps" and sign types KEEPS "vehicle wraps", "emergency sign repair", "LED sign installation". REJECT (reason "Off-ICP audience") ONLY when the topic is a genuinely DIFFERENT product/category the client does NOT offer (e.g. a signage client rejects "plumbing repair"; a gut/candida client rejects general potassium/multivitamin). If you are unsure whether the client offers it, KEEP with confidence "low".\n\nProfession is a SIGNAL, not a hard filter — many clients (signage, printing, general B2B services) sell to almost ANY business, so a role that is not in the target list is FINE. Reject on profession ONLY when the searcher is clearly a NON-buyer: a job seeker (reason "Job-seeker intent") or a pure student/academic/researcher (reason "Researcher/student intent"). Do NOT reject just because the role is not in the target list.\n\nSet keep=false (reason "Branded query") for a SPECIFIC company OR product BRAND name — including unfamiliar ones: a proper-noun product name (e.g. "Culturelle IBS Support", "Matol KM", "Candida X") is a branded query. Do NOT reject the client\'s own generic category words. Also keep=false for pure "what is / definition / statistics" research with no buying path ("Researcher/student intent").\n\nJudge real intent from the ranking titles.\n\nReturn "confidence": "high" when the call is obvious, "low" when borderline / unsure (a human reviews the lows) — use "low" whenever you are not sure the client offers something.\nReturn "explain": a SHORT specific reason (max ~14 words) — e.g. "Listed service: vehicle wraps", "Adjacent: repair of the signs they sell", "Different product the client doesn\'t offer", "Job seeker, not a buyer".\nReturn "profession": the likely SEARCHER\'S role in 1-3 words — a client target role when it clearly fits, else a general role ("Business owner", "Facilities manager", "Marketing manager", "Consumer", "Job seeker", "Student/Researcher"). Use "General" if unclear.\nReturn ONLY JSON: {"results":[{"id":<id>,"audience":"...","type":"...","keep":true|false,"reason":"...","confidence":"high|low","explain":"...","profession":"..."}]}.';
function parseClassify(j){
  const byId={};
  (j.results||[]).forEach(o=>{ byId[String(o.id)]={ audience:AUDIENCES.indexOf(o.audience)>=0?o.audience:'General', type:String(o.type||'').slice(0,40), keep:o.keep!==false, reason:o.keep!==false?'':(REJECT_REASONS.indexOf(o.reason)>=0?o.reason:'No commercial intent'), conf:(String(o.confidence||'').toLowerCase()==='high'?'high':'low'), explain:String(o.explain||'').slice(0,160), profession:String(o.profession||'').slice(0,40) }; });
  return byId;
}
// audit config for an account (matches mbAuditCfg_): offering always from KB, rules free/jobs/format/org on
// blunt rules (free/jobs/org) over-reject whole client types (training, certification, education, recruiting,
// professional bodies) — the AI judges intent client-aware, so keep only the truly-junk 'format' rule here.
const auditCfg = names => ({ offering:'Both', website:'', services:names||[], products:[], industries:[], targetProfessions:[], competitors:[], locations:[], negatives:[], geoMode:'all', rules:{zero:false,free:false,nearme:false,competitor:false,location:false,info:false,jobs:false,format:true,org:false,lowrel:false}, lowRel:1 });

/* --------------------------- OpenAI ------------------------------ */
async function openai(messages){
  for(let attempt=0; attempt<4; attempt++){
    const resp = await fetch('https://api.openai.com/v1/chat/completions',{ method:'POST', headers:{'Authorization':'Bearer '+OPENAI_KEY,'Content-Type':'application/json'},
      body:JSON.stringify({ model:'gpt-4o-mini', temperature:0, response_format:{type:'json_object'}, messages }) });
    if(resp.status===429 || resp.status>=500){ await sleep(1500*(attempt+1)); continue; }
    if(!resp.ok) throw new Error('OpenAI '+resp.status+': '+(await resp.text()).slice(0,200));
    try{ return JSON.parse(JSON.parse(await resp.text()).choices[0].message.content); }catch(e){ return {}; }
  }
  return {};
}
async function classifyBatch(items, cfg){
  const lines = items.map(it=>JSON.stringify({id:it.id, keyword:it.kw, ranking_titles:(it.titles||[]).slice(0,6).join(' | ')})).join('\n');
  const j = await openai([{role:'system',content:CLASSIFY_SYS(cfg)},{role:'user',content:'Classify these:\n'+lines}]);
  return parseClassify(j);
}

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

  // 1) fetch PUBLISHED pages per domain (parallel)
  const fetched = await mapLimit(domains, CONC, async (d)=>{
    const sql = 'SELECT '+(C.pk?'c.'+C.pk:'NULL')+' AS kw, '+(C.topic?'c.'+C.topic:'NULL')+' AS topic, '+(C.pt?'c.'+C.pt:'NULL')+' AS pt, '+(C.vol?'c.'+C.vol:'NULL')+' AS vol, '+urlExpr+' AS url'
      +" FROM public.clusters c JOIN public.projects p ON p.id=c.p_id WHERE LOWER(p.root_domain)='"+mbEsc(d.domain)+"' AND c.page_status='PUBLISHED'"+(C.vol?' ORDER BY c.'+C.vol+' DESC NULLS LAST':'');
    const rows = (await mbRunSql(db, sql)).rows;
    const names = bestKb(mbCore(d.raw), kb);
    return { domain:d.domain, rows, names, matched:!!names.length };
  });

  // 2) build classify tasks (batches of AI_BATCH) across all accounts
  const tasks=[];
  for(const f of fetched){ if(f.__error){ console.error('  ! fetch failed '+f.domain+': '+f.__error); continue; }
    for(let i=0;i<f.rows.length;i+=AI_BATCH) tasks.push({ f, slice:f.rows.slice(i,i+AI_BATCH) });
  }
  const totalPages = fetched.reduce((n,f)=>n+((f&&f.rows)?f.rows.length:0),0);
  console.log('Total PUBLISHED pages: '+totalPages+' across '+fetched.length+' accounts, '+tasks.length+' AI batches\n');

  // 3) classify + apply rules (parallel), collect rejects
  const rejByDomain={}; let doneBatches=0;
  const results = await mapLimit(tasks, CONC, async (task)=>{
    const { f, slice } = task; const cfg = auditCfg(f.names);
    const items = slice.map((row,idx)=>({id:String(idx), kw:row[0], titles:[String(row[1]||'')]}));
    let res={}; try{ res=await classifyBatch(items, cfg); }catch(e){ res={}; }
    const out=[];
    slice.forEach((row,idx)=>{ const o=res[String(idx)]||{};
      const hit=evalRules({kw:row[0],topic:row[1],vol:row[3],pageType:row[2]}, cfg);
      let reason='', rexp='';
      if(hit){ reason=hit.reason; rexp=hit.reason; }
      else if(o.keep===false){ reason=o.reason||'Off-ICP audience'; rexp=o.explain||''; }
      if(reason) out.push([f.domain, row[0], row[2], row[1], row[3], row[4], o.audience||'', o.profession||'', o.type||'', modifiersOf(row[0],cfg), isBofu(row[0])?'Yes':'No', 0, reason, rexp, o.conf||'']);
    });
    doneBatches++; if(doneBatches%10===0||doneBatches===tasks.length) process.stdout.write('\r  classified '+doneBatches+'/'+tasks.length+' batches');
    return out;
  });
  console.log('\n');

  // 4) write output
  const HDR=['client','primaryKeyword','pageType','topic','volume','publishedUrl','Audience','Profession','Type','Modifier','BOFU','Status','Reason','Reason Explained','Confidence'];
  const allRows=[]; results.forEach(r=>{ if(Array.isArray(r)) r.forEach(row=>allRows.push(row)); });
  fs.writeFileSync(path.resolve(dir,OUT_FILE), [HDR].concat(allRows).map(r=>r.map(csvCell).join(',')).join('\n'));

  // 5) per-account summary
  const byDom={}; fetched.forEach(f=>{ if(!f.__error) byDom[f.domain]={pages:f.rows.length, matched:f.matched, rej:0}; });
  allRows.forEach(r=>{ if(byDom[r[0]]) byDom[r[0]].rej++; });
  console.log('=== per-account ===');
  for(const f of fetched){ if(f.__error) continue; const b=byDom[f.domain]; console.log('  '+f.domain.padEnd(34)+' pages '+String(b.pages).padStart(5)+'  rejected '+String(b.rej).padStart(5)+'  '+(f.matched?'['+f.names.slice(0,4).join(', ')+']':'[NO KB match]')); }
  console.log('\nWrote '+allRows.length+' rejected rows to '+OUT_FILE);
}
main().catch(e=>{ console.error('\nFATAL: '+e.message); process.exit(1); });
