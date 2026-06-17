/**********************************************************************
 * Topic Shortlisting Tool — Google Sheets / Apps Script edition
 * Full port of the rule engine + Serper SERP + OpenAI classify/self-review.
 *
 * SHEETS USED (created automatically by "Setup ▸ Initialise"):
 *   AKR     — paste/import your raw keyword report here
 *   Config  — client profile + rule toggles (key/value)
 *   Topics  — the working table (rules + AI write here; you pick here)
 *   _Cache  — hidden: per-keyword SERP + AI cache (so nothing re-runs)
 *
 * API KEYS live in Script Properties (Setup ▸ Set API keys), never in the sheet.
 * Large sets are processed in chunks to stay under the 6-min execution limit.
 **********************************************************************/

/* ----------------------------- CONFIG ----------------------------- */
var SHEET = { AKR:'AKR', CONFIG:'Config', TOPICS:'Topics', CACHE:'_Cache' };
// Topics columns (1-indexed)
var COL = { KW:1, PT:2, TOPIC:3, SEC:4, VOL:5, REL:6, AUD:7, TYPE:8, BOFU:9, STATUS:10, REASON:11, LAYER:12, DOMAINS:13, RVERDICT:14, RREASON:15 };
var TOPIC_HEADERS = ['Keyword','Page Type','Topic','Secondary','Volume','Relevance','Audience','Type','BOFU','Status','Reason','Layer','_domains','Review','Review Reason'];
var BATCH = 100;     // Topics rows enriched per run (SERP+AI)
var AI_BATCH = 30;   // keywords per OpenAI call

/* --------------------------- RULE LEXICON ------------------------- */
function norm(s){ return (s==null?'':String(s)).toLowerCase(); }
var US_STATES = ['alabama','alaska','arizona','arkansas','california','colorado','connecticut','delaware','florida','georgia','hawaii','idaho','illinois','indiana','iowa','kansas','kentucky','louisiana','maine','maryland','massachusetts','michigan','minnesota','mississippi','missouri','montana','nebraska','nevada','new hampshire','new jersey','new mexico','new york','north carolina','north dakota','ohio','oklahoma','oregon','pennsylvania','rhode island','south carolina','south dakota','tennessee','texas','utah','vermont','virginia','washington','west virginia','wisconsin','wyoming'];
var BIG_CITIES = ['seattle','portland','atlanta','dallas','austin','houston','chicago','boston','denver','miami','phoenix','orlando','tacoma','india','france','mumbai','asia','usa','united states','uk','london','canada','toronto','nyc','new york','dubai','abu dhabi','singapore','sydney','melbourne','auckland','hong kong','shanghai','beijing','tokyo','kuala lumpur','jakarta','manila','bangkok','thailand','bali','goa','rishikesh','kerala','delhi','bangalore','bengaluru','chennai','pune','hyderabad','dublin','paris','berlin','munich','amsterdam','madrid','barcelona','rome','milan','zurich','geneva','vienna','stockholm','copenhagen','oslo','lisbon','athens','istanbul','tel aviv','riyadh','doha','qatar','kuwait','cape town','johannesburg','nairobi','lagos','cairo','mexico','spain','italy','germany','australia','new zealand','ireland','scotland','wales','europe','africa','middle east','vancouver','montreal','calgary','costa rica','las vegas','san francisco','los angeles','san diego','vegas','nashville','aspen','sedona','tulum'];
var LOC_ALIAS = {'nyc':'new york','new york city':'new york','manhattan':'new york','brooklyn':'new york','queens':'new york','bronx':'new york','la':'los angeles','sf':'san francisco','bay area':'san francisco','dc':'washington','washington dc':'washington','philly':'philadelphia','vegas':'las vegas','nj':'new jersey','ct':'connecticut'};
function locAlias(s){ return LOC_ALIAS[s]||s; }
var INFO_RX = /\b(how to|how-to|what is|what's|meaning|definition|define|youtube|you ?tube|video|videos|pdf|template|reddit|wiki|free download|guide|tutorial|at home|diy|recording|app|login|download|coupon|reviews?|quotes?|images?|examples?)\b/;
var JOBS_RX = /\b(jobs?|salary|salaries|hiring|career|careers|certification|certified|certificate|course|courses|degree|class schedule|teacher training|become a|how to become|exam|syllabus)\b/;
var FORMAT_RX = /\b(login|sign in|app|apk|download|coupon|promo code|discount code|cracked|torrent|free pdf)\b/;
var BOFU_RX = /\b(buy|buying|purchase|purchasing|order|ordering|reorder|for sale|price|prices|pricing|cost|costs|how much|cheap|cheapest|affordable|discount|quote|quotation|estimate|near me|nearby|supplier|suppliers|wholesale|bulk|vendor|vendors|manufacturer|manufacturers|distributor|distributors|compan(y|ies)|service|services|shop|store|online|hire|rent|rental|custom|customi(z|s)ed?|personali(z|s)ed?|monogram|monogrammed|engraved|branded|promotional|made to order|best|top)\b/;
var ORG_RX = /\b(institutes?|academ(y|ies)|society|societies|foundations?|associations?|ashram|sangha|vihara|monastery|university|college|ll[cp]|gmbh|pvt|dhamma|goenka|chopra|mindvalley|headspace|deepak|sadhguru|isha)\b/;
var BIG_BRANDS_RX = /\b(nvidia|google|apple|microsoft|amazon|meta|tesla|samsung|intel|ibm|oracle|salesforce|adobe|cisco|netflix|spotify|uber|airbnb|openai|nike|adidas|disney|coca[- ]?cola|pepsi|ces|wwdc|davos|web summit)\b/;
var IGNORE_DOMAINS = /(wikipedia|wikihow|britannica|fandom|youtube|youtu\.be|vimeo|reddit|quora|stackexchange|stackoverflow|medium\.com|tumblr|facebook|instagram|tiktok|twitter|x\.com|pinterest|linkedin\.com|snapchat|threads\.net|discord|news\.ycombinator)/;

function isBofu(kw){ var t=norm(kw); if(INFO_RX.test(t)||JOBS_RX.test(t)) return false; return BOFU_RX.test(t); }
function hostOf(u){ try{ return String(u).replace(/^https?:\/\//,'').replace(/^www\./,'').split('/')[0].toLowerCase(); }catch(e){ return ''; } }

/* STRICT branded/navigational: only an EXACT-match domain counts (no domain-dominance). */
function serpBrandHit(domains, kw){
  domains = (domains||[]).filter(function(h){ return h && !IGNORE_DOMAINS.test(h); });
  if(!domains.length) return null;
  var kwc = norm(kw).replace(/[^a-z0-9]/g,'');
  if(kwc.length < 8) return null;
  var top = domains.slice(0,5);
  for(var i=0;i<top.length;i++){
    var name = top[i].replace(/\.[a-z.]+$/,'').replace(/[^a-z0-9]/g,'');
    if(name && (name===kwc || name.indexOf(kwc)>=0)) return top[i];
  }
  return null;
}

/* ----------------------------- MENU ------------------------------- */
// Tabs are auto-created on open, so the CSM's whole job is: paste into AKR → "Run everything".
function onOpen(){
  try{ ensureAllSheets(); }catch(e){}
  SpreadsheetApp.getUi().createMenu('🎯 Topic Tool')
    .addItem('▶ Run everything (paste into AKR first)', 'runEverything')
    .addSeparator()
    .addItem('✔ Self-review my selected', 'selfReview')
    .addItem('🔁 Re-apply rules (after editing Config)', 'runRules')
    .addItem('⏹ Stop background processing', 'stopBackground')
    .addSeparator()
    .addItem('⚙ Set API keys…', 'setApiKeys')
    .addItem('🧹 Clear cache & start over', 'clearCache')
    .addToUi();
}

/* ----------------------- ONE-CLICK PIPELINE ----------------------- */
// Everything a CSM needs in a single action: import → rules → live view tabs → background SERP+AI.
function runEverything(){
  var ui=SpreadsheetApp.getUi();
  ensureAllSheets();
  // make sure there's data to work with
  var akr=sheet(SHEET.AKR);
  if(akr.getLastRow()<2){ ui.alert('Paste your keyword report into the "AKR" tab first, then click "Run everything" again.'); return; }
  // keys: ask once if missing (only needed for the SERP+AI enrichment)
  var haveKeys = prop('OPENAI_API_KEY') && prop('SERPER_KEY');
  if(!haveKeys){
    ui.alert('First-time setup: paste your OpenAI and Serper API keys on the next two prompts. (You only do this once.)');
    setApiKeys();
    haveKeys = prop('OPENAI_API_KEY') && prop('SERPER_KEY');
  }
  // import + rules + presentation (all instant, no API)
  var n = importAkrSilent();
  runRules();
  applyFormatting(true);
  createViewTabs();
  // count rule rejections
  var t=sheet(SHEET.TOPICS), rej=0;
  t.getRange(2,COL.STATUS,Math.max(t.getLastRow()-1,1),1).getValues().forEach(function(r){ if(r[0]==='Rejected') rej++; });
  // kick off enrichment in the background (chunked, survives closing the sheet)
  var msg = 'Imported '+n+' topics — '+rej+' auto-rejected by the rules.\n\n';
  if(haveKeys){ startBackgroundSilent();
    msg += 'Now reading Google rankings + buyer intent (AI) in the background — this fills Audience, Type & BOFU and may keep running for a few minutes; you can keep working.\n\n';
  } else {
    msg += 'API keys not set, so the AI/rankings step was skipped. Add keys (⚙ Set API keys) and Run again to enrich.\n\n';
  }
  msg += 'NEXT: in the "Topics" tab set Status = "Selected" on the keywords you want. The "✅ Selected", "❌ Rejected" and "🔎 To review" tabs update automatically. Then run "Self-review my selected".';
  ui.alert(msg);
}

/* --------------------------- INIT / CONFIG ------------------------ */
function ss(){ return SpreadsheetApp.getActiveSpreadsheet(); }
function sheet(name){ var s=ss().getSheetByName(name); return s; }
function ensureSheet(name){ var s=sheet(name); if(!s) s=ss().insertSheet(name); return s; }

function ensureAllSheets(){
  // Config
  var cfg = ensureSheet(SHEET.CONFIG);
  if(cfg.getLastRow()===0){
    cfg.getRange(1,1,1,2).setValues([['Key','Value']]).setFontWeight('bold');
    var defaults = [
      ['offering','Both'],
      ['website',''],
      ['services',''],
      ['industries',''],
      ['competitors',''],
      ['locations',''],
      ['geoMode','all'],            // all | restricted
      ['serpGl','us'],
      ['rule_zero','TRUE'], ['rule_free','TRUE'], ['rule_nearme','FALSE'],
      ['rule_competitor','TRUE'], ['rule_location','TRUE'], ['rule_info','TRUE'],
      ['rule_jobs','TRUE'], ['rule_format','TRUE'], ['rule_org','TRUE'],
      ['rule_lowrel','FALSE'], ['lowrel_threshold','1']
    ];
    cfg.getRange(2,1,defaults.length,2).setValues(defaults);
    cfg.setColumnWidth(1,180); cfg.setColumnWidth(2,420);
  }
  // AKR
  var akr = ensureSheet(SHEET.AKR);
  if(akr.getLastRow()===0){
    akr.getRange(1,1,1,7).setValues([['Primary Keyword','Page Type','Topic','Secondary Keywords','Total Search Volume','Relevance Score','Shortlisting']]).setFontWeight('bold');
  }
  // Topics
  var t = ensureSheet(SHEET.TOPICS);
  if(t.getLastRow()===0){ t.getRange(1,1,1,TOPIC_HEADERS.length).setValues([TOPIC_HEADERS]).setFontWeight('bold'); t.setFrozenRows(1); }
  // Cache (hidden)
  var c = ensureSheet(SHEET.CACHE);
  if(c.getLastRow()===0){ c.getRange(1,1,1,6).setValues([['Keyword','Domains','Audience','Type','Keep','Reason']]).setFontWeight('bold'); }
  c.hideSheet();
  // tidy default Sheet1 if it's empty and unused
  var s1=sheet('Sheet1'); if(s1 && s1.getLastRow()===0 && ss().getSheets().length>1){ try{ ss().deleteSheet(s1); }catch(e){} }
  // put AKR first so it's the obvious place to paste
  try{ ss().setActiveSheet(sheet(SHEET.AKR)); ss().moveActiveSheet(1); }catch(e){}
}

/* Live, auto-updating view tabs (read-only QUERY of Topics) so the CSM never sorts by hand. */
function createViewTabs(){
  var views=[
    {name:'✅ Selected',  q:"select A,B,C,E,G,H,I,N,O where J='Selected' order by E desc"},
    {name:'🔎 To review', q:"select A,B,C,E,G,H,I where J='Pending' order by E desc"},
    {name:'❌ Rejected',  q:"select A,B,C,E,K,L where J='Rejected' order by E desc"}
  ];
  views.forEach(function(v){
    var sh=ensureSheet(v.name); sh.clear();
    sh.getRange(1,1,1,1).setValue('Live view of the Topics tab — read-only, updates automatically. Pick by setting Status in "Topics".').setFontColor('#888').setFontSize(10);
    sh.getRange(2,1).setFormula('=IFERROR(QUERY(Topics!A:O,"'+v.q+'",1),"(none yet)")');
    sh.setFrozenRows(2);
  });
}

function getConfig(){
  var s = sheet(SHEET.CONFIG); if(!s) throw new Error('Run "Initialise sheets" first.');
  var vals = s.getDataRange().getValues(); var o={};
  for(var i=1;i<vals.length;i++){ if(vals[i][0]!=='') o[String(vals[i][0]).trim()] = vals[i][1]; }
  var list = function(k){ return String(o[k]||'').split(',').map(function(x){return x.trim();}).filter(String); };
  var bool = function(k){ return String(o[k]).toUpperCase()==='TRUE'; };
  return {
    offering:o.offering||'Both', website:o.website||'',
    services:list('services'), industries:list('industries'),
    competitors:list('competitors'), locations:list('locations'),
    geoMode:o.geoMode||'all', serpGl:o.serpGl||'us',
    rules:{ zero:bool('rule_zero'), free:bool('rule_free'), nearme:bool('rule_nearme'),
      competitor:bool('rule_competitor'), location:bool('rule_location'), info:bool('rule_info'),
      jobs:bool('rule_jobs'), format:bool('rule_format'), org:bool('rule_org'), lowrel:bool('rule_lowrel') },
    lowRel: Number(o.lowrel_threshold||1)
  };
}

function setApiKeys(){
  var ui=SpreadsheetApp.getUi(), props=PropertiesService.getScriptProperties();
  var a=ui.prompt('OpenAI API key', 'Paste OPENAI_API_KEY (leave blank to keep current):', ui.ButtonSet.OK_CANCEL);
  if(a.getSelectedButton()===ui.Button.OK && a.getResponseText().trim()) props.setProperty('OPENAI_API_KEY', a.getResponseText().trim());
  var b=ui.prompt('Serper API key', 'Paste SERPER_KEY (leave blank to keep current):', ui.ButtonSet.OK_CANCEL);
  if(b.getSelectedButton()===ui.Button.OK && b.getResponseText().trim()) props.setProperty('SERPER_KEY', b.getResponseText().trim());
  ui.alert('Saved to Script Properties (not visible in the sheet).');
}

/* ----------------------------- IMPORT ----------------------------- */
function importAkrSilent(){
  var src=sheet(SHEET.AKR), t=sheet(SHEET.TOPICS);
  if(!src||!t){ ensureAllSheets(); src=sheet(SHEET.AKR); t=sheet(SHEET.TOPICS); }
  var rows=src.getDataRange().getValues(); if(rows.length<2){ return 0; }
  var head=rows[0].map(function(h){return norm(h).trim();});
  var find=function(){ for(var a=0;a<arguments.length;a++){ for(var i=0;i<head.length;i++){ if(head[i].indexOf(arguments[a])>=0) return i; } } return -1; };
  var ci={ kw:find('primary keyword','keyword'), pt:find('page type','type'), topic:find('topic'),
    sec:find('secondary'), vol:find('search volume','volume','msv'), rel:find('relevance','score') };
  if(ci.kw<0) ci.kw=0;
  var seen={}, out=[];
  for(var i=1;i<rows.length;i++){
    var a=rows[i], kw=String(a[ci.kw]||'').trim(); if(!kw) continue;
    var topic=ci.topic>=0?String(a[ci.topic]||'').trim():'';
    var key=(kw+'|'+topic).toLowerCase(); if(seen[key]) continue; seen[key]=1;
    var rawpt=ci.pt>=0?String(a[ci.pt]||''):''; var pt=/serv|product/i.test(rawpt)?'Service':'Blog';
    var vol=ci.vol>=0?(parseInt(String(a[ci.vol]||'').replace(/[^0-9]/g,''),10)||0):0;
    out.push([kw, pt, topic, ci.sec>=0?String(a[ci.sec]||'').trim():'', vol, ci.rel>=0?a[ci.rel]:'', '','','','Pending','','','','','']);
  }
  // clear old Topics rows, write fresh
  if(t.getLastRow()>1) t.getRange(2,1,t.getLastRow()-1,TOPIC_HEADERS.length).clearContent();
  if(out.length) t.getRange(2,1,out.length,TOPIC_HEADERS.length).setValues(out);
  addStatusValidation(t, out.length);
  return out.length;
}

function addStatusValidation(t, n){
  if(!n) return;
  var rule=SpreadsheetApp.newDataValidation().requireValueInList(['Pending','Selected','Rejected'],true).build();
  t.getRange(2,COL.STATUS,n,1).setDataValidation(rule);
}

/* --------------------------- RULE ENGINE -------------------------- */
// returns {reason, layer} if the keyword should be auto-rejected, else null
function evalRules(row, cfg){
  var R=cfg.rules, t=norm(row.kw), hits=[];
  if(R.zero && Number(row.vol)<=0) hits.push('Zero search volume');
  if(R.free && /\bfree\b/.test(t)) hits.push('Free keyword');
  if(R.nearme && /\bnear me\b/.test(t)) hits.push('"Near me" query');
  if(R.competitor){ for(var i=0;i<cfg.competitors.length;i++){ var b=cfg.competitors[i]; if(b && t.indexOf(norm(b))>=0){ hits.push('Other brand: '+b); break; } } }
  if(R.location && cfg.geoMode==='restricted'){
    var served=cfg.locations.map(norm).map(locAlias);
    var isServed=function(loc){ var a=locAlias(loc); return served.some(function(s){ return s===a||s===loc||s.indexOf(a)>=0||a.indexOf(s)>=0; }); };
    var all=US_STATES.concat(BIG_CITIES);
    var found=all.filter(function(loc){ return new RegExp('\\b'+loc.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\b').test(t); });
    var unserved=found.filter(function(loc){ return !isServed(loc); });
    if(unserved.length && !found.some(isServed)) hits.push('Location not served: '+unserved[0]);
  }
  if(R.info && row.pageType!=='Blog' && INFO_RX.test(t)) hits.push('Informational/DIY intent');
  if(R.jobs && JOBS_RX.test(t)) hits.push('Job / education-seeker intent');
  if(R.format && FORMAT_RX.test(t)) hits.push('Wrong-format / login/app intent');
  if(R.org && (ORG_RX.test(t)||BIG_BRANDS_RX.test(t))) hits.push('Other company / brand');
  if(R.lowrel){ var nv=parseFloat(row.rel); if(!isNaN(nv) && nv<=cfg.lowRel) hits.push('Low relevance ('+row.rel+')'); }
  // brand / navigational from cached SERP (strict exact-match)
  if(row.domains && row.domains.length){ var b2=serpBrandHit(row.domains, row.kw); if(b2 && !hits.some(function(h){return /brand/i.test(h);})) hits.push('Branded / navigational ('+b2+')'); }
  return hits.length ? {reason:hits.join('; '), layer:'Rule'} : null;
}

// Apply rules to every Topics row that isn't a manual Selected decision. Instant, no API.
function runRules(){
  var t=sheet(SHEET.TOPICS); if(!t||t.getLastRow()<2) return;
  var cfg=getConfig();
  var n=t.getLastRow()-1, rng=t.getRange(2,1,n,TOPIC_HEADERS.length), vals=rng.getValues();
  for(var i=0;i<vals.length;i++){
    var v=vals[i]; if(!v[COL.KW-1]) continue;
    if(String(v[COL.STATUS-1])==='Selected') continue;   // never override a human pick
    var domains=String(v[COL.DOMAINS-1]||'').split(',').filter(String);
    var row={kw:v[COL.KW-1], topic:v[COL.TOPIC-1], vol:v[COL.VOL-1], rel:v[COL.REL-1], pageType:v[COL.PT-1], domains:domains};
    v[COL.BOFU-1] = isBofu(row.kw)?'Yes':'No';
    var hit=evalRules(row, cfg);
    if(hit){ v[COL.STATUS-1]='Rejected'; v[COL.REASON-1]=hit.reason; v[COL.LAYER-1]=hit.layer; }
    else if(String(v[COL.STATUS-1])==='Rejected' && String(v[COL.LAYER-1])==='Rule'){ v[COL.STATUS-1]='Pending'; v[COL.REASON-1]=''; v[COL.LAYER-1]=''; }
  }
  rng.setValues(vals);
}

/* --------------------------- ENRICHMENT --------------------------- */
function prop(k){ return PropertiesService.getScriptProperties().getProperty(k); }

function loadCache(){
  var c=sheet(SHEET.CACHE), map={}; if(!c||c.getLastRow()<2) return map;
  var v=c.getRange(2,1,c.getLastRow()-1,6).getValues();
  for(var i=0;i<v.length;i++){ if(v[i][0]) map[String(v[i][0]).toLowerCase()]={domains:String(v[i][1]||'').split(',').filter(String),audience:v[i][2],type:v[i][3],keep:v[i][4]!==false&&v[i][4]!=='FALSE',reason:v[i][5]}; }
  return map;
}
function writeCache(rows){ // rows: [kw, domainsCsv, aud, type, keep, reason]
  if(!rows.length) return; var c=sheet(SHEET.CACHE);
  c.getRange(c.getLastRow()+1,1,rows.length,6).setValues(rows);
}

function serperFetchAll(keywords, gl){
  var key=prop('SERPER_KEY'); if(!key) throw new Error('Set SERPER_KEY (Setup ▸ Set API keys).');
  var reqs=keywords.map(function(kw){ return { url:'https://google.serper.dev/search', method:'post',
    headers:{'X-API-KEY':key}, contentType:'application/json', muteHttpExceptions:true,
    payload:JSON.stringify({q:kw, gl:gl||'us', num:10}) }; });
  var out=[]; // run in sub-batches so one fetchAll isn't enormous
  for(var i=0;i<reqs.length;i+=20){
    var resp=UrlFetchApp.fetchAll(reqs.slice(i,i+20));
    for(var j=0;j<resp.length;j++){
      var titles=[], domains=[];
      try{ var data=JSON.parse(resp[j].getContentText()); var org=(data.organic||[]).slice(0,10);
        org.forEach(function(o){ var h=hostOf(o.link||''); if(h){ domains.push(h); if(!IGNORE_DOMAINS.test(h)) titles.push(((o.title||'')+' '+(o.snippet||'')).trim()); } });
      }catch(e){}
      out.push({domains:domains, titles:titles});
    }
  }
  return out;
}

var AUDIENCES = ['B2B / Corporate','Healthcare / Clinical','Aspiring Practitioner','Athlete / Sports','Local Seeker','Individual / Consumer','Researcher / Student','General'];
var REJECT_REASONS = ['Job-seeker intent','Researcher/student intent','Branded query','Off-ICP audience','No commercial intent'];

function openai(messages){
  var key=prop('OPENAI_API_KEY'); if(!key) throw new Error('Set OPENAI_API_KEY (Setup ▸ Set API keys).');
  var resp=UrlFetchApp.fetch('https://api.openai.com/v1/chat/completions',{ method:'post',
    headers:{'Authorization':'Bearer '+key}, contentType:'application/json', muteHttpExceptions:true,
    payload:JSON.stringify({ model:'gpt-4o-mini', temperature:0, response_format:{type:'json_object'}, messages:messages }) });
  if(resp.getResponseCode()!==200) throw new Error('OpenAI '+resp.getResponseCode()+': '+resp.getContentText().slice(0,200));
  var j=JSON.parse(resp.getContentText());
  try{ return JSON.parse(j.choices[0].message.content); }catch(e){ return {}; }
}

function clientDesc(cfg){
  return [cfg.offering?('Offering: '+cfg.offering+'.'):'', cfg.services.length?('Sells: '+cfg.services.join(', ')+'.'):'',
    cfg.industries.length?('Ideal customers (ICP): '+cfg.industries.join(', ')+'.'):'', cfg.website?('Site: '+cfg.website+'.'):'']
    .filter(String).join(' ') || '(client profile not provided)';
}

function classifyBatch(items, cfg){ // items:[{id,kw,titles}]
  var sys = 'You are an SEO analyst classifying keywords for a client by INTENT, using the keyword and the titles of pages currently ranking.\n\nCLIENT: '+clientDesc(cfg)+'\n\nFor each keyword return:\n- "audience": exactly one of: '+AUDIENCES.join(' | ')+'\n- "type": a BROAD product/service category (Title Case, 1-2 words). Reuse a small consistent vocabulary.\n- "keep": true if the searcher is a plausible BUYER for THIS client; false only when clearly NOT.\n- "reason": when keep=false, exactly one of: '+REJECT_REASONS.join(' | ')+'. When keep=true, "".\nJudge real intent from the ranking titles, not surface words. Branded query = a SPECIFIC company name, not generic words like branded/custom/personalized. When unsure keep=true.\nReturn ONLY JSON: {"results":[{"id":<id>,"audience":"...","type":"...","keep":true|false,"reason":"..."}]}.';
  var lines = items.map(function(it){ return JSON.stringify({id:it.id, keyword:it.kw, ranking_titles:(it.titles||[]).slice(0,6).join(' | ')}); }).join('\n');
  var j = openai([{role:'system',content:sys},{role:'user',content:'Classify these:\n'+lines}]);
  var byId={}; (j.results||[]).forEach(function(o){ byId[String(o.id)]={ audience:AUDIENCES.indexOf(o.audience)>=0?o.audience:'General', type:(o.type||'').toString().slice(0,40), keep:o.keep!==false, reason:o.keep!==false?'':(REJECT_REASONS.indexOf(o.reason)>=0?o.reason:'No commercial intent') }; });
  return byId;
}

// Process the next BATCH of Pending+un-enriched Topics rows. Returns number processed.
function processBatch(){
  var t=sheet(SHEET.TOPICS); if(!t||t.getLastRow()<2) return 0;
  var cfg=getConfig(), cache=loadCache();
  var n=t.getLastRow()-1, rng=t.getRange(2,1,n,TOPIC_HEADERS.length), vals=rng.getValues();
  // pick rows that have no Audience yet (not enriched) and aren't already human-Selected
  var todo=[];
  for(var i=0;i<vals.length && todo.length<BATCH;i++){
    var v=vals[i]; if(!v[COL.KW-1]) continue;
    if(v[COL.AUD-1]) continue;                         // already enriched
    todo.push(i);
  }
  if(!todo.length) return 0;
  // 1) SERP for keywords not cached
  var needSerp=todo.filter(function(i){ return !cache[String(vals[i][COL.KW-1]).toLowerCase()]; });
  var newCacheRows=[];
  if(needSerp.length){
    var kws=needSerp.map(function(i){ return vals[i][COL.KW-1]; });
    var serp=serperFetchAll(kws, cfg.serpGl);
    needSerp.forEach(function(i,idx){ var kw=String(vals[i][COL.KW-1]).toLowerCase();
      cache[kw]={domains:serp[idx].domains, titles:serp[idx].titles, audience:'', type:'', keep:true, reason:''}; });
  }
  // 2) AI classify (batched) for keywords with no cached audience
  var toAI=todo.filter(function(i){ var c=cache[String(vals[i][COL.KW-1]).toLowerCase()]; return !c.audience; });
  for(var b=0;b<toAI.length;b+=AI_BATCH){
    var slice=toAI.slice(b,b+AI_BATCH);
    var items=slice.map(function(i){ var kw=String(vals[i][COL.KW-1]).toLowerCase(); return {id:String(i), kw:vals[i][COL.KW-1], titles:(cache[kw].titles||[])}; });
    var res; try{ res=classifyBatch(items, cfg); }catch(e){ res={}; }
    slice.forEach(function(i){ var kw=String(vals[i][COL.KW-1]).toLowerCase(); var o=res[String(i)]; if(o){ cache[kw].audience=o.audience; cache[kw].type=o.type; cache[kw].keep=o.keep; cache[kw].reason=o.reason; } else { cache[kw].audience='General'; } });
  }
  // 3) write enrichment + apply rules + AI reject onto rows
  todo.forEach(function(i){ var v=vals[i], kw=String(v[COL.KW-1]).toLowerCase(), c=cache[kw];
    v[COL.AUD-1]=c.audience||'General'; v[COL.TYPE-1]=c.type||''; v[COL.DOMAINS-1]=(c.domains||[]).join(',');
    v[COL.BOFU-1]=isBofu(v[COL.KW-1])?'Yes':'No';
    if(String(v[COL.STATUS-1])!=='Selected'){
      var row={kw:v[COL.KW-1], topic:v[COL.TOPIC-1], vol:v[COL.VOL-1], rel:v[COL.REL-1], pageType:v[COL.PT-1], domains:(c.domains||[])};
      var hit=evalRules(row, cfg);
      if(hit){ v[COL.STATUS-1]='Rejected'; v[COL.REASON-1]=hit.reason; v[COL.LAYER-1]='Rule'; }
      else if(c.keep===false){ v[COL.STATUS-1]='Rejected'; v[COL.REASON-1]=c.reason||'Off intent'; v[COL.LAYER-1]='AI'; }
      else if(String(v[COL.STATUS-1])==='Rejected'){ v[COL.STATUS-1]='Pending'; v[COL.REASON-1]=''; v[COL.LAYER-1]=''; }
    }
  });
  rng.setValues(vals);
  // persist new cache entries
  var existing=loadCache();
  Object.keys(cache).forEach(function(kw){ var c=cache[kw]; newCacheRows.push([kw, (c.domains||[]).join(','), c.audience||'', c.type||'', c.keep!==false, c.reason||'']); });
  // rewrite cache sheet entirely (dedup) — small enough
  var cs=sheet(SHEET.CACHE); if(cs.getLastRow()>1) cs.getRange(2,1,cs.getLastRow()-1,6).clearContent();
  if(newCacheRows.length) cs.getRange(2,1,newCacheRows.length,6).setValues(newCacheRows);
  return todo.length;
}

function processBatchMenu(){
  var done=processBatch();
  var t=sheet(SHEET.TOPICS); var remaining=0, vals=t.getRange(2,COL.AUD,t.getLastRow()-1,1).getValues();
  vals.forEach(function(r){ if(!r[0]) remaining++; });
  SpreadsheetApp.getUi().alert('Processed '+done+' topics this run.\n'+remaining+' still need processing.\n\nRun "Process next batch" again, or "Process ALL in background".');
}

/* ----------------- BACKGROUND (chunked via trigger) --------------- */
function startBackgroundSilent(){
  stopBackground();
  ScriptApp.newTrigger('backgroundTick').timeBased().everyMinutes(1).create();
  processBatch();   // also do one batch right now so progress is visible immediately
}
function startBackground(){ startBackgroundSilent(); SpreadsheetApp.getUi().alert('Background processing started — a batch runs every minute until done. You can close the sheet. Use "Stop" to cancel.'); }
function stopBackground(){ ScriptApp.getProjectTriggers().forEach(function(tr){ if(tr.getHandlerFunction()==='backgroundTick') ScriptApp.deleteTrigger(tr); }); }
function backgroundTick(){ var done=processBatch(); if(done===0) stopBackground(); }

/* --------------------------- SELF-REVIEW -------------------------- */
function selfReview(){
  var t=sheet(SHEET.TOPICS); if(!t||t.getLastRow()<2){ return; }
  var cfg=getConfig(), cache=loadCache();
  var n=t.getLastRow()-1, rng=t.getRange(2,1,n,TOPIC_HEADERS.length), vals=rng.getValues();
  var idxs=[]; for(var i=0;i<vals.length;i++){ if(String(vals[i][COL.STATUS-1])==='Selected'){ idxs.push(i); vals[i][COL.RVERDICT-1]=''; vals[i][COL.RREASON-1]=''; } }
  if(!idxs.length){ SpreadsheetApp.getUi().alert('No rows with Status = Selected. Pick some first.'); return; }
  // LAYER 1: rules
  var need=[];
  idxs.forEach(function(i){ var v=vals[i]; var domains=String(v[COL.DOMAINS-1]||'').split(',').filter(String);
    var hit=evalRules({kw:v[COL.KW-1],topic:v[COL.TOPIC-1],vol:v[COL.VOL-1],rel:v[COL.REL-1],pageType:v[COL.PT-1],domains:domains}, cfg);
    if(hit){ v[COL.RVERDICT-1]='FLAG'; v[COL.RREASON-1]='[Rule] '+hit.reason; } else need.push(i); });
  // LAYER 2: AI intent on the rest
  for(var b=0;b<need.length;b+=AI_BATCH){
    var slice=need.slice(b,b+AI_BATCH);
    var items=slice.map(function(i){ var kw=String(vals[i][COL.KW-1]).toLowerCase(); var c=cache[kw]||{};
      return {id:String(i), kw:vals[i][COL.KW-1], topic:vals[i][COL.TOPIC-1], audience:vals[i][COL.AUD-1], type:vals[i][COL.TYPE-1], titles:(c.titles||[])}; });
    var res; try{ res=reviewBatch(items, cfg); }catch(e){ res={}; }
    slice.forEach(function(i){ var o=res[String(i)]; if(o && o.ok===false){ vals[i][COL.RVERDICT-1]='FLAG'; vals[i][COL.RREASON-1]='[AI] '+o.reason; } else if(!vals[i][COL.RVERDICT-1]){ vals[i][COL.RVERDICT-1]='OK'; } });
  }
  idxs.forEach(function(i){ if(!vals[i][COL.RVERDICT-1]) vals[i][COL.RVERDICT-1]='OK'; });
  rng.setValues(vals);
  var flagged=idxs.filter(function(i){ return vals[i][COL.RVERDICT-1]==='FLAG'; }).length;
  SpreadsheetApp.getUi().alert('Self-review done: '+flagged+' of '+idxs.length+' selected topics flagged (see the Review / Review Reason columns).');
}

function reviewBatch(items, cfg){
  var sys='You are a senior SEO editor doing QC. A human SELECTED these keywords as pages to build for this client. Catch SELECTION MISTAKES.\n\nCLIENT: '+clientDesc(cfg)+'\n\nJudge intent from the keyword + ranking_titles (strongest evidence) IN THE CLIENT\'S CONTEXT. The same words mean different things per business (for a printing client "gold foil stamps"=foil stamping, not postage). Do NOT flag a keyword just because a word is ambiguous/broad/low-volume.\nFlag ok=false ONLY when: a DIFFERENT product/industry; wrong audience/ICP; job/education seeker; a SPECIFIC company/brand NAME (incl. unfamiliar ones: a proper-noun name + an org word like Communications/Press/Studio/Co/Inc/LLC/Agency, confirmed by ranking titles) but NOT generic words (branded/custom/personalized/foil/engraved/letterpress); or obvious junk.\nBe CONSERVATIVE. Return ONLY JSON: {"results":[{"id":<id>,"ok":true|false,"severity":"high|low","reason":"<=12 words"}]}.';
  var lines=items.map(function(it){ return JSON.stringify({id:it.id, keyword:it.kw, topic:it.topic, audience:it.audience, type:it.type, ranking_titles:(it.titles||[]).slice(0,6).join(' | ')}); }).join('\n');
  var j=openai([{role:'system',content:sys},{role:'user',content:'QC these:\n'+lines}]);
  var byId={}; (j.results||[]).forEach(function(o){ var ok=o.ok!==false; byId[String(o.id)]={ok:ok, reason:ok?'':(String(o.reason||'Looks off')).slice(0,120)}; });
  return byId;
}

/* --------------------------- FORMATTING --------------------------- */
function applyFormatting(silent){
  var t=sheet(SHEET.TOPICS); if(!t) return; var n=Math.max(t.getLastRow()-1,1);
  t.setColumnWidth(COL.DOMAINS, 10); t.hideColumns(COL.DOMAINS);
  var body=t.getRange(2,1,n,TOPIC_HEADERS.length);
  var rules=[];
  rules.push(SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=$J2="Rejected"').setBackground('#fde7e7').setRanges([body]).build());
  rules.push(SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=$J2="Selected"').setBackground('#e7f6ec').setRanges([body]).build());
  rules.push(SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=$N2="FLAG"').setBackground('#fde7e7').setFontColor('#b00020').setRanges([body]).build());
  t.setConditionalFormatRules(rules);
  // a filter so they can slice by Status / BOFU / Audience / Type natively
  if(t.getFilter()) t.getFilter().remove();
  t.getRange(1,1,Math.max(t.getLastRow(),1),TOPIC_HEADERS.length).createFilter();
  if(!silent) SpreadsheetApp.getUi().alert('Formatting + filter applied. Use the column filter arrows to slice by Status, BOFU, Audience, Type, Page Type.');
}

function clearCache(){
  var ui=SpreadsheetApp.getUi();
  var r=ui.alert('Start over?', 'This clears the processed Topics + the AI/SERP cache (your AKR and Config are kept). Continue?', ui.ButtonSet.YES_NO);
  if(r!==ui.Button.YES) return;
  stopBackground();
  var c=sheet(SHEET.CACHE); if(c && c.getLastRow()>1) c.getRange(2,1,c.getLastRow()-1,6).clearContent();
  var t=sheet(SHEET.TOPICS); if(t && t.getLastRow()>1) t.getRange(2,1,t.getLastRow()-1,TOPIC_HEADERS.length).clearContent();
  ui.alert('Cleared. Paste/refresh the AKR tab and click "Run everything".');
}
