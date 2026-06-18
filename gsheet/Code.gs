/**********************************************************************
 * Topic Shortlisting Tool — Google Sheets / Apps Script edition
 * Rule engine + Serper SERP + OpenAI classify/self-review, in ONE tab.
 *
 * For a CSM the whole job is:  paste into AKR  →  ▶ Run everything.
 * Everything (rules, audience, type, modifier, BOFU, status, reason)
 * lands in the single "Topics" tab. Filter it natively to slice.
 **********************************************************************/

/* ----------------------------- LAYOUT ----------------------------- */
var SHEET = { AKR:'AKR', CONFIG:'Config', TOPICS:'Topics', CACHE:'_Cache' };
var VIEW_TABS = ['✅ Selected','🔎 To review','❌ Rejected'];   // legacy tabs to remove (now one tab)
// Topics columns (1-indexed)
var COL = { KW:1, PT:2, TOPIC:3, SEC:4, VOL:5, REL:6, AUD:7, TYPE:8, MOD:9, BOFU:10, STATUS:11, REASON:12, LAYER:13, DOMAINS:14, RVERDICT:15, RREASON:16 };
var TOPIC_HEADERS = ['Keyword','Page Type','Topic','Secondary','Volume','Relevance','Audience','Type','Modifier','BOFU','Status','Reason','Layer','_domains','Review','Review Reason'];
var NCOL = TOPIC_HEADERS.length;
var BATCH = 100;     // Topics rows enriched per processBatch call
var AI_BATCH = 30;   // keywords per OpenAI call
var FG_BUDGET_MS = 4.5*60*1000;   // foreground enrichment time budget (stay under the 6-min limit)

/* --------------------------- RULE LEXICON ------------------------- */
function norm(s){ return (s==null?'':String(s)).toLowerCase(); }
var US_STATES = ['alabama','alaska','arizona','arkansas','california','colorado','connecticut','delaware','florida','georgia','hawaii','idaho','illinois','indiana','iowa','kansas','kentucky','louisiana','maine','maryland','massachusetts','michigan','minnesota','mississippi','missouri','montana','nebraska','nevada','new hampshire','new jersey','new mexico','new york','north carolina','north dakota','ohio','oklahoma','oregon','pennsylvania','rhode island','south carolina','south dakota','tennessee','texas','utah','vermont','virginia','washington','west virginia','wisconsin','wyoming'];
var BIG_CITIES = ['seattle','portland','atlanta','dallas','austin','houston','chicago','boston','denver','miami','phoenix','orlando','tacoma','india','france','mumbai','asia','usa','united states','uk','london','canada','toronto','nyc','new york','dubai','abu dhabi','singapore','sydney','melbourne','auckland','hong kong','shanghai','beijing','tokyo','kuala lumpur','jakarta','manila','bangkok','thailand','bali','goa','rishikesh','kerala','delhi','bangalore','bengaluru','chennai','pune','hyderabad','dublin','paris','berlin','munich','amsterdam','madrid','barcelona','rome','milan','zurich','geneva','vienna','stockholm','copenhagen','oslo','lisbon','athens','istanbul','tel aviv','riyadh','doha','qatar','kuwait','cape town','johannesburg','nairobi','lagos','cairo','mexico','spain','italy','germany','australia','new zealand','ireland','scotland','wales','europe','africa','middle east','vancouver','montreal','calgary','costa rica','las vegas','san francisco','los angeles','san diego','vegas','nashville','aspen','sedona','tulum'];
var LOC_ALIAS = {'nyc':'new york','new york city':'new york','manhattan':'new york','brooklyn':'new york','queens':'new york','bronx':'new york','la':'los angeles','sf':'san francisco','bay area':'san francisco','dc':'washington','washington dc':'washington','philly':'philadelphia','vegas':'las vegas','nj':'new jersey','ct':'connecticut'};
function locAlias(s){ return LOC_ALIAS[s]||s; }
// modifier words — qualifiers/intent/format/audience that describe HOW/FOR-WHOM, not the offering itself
var MODIFIER_WORDS = ['corporate','executive','executives','online','virtual','in-person','remote','hybrid','offsite',
  'best','top','free','cheap','affordable','budget','luxury','premium','private','group','public',
  'beginner','beginners','advanced','intermediate','basic','intro','quick','short','intensive',
  'guided','daily','morning','evening','weekend','weekday','annual','monthly','weekly',
  'near','local','nearby','custom','customized','customised','tailored','bespoke','professional','expert','certified','accredited','licensed',
  'small','large','team','teams','employee','employees','staff','workplace','company','business','b2b',
  'women','men','kids','senior','seniors','youth','student','students','new','popular','famous','rated','top-rated'];
var MODSET = {}; MODIFIER_WORDS.forEach(function(w){ MODSET[w]=1; });
var STATEset={}; US_STATES.forEach(function(w){STATEset[w]=1;}); var CITYset={}; BIG_CITIES.forEach(function(w){CITYset[w]=1;});
var INFO_RX = /\b(how to|how-to|what is|what's|meaning|definition|define|youtube|you ?tube|video|videos|pdf|template|reddit|wiki|free download|guide|tutorial|at home|diy|recording|app|login|download|coupon|reviews?|quotes?|images?|examples?)\b/;
var JOBS_RX = /\b(jobs?|salary|salaries|hiring|career|careers|certification|certified|certificate|course|courses|degree|class schedule|teacher training|become a|how to become|exam|syllabus)\b/;
var FORMAT_RX = /\b(login|sign in|app|apk|download|coupon|promo code|discount code|cracked|torrent|free pdf)\b/;
var BOFU_RX = /\b(buy|buying|purchase|purchasing|order|ordering|reorder|for sale|price|prices|pricing|cost|costs|how much|cheap|cheapest|affordable|discount|quote|quotation|estimate|near me|nearby|supplier|suppliers|wholesale|bulk|vendor|vendors|manufacturer|manufacturers|distributor|distributors|compan(y|ies)|service|services|shop|store|online|hire|rent|rental|custom|customi(z|s)ed?|personali(z|s)ed?|monogram|monogrammed|engraved|branded|promotional|made to order|best|top)\b/;
var ORG_RX = /\b(institutes?|academ(y|ies)|society|societies|foundations?|associations?|ashram|sangha|vihara|monastery|university|college|ll[cp]|gmbh|pvt|dhamma|goenka|chopra|mindvalley|headspace|deepak|sadhguru|isha)\b/;
var BIG_BRANDS_RX = /\b(nvidia|google|apple|microsoft|amazon|meta|tesla|samsung|intel|ibm|oracle|salesforce|adobe|cisco|netflix|spotify|uber|airbnb|openai|nike|adidas|disney|coca[- ]?cola|pepsi|ces|wwdc|davos|web summit)\b/;
var IGNORE_DOMAINS = /(wikipedia|wikihow|britannica|fandom|youtube|youtu\.be|vimeo|reddit|quora|stackexchange|stackoverflow|medium\.com|tumblr|facebook|instagram|tiktok|twitter|x\.com|pinterest|linkedin\.com|snapchat|threads\.net|discord|news\.ycombinator)/;

function isBofu(kw){ var t=norm(kw); if(INFO_RX.test(t)||JOBS_RX.test(t)) return false; return BOFU_RX.test(t); }
function hostOf(u){ try{ return String(u).replace(/^https?:\/\//,'').replace(/^www\./,'').split('/')[0].toLowerCase(); }catch(e){ return ''; } }
// modifier words present in the keyword (qualifiers, geos, the client's industries)
function modifiersOf(kw, cfg){
  var inds={}; (cfg&&cfg.industries||[]).forEach(function(i){ norm(i).split(/\s+/).forEach(function(w){ if(w) inds[w]=1; }); });
  var toks = norm(kw).split(/[^a-z0-9]+/).filter(Boolean);
  var seen={}, out=[];
  toks.forEach(function(w){ if((MODSET[w]||STATEset[w]||CITYset[w]||inds[w]) && !seen[w]){ seen[w]=1; out.push(w); } });
  return out.join('; ');
}
/* STRICT branded/navigational: only an EXACT-match domain (whole keyword phrase) counts. */
function serpBrandHit(domains, kw){
  domains = (domains||[]).filter(function(h){ return h && !IGNORE_DOMAINS.test(h); });
  if(!domains.length) return null;
  var kwc = norm(kw).replace(/[^a-z0-9]/g,'');
  if(kwc.length < 8) return null;
  var top = domains.slice(0,5);
  for(var i=0;i<top.length;i++){ var name = top[i].replace(/\.[a-z.]+$/,'').replace(/[^a-z0-9]/g,''); if(name && (name===kwc || name.indexOf(kwc)>=0)) return top[i]; }
  return null;
}

/* ----------------------------- MENU ------------------------------- */
function onOpen(){
  try{ ensureAllSheets(); }catch(e){}
  var ui=SpreadsheetApp.getUi();
  var views=ui.createMenu('👁 Views (Service / Blog / picks)')
    .addItem('🛠 Service / Product', 'viewService')
    .addItem('📝 Blog', 'viewBlog')
    .addSeparator()
    .addItem('✅ Selected', 'viewSelected')
    .addItem('🔎 To review (Pending)', 'viewPending')
    .addItem('❌ Rejected', 'viewRejected')
    .addItem('↺ Show all', 'viewAll');
  ui.createMenu('🎯 Topic Tool')
    .addItem('▶ Run everything (paste into AKR first)', 'runEverything')
    .addSubMenu(views)
    .addSeparator()
    .addItem('🏢 Client info (services / competitors / domain…)', 'showSetup')
    .addItem('✔ Self-review my selected', 'selfReview')
    .addItem('🔁 Re-apply rules', 'runRules')
    .addItem('⏹ Stop background processing', 'stopBackground')
    .addSeparator()
    .addItem('⚙ Set API keys…', 'setApiKeys')
    .addItem('🧹 Clear & start over', 'clearCache')
    .addToUi();
}

/* --------------------- VIEWS (filter the one tab) ----------------- */
function topicsFilter(){ var t=sheet(SHEET.TOPICS); if(!t) return null; ss().setActiveSheet(t); var f=t.getFilter(); if(!f){ applyFormatting(true); f=t.getFilter(); } return f; }
function clearViewCriteria(f){ [COL.PT, COL.STATUS].forEach(function(c){ try{ f.removeColumnFilterCriteria(c); }catch(e){} }); }
function setView(col, value){ var f=topicsFilter(); if(!f) return; clearViewCriteria(f); if(col) f.setColumnFilterCriteria(col, SpreadsheetApp.newFilterCriteria().whenTextEqualTo(value).build()); }
function viewService(){ setView(COL.PT, 'Service'); }
function viewBlog(){ setView(COL.PT, 'Blog'); }
function viewSelected(){ setView(COL.STATUS, 'Selected'); }
function viewPending(){ setView(COL.STATUS, 'Pending'); }
function viewRejected(){ setView(COL.STATUS, 'Rejected'); }
function viewAll(){ setView(null); }

/* --------------------------- SHEETS / CONFIG ---------------------- */
function ss(){ return SpreadsheetApp.getActiveSpreadsheet(); }
function sheet(name){ return ss().getSheetByName(name); }
function ensureSheet(name){ var s=sheet(name); if(!s) s=ss().insertSheet(name); return s; }

function ensureAllSheets(){
  var cfg = ensureSheet(SHEET.CONFIG);
  if(cfg.getLastRow()===0){
    cfg.getRange(1,1,1,2).setValues([['Key','Value']]).setFontWeight('bold');
    var defaults = [['offering','Both'],['website',''],['services',''],['industries',''],['products',''],
      ['competitors',''],['locations',''],['geoMode','all'],['serpGl','us'],
      ['rule_zero','TRUE'],['rule_free','TRUE'],['rule_nearme','FALSE'],['rule_competitor','TRUE'],
      ['rule_location','TRUE'],['rule_info','TRUE'],['rule_jobs','TRUE'],['rule_format','TRUE'],
      ['rule_org','TRUE'],['rule_lowrel','FALSE'],['lowrel_threshold','1']];
    cfg.getRange(2,1,defaults.length,2).setValues(defaults);
    cfg.setColumnWidth(1,180); cfg.setColumnWidth(2,460);
  }
  var akr = ensureSheet(SHEET.AKR);
  if(akr.getLastRow()===0) akr.getRange(1,1,1,7).setValues([['Primary Keyword','Page Type','Topic','Secondary Keywords','Total Search Volume','Relevance Score','Shortlisting']]).setFontWeight('bold');
  var t = ensureSheet(SHEET.TOPICS);
  if(t.getRange(1,1).getValue()!=='Keyword'){ t.getRange(1,1,1,NCOL).setValues([TOPIC_HEADERS]).setFontWeight('bold'); t.setFrozenRows(1); }
  var c = ensureSheet(SHEET.CACHE);
  if(c.getLastRow()===0) c.getRange(1,1,1,7).setValues([['Keyword','Domains','Audience','Type','Keep','Reason','Titles']]).setFontWeight('bold');
  c.hideSheet();
  // one-tab edition: remove the old separate view tabs if present
  VIEW_TABS.forEach(function(nm){ var s=sheet(nm); if(s){ try{ ss().deleteSheet(s); }catch(e){} } });
  var s1=sheet('Sheet1'); if(s1 && s1.getLastRow()===0 && ss().getSheets().length>1){ try{ ss().deleteSheet(s1); }catch(e){} }
  try{ ss().setActiveSheet(sheet(SHEET.AKR)); ss().moveActiveSheet(1); }catch(e){}
}

function getConfig(){
  var s=sheet(SHEET.CONFIG); if(!s){ ensureAllSheets(); s=sheet(SHEET.CONFIG); }
  var vals=s.getDataRange().getValues(), o={};
  for(var i=1;i<vals.length;i++){ if(vals[i][0]!=='') o[String(vals[i][0]).trim()]=vals[i][1]; }
  var list=function(k){ return String(o[k]||'').split(',').map(function(x){return x.trim();}).filter(String); };
  var bool=function(k){ return String(o[k]).toUpperCase()==='TRUE'; };
  return { offering:o.offering||'Both', website:o.website||'', services:list('services'), industries:list('industries'), products:list('products'),
    competitors:list('competitors'), locations:list('locations'), geoMode:o.geoMode||'all', serpGl:o.serpGl||'us',
    rules:{ zero:bool('rule_zero'), free:bool('rule_free'), nearme:bool('rule_nearme'), competitor:bool('rule_competitor'),
      location:bool('rule_location'), info:bool('rule_info'), jobs:bool('rule_jobs'), format:bool('rule_format'), org:bool('rule_org'), lowrel:bool('rule_lowrel') },
    lowRel:Number(o.lowrel_threshold||1) };
}
function setConfigVal(key, val){
  var s=sheet(SHEET.CONFIG), vals=s.getDataRange().getValues();
  for(var i=1;i<vals.length;i++){ if(String(vals[i][0]).trim()===key){ s.getRange(i+1,2).setValue(val); return; } }
  s.getRange(s.getLastRow()+1,1,1,2).setValues([[key,val]]);
}

/* ---- client-info form (one dialog instead of editing the Config tab) ---- */
function showSetup(){
  ensureAllSheets(); var c=getConfig();
  var v=function(x){ return String(x==null?'':x).replace(/"/g,'&quot;'); };
  var html='<style>body{font-family:Arial;font-size:13px;margin:0;padding:14px;color:#222}label{display:block;font-weight:600;margin:10px 0 3px}'
    +'input,select,textarea{width:100%;box-sizing:border-box;padding:7px;border:1px solid #ccc;border-radius:6px;font-size:13px}'
    +'small{color:#888;font-weight:400}button{margin-top:14px;background:#3b5bdb;color:#fff;border:0;border-radius:7px;padding:9px 16px;font-weight:700;cursor:pointer}</style>'
    +'<label>Client website / domain</label><input id="website" value="'+v(c.website)+'" placeholder="https://client.com">'
    +'<label>Offering</label><select id="offering"><option '+(c.offering==='Product'?'selected':'')+'>Product</option><option '+(c.offering==='Services'?'selected':'')+'>Services</option><option '+(c.offering!=='Product'&&c.offering!=='Services'?'selected':'')+'>Both</option></select>'
    +'<label>Services / Products <small>(comma-separated)</small></label><textarea id="services" rows="2" placeholder="business cards, foil stamping, engraving">'+v(c.services.join(', '))+'</textarea>'
    +'<label>Industries / ICP <small>(comma-separated)</small></label><textarea id="industries" rows="2" placeholder="restaurants, real estate, weddings">'+v(c.industries.join(', '))+'</textarea>'
    +'<label>Competitors / brands to reject <small>(comma-separated)</small></label><textarea id="competitors" rows="2" placeholder="vistaprint, moo, minted">'+v(c.competitors.join(', '))+'</textarea>'
    +'<label>Served locations <small>(comma-separated; leave blank if national)</small></label><input id="locations" value="'+v(c.locations.join(', '))+'" placeholder="new york, los angeles">'
    +'<label>Geo mode</label><select id="geoMode"><option value="all" '+(c.geoMode!=='restricted'?'selected':'')+'>Serve anywhere (don\'t reject by location)</option><option value="restricted" '+(c.geoMode==='restricted'?'selected':'')+'>Only the locations above</option></select>'
    +'<button onclick="save()">Save client info</button>'
    +'<script>function save(){var d={website:website.value,offering:offering.value,services:services.value,industries:industries.value,competitors:competitors.value,locations:locations.value,geoMode:geoMode.value};google.script.run.withSuccessHandler(function(){google.script.host.close();}).saveClientInfo(d);}</script>';
  SpreadsheetApp.getUi().showModalDialog(HtmlService.createHtmlOutput(html).setWidth(420).setHeight(560), '🏢 Client info');
}
function saveClientInfo(d){
  setConfigVal('website', d.website||''); setConfigVal('offering', d.offering||'Both');
  setConfigVal('services', d.services||''); setConfigVal('industries', d.industries||'');
  setConfigVal('competitors', d.competitors||''); setConfigVal('locations', d.locations||'');
  setConfigVal('geoMode', d.geoMode||'all');
  runRules();   // re-evaluate competitor/location rules with the new info
  return true;
}
function clientConfigured(){ var c=getConfig(); return !!(c.website || c.services.length); }

function setApiKeys(){
  var ui=SpreadsheetApp.getUi(), props=PropertiesService.getScriptProperties();
  var a=ui.prompt('OpenAI API key', 'Paste OPENAI_API_KEY (blank = keep current):', ui.ButtonSet.OK_CANCEL);
  if(a.getSelectedButton()===ui.Button.OK && a.getResponseText().trim()) props.setProperty('OPENAI_API_KEY', a.getResponseText().trim());
  var b=ui.prompt('Serper API key', 'Paste SERPER_KEY (blank = keep current):', ui.ButtonSet.OK_CANCEL);
  if(b.getSelectedButton()===ui.Button.OK && b.getResponseText().trim()) props.setProperty('SERPER_KEY', b.getResponseText().trim());
}
function prop(k){ return PropertiesService.getScriptProperties().getProperty(k); }

/* --------------------------- ONE-CLICK ---------------------------- */
function runEverything(){
  var ui=SpreadsheetApp.getUi();
  ensureAllSheets();
  if(sheet(SHEET.AKR).getLastRow()<2){ ui.alert('Paste your keyword report into the "AKR" tab first, then click "Run everything" again.'); return; }
  if(!clientConfigured()){ ui.alert('First, tell me about the client (services, competitors, domain). The form opens next.'); showSetup(); return; }
  if(!prop('OPENAI_API_KEY') || !prop('SERPER_KEY')){ ui.alert('First-time setup: paste your OpenAI + Serper API keys (you only do this once).'); setApiKeys(); }
  var haveKeys = prop('OPENAI_API_KEY') && prop('SERPER_KEY');

  var n=importAkrSilent(); runRules(); applyFormatting(true);
  var did=0; if(haveKeys) did=enrichForeground();
  var t=sheet(SHEET.TOPICS), rej=0, remaining=0;
  t.getRange(2,1,Math.max(t.getLastRow()-1,1),NCOL).getValues().forEach(function(r){ if(r[COL.STATUS-1]==='Rejected') rej++; if(r[COL.KW-1] && !r[COL.AUD-1]) remaining++; });

  var msg='Imported '+n+' topics — '+rej+' auto-rejected by rules.\n\n';
  if(!haveKeys){ msg+='API keys not set, so Audience/Type/intent were skipped. Add keys (⚙ Set API keys) and Run again.'; }
  else if(remaining>0){ startBackgroundSilent(); msg+='Enriched '+did+' so far; '+remaining+' still processing in the background (a batch runs every minute — you can keep working). Refresh in a few minutes.'; }
  else { stopBackground(); msg+='All topics enriched (Audience, Type, Modifier, BOFU filled).'; }
  msg+='\n\nNEXT: in "Topics" set Status = "Selected" on the keywords you want, then run "Self-review my selected". Use the column filters to slice.';
  ui.alert(msg);
}

/* ----------------------------- IMPORT ----------------------------- */
function importAkrSilent(){
  var src=sheet(SHEET.AKR), t=sheet(SHEET.TOPICS);
  var rows=src.getDataRange().getValues(); if(rows.length<2) return 0;
  var head=rows[0].map(function(h){return norm(h).trim();});
  var find=function(){ for(var a=0;a<arguments.length;a++){ for(var i=0;i<head.length;i++){ if(head[i].indexOf(arguments[a])>=0) return i; } } return -1; };
  var ci={ kw:find('primary keyword','keyword'), pt:find('page type','type'), topic:find('topic'), sec:find('secondary'), vol:find('search volume','volume','msv'), rel:find('relevance','score') };
  if(ci.kw<0) ci.kw=0;
  var seen={}, out=[];
  for(var i=1;i<rows.length;i++){
    var a=rows[i], kw=String(a[ci.kw]||'').trim(); if(!kw) continue;
    var topic=ci.topic>=0?String(a[ci.topic]||'').trim():'';
    var key=(kw+'|'+topic).toLowerCase(); if(seen[key]) continue; seen[key]=1;
    var pt=/serv|product/i.test(ci.pt>=0?String(a[ci.pt]||''):'')?'Service':'Blog';
    var vol=ci.vol>=0?(parseInt(String(a[ci.vol]||'').replace(/[^0-9]/g,''),10)||0):0;
    out.push([kw, pt, topic, ci.sec>=0?String(a[ci.sec]||'').trim():'', vol, ci.rel>=0?a[ci.rel]:'', '','','','','Pending','','','','','']);
  }
  if(t.getLastRow()>1) t.getRange(2,1,t.getLastRow()-1,NCOL).clearContent();
  if(out.length) t.getRange(2,1,out.length,NCOL).setValues(out);
  if(out.length){ var rule=SpreadsheetApp.newDataValidation().requireValueInList(['Pending','Selected','Rejected'],true).build(); t.getRange(2,COL.STATUS,out.length,1).setDataValidation(rule); }
  return out.length;
}

/* --------------------------- RULE ENGINE -------------------------- */
function evalRules(row, cfg){
  var R=cfg.rules, t=norm(row.kw), hits=[];
  if(R.zero && Number(row.vol)<=0) hits.push('Zero search volume');
  if(R.free && /\bfree\b/.test(t)) hits.push('Free keyword');
  if(R.nearme && /\bnear me\b/.test(t)) hits.push('"Near me" query');
  if(R.competitor){ for(var i=0;i<cfg.competitors.length;i++){ var b=cfg.competitors[i]; if(b && t.indexOf(norm(b))>=0){ hits.push('Other brand: '+b); break; } } }
  if(R.location && cfg.geoMode==='restricted'){
    var served=cfg.locations.map(norm).map(locAlias);
    var isServed=function(loc){ var a=locAlias(loc); return served.some(function(s){ return s===a||s===loc||s.indexOf(a)>=0||a.indexOf(s)>=0; }); };
    var found=US_STATES.concat(BIG_CITIES).filter(function(loc){ return new RegExp('\\b'+loc.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\b').test(t); });
    var unserved=found.filter(function(loc){ return !isServed(loc); });
    if(unserved.length && !found.some(isServed)) hits.push('Location not served: '+unserved[0]);
  }
  if(R.info && row.pageType!=='Blog' && INFO_RX.test(t)) hits.push('Informational/DIY intent');
  if(R.jobs && JOBS_RX.test(t)) hits.push('Job / education-seeker intent');
  if(R.format && FORMAT_RX.test(t)) hits.push('Wrong-format / login/app intent');
  if(R.org && (ORG_RX.test(t)||BIG_BRANDS_RX.test(t))) hits.push('Other company / brand');
  if(R.lowrel){ var nv=parseFloat(row.rel); if(!isNaN(nv) && nv<=cfg.lowRel) hits.push('Low relevance ('+row.rel+')'); }
  if(row.domains && row.domains.length){ var b2=serpBrandHit(row.domains, row.kw); if(b2 && !hits.some(function(h){return /brand/i.test(h);})) hits.push('Branded / navigational ('+b2+')'); }
  return hits.length ? {reason:hits.join('; '), layer:'Rule'} : null;
}
function runRules(){
  var t=sheet(SHEET.TOPICS); if(!t||t.getLastRow()<2) return;
  var cfg=getConfig(), n=t.getLastRow()-1, rng=t.getRange(2,1,n,NCOL), vals=rng.getValues();
  for(var i=0;i<vals.length;i++){
    var v=vals[i]; if(!v[COL.KW-1]) continue;
    v[COL.MOD-1]=modifiersOf(v[COL.KW-1], cfg); v[COL.BOFU-1]=isBofu(v[COL.KW-1])?'Yes':'No';
    if(String(v[COL.STATUS-1])==='Selected') continue;
    var domains=String(v[COL.DOMAINS-1]||'').split(',').filter(String);
    var hit=evalRules({kw:v[COL.KW-1],topic:v[COL.TOPIC-1],vol:v[COL.VOL-1],rel:v[COL.REL-1],pageType:v[COL.PT-1],domains:domains}, cfg);
    if(hit){ v[COL.STATUS-1]='Rejected'; v[COL.REASON-1]=hit.reason; v[COL.LAYER-1]=hit.layer; }
    else if(String(v[COL.STATUS-1])==='Rejected' && String(v[COL.LAYER-1])==='Rule'){ v[COL.STATUS-1]='Pending'; v[COL.REASON-1]=''; v[COL.LAYER-1]=''; }
  }
  rng.setValues(vals);
}

/* --------------------------- ENRICHMENT --------------------------- */
function loadCache(){
  var c=sheet(SHEET.CACHE), map={}; if(!c||c.getLastRow()<2) return map;
  var v=c.getRange(2,1,c.getLastRow()-1,7).getValues();
  for(var i=0;i<v.length;i++){ if(v[i][0]) map[String(v[i][0]).toLowerCase()]={domains:String(v[i][1]||'').split(',').filter(String),audience:v[i][2],type:v[i][3],keep:!(v[i][4]===false||v[i][4]==='FALSE'),reason:v[i][5],titles:String(v[i][6]||'').split(' ||| ').filter(String)}; }
  return map;
}
function saveCache(cache){
  var cs=sheet(SHEET.CACHE), rows=[];
  Object.keys(cache).forEach(function(kw){ var c=cache[kw]; rows.push([kw,(c.domains||[]).join(','),c.audience||'',c.type||'',c.keep!==false,c.reason||'',(c.titles||[]).join(' ||| ')]); });
  if(cs.getLastRow()>1) cs.getRange(2,1,cs.getLastRow()-1,7).clearContent();
  if(rows.length) cs.getRange(2,1,rows.length,7).setValues(rows);
}
function serperFetchAll(keywords, gl){
  var key=prop('SERPER_KEY'); if(!key) throw new Error('Set SERPER_KEY (⚙ Set API keys).');
  var reqs=keywords.map(function(kw){ return { url:'https://google.serper.dev/search', method:'post', headers:{'X-API-KEY':key}, contentType:'application/json', muteHttpExceptions:true, payload:JSON.stringify({q:kw, gl:gl||'us', num:10}) }; });
  var out=[];
  for(var i=0;i<reqs.length;i+=20){
    var resp=UrlFetchApp.fetchAll(reqs.slice(i,i+20));
    for(var j=0;j<resp.length;j++){ var titles=[], domains=[];
      try{ var data=JSON.parse(resp[j].getContentText()); (data.organic||[]).slice(0,10).forEach(function(o){ var h=hostOf(o.link||''); if(h){ domains.push(h); if(!IGNORE_DOMAINS.test(h)) titles.push(((o.title||'')+' '+(o.snippet||'')).trim()); } }); }catch(e){}
      out.push({domains:domains, titles:titles});
    }
  }
  return out;
}
var AUDIENCES=['B2B / Corporate','Healthcare / Clinical','Aspiring Practitioner','Athlete / Sports','Local Seeker','Individual / Consumer','Researcher / Student','General'];
var REJECT_REASONS=['Job-seeker intent','Researcher/student intent','Branded query','Off-ICP audience','No commercial intent'];
function openai(messages){
  var key=prop('OPENAI_API_KEY'); if(!key) throw new Error('Set OPENAI_API_KEY (⚙ Set API keys).');
  var resp=UrlFetchApp.fetch('https://api.openai.com/v1/chat/completions',{ method:'post', headers:{'Authorization':'Bearer '+key}, contentType:'application/json', muteHttpExceptions:true,
    payload:JSON.stringify({ model:'gpt-4o-mini', temperature:0, response_format:{type:'json_object'}, messages:messages }) });
  if(resp.getResponseCode()!==200) throw new Error('OpenAI '+resp.getResponseCode()+': '+resp.getContentText().slice(0,200));
  try{ return JSON.parse(JSON.parse(resp.getContentText()).choices[0].message.content); }catch(e){ return {}; }
}
function clientDesc(cfg){
  return [cfg.offering?('Offering: '+cfg.offering+'.'):'', cfg.services.length?('Sells: '+cfg.services.join(', ')+'.'):'',
    cfg.industries.length?('Ideal customers (ICP): '+cfg.industries.join(', ')+'.'):'', cfg.website?('Site: '+cfg.website+'.'):''].filter(String).join(' ') || '(client profile not provided)';
}
function classifyBatch(items, cfg){
  var sys='You are an SEO analyst classifying keywords for a client by INTENT, using the keyword and the titles of pages currently ranking.\n\nCLIENT: '+clientDesc(cfg)+'\n\nFor each keyword return:\n- "audience": exactly one of: '+AUDIENCES.join(' | ')+'\n- "type": a BROAD product/service category (Title Case, 1-2 words). Reuse a small consistent vocabulary.\n- "keep": true if the searcher is a plausible BUYER for THIS client; false only when clearly NOT.\n- "reason": when keep=false, exactly one of: '+REJECT_REASONS.join(' | ')+'. When keep=true, "".\nJudge real intent from the ranking titles. Branded query = a SPECIFIC company name, not generic words like branded/custom. When unsure keep=true.\nReturn ONLY JSON: {"results":[{"id":<id>,"audience":"...","type":"...","keep":true|false,"reason":"..."}]}.';
  var lines=items.map(function(it){ return JSON.stringify({id:it.id, keyword:it.kw, ranking_titles:(it.titles||[]).slice(0,6).join(' | ')}); }).join('\n');
  var j=openai([{role:'system',content:sys},{role:'user',content:'Classify these:\n'+lines}]); var byId={};
  (j.results||[]).forEach(function(o){ byId[String(o.id)]={ audience:AUDIENCES.indexOf(o.audience)>=0?o.audience:'General', type:(o.type||'').toString().slice(0,40), keep:o.keep!==false, reason:o.keep!==false?'':(REJECT_REASONS.indexOf(o.reason)>=0?o.reason:'No commercial intent') }; });
  return byId;
}
// process the next BATCH of un-enriched Topics rows; returns count processed
function processBatch(){
  var t=sheet(SHEET.TOPICS); if(!t||t.getLastRow()<2) return 0;
  var cfg=getConfig(), cache=loadCache();
  var n=t.getLastRow()-1, rng=t.getRange(2,1,n,NCOL), vals=rng.getValues(), todo=[];
  for(var i=0;i<vals.length && todo.length<BATCH;i++){ var v=vals[i]; if(!v[COL.KW-1]) continue; if(v[COL.AUD-1]) continue; todo.push(i); }
  if(!todo.length) return 0;
  var needSerp=todo.filter(function(i){ return !cache[String(vals[i][COL.KW-1]).toLowerCase()]; });
  if(needSerp.length){
    var kws=needSerp.map(function(i){ return vals[i][COL.KW-1]; });
    var serp=serperFetchAll(kws, cfg.serpGl);
    needSerp.forEach(function(i,idx){ cache[String(vals[i][COL.KW-1]).toLowerCase()]={domains:serp[idx].domains,titles:serp[idx].titles,audience:'',type:'',keep:true,reason:''}; });
  }
  var toAI=todo.filter(function(i){ var c=cache[String(vals[i][COL.KW-1]).toLowerCase()]; return !c.audience; });
  for(var b=0;b<toAI.length;b+=AI_BATCH){
    var slice=toAI.slice(b,b+AI_BATCH);
    var items=slice.map(function(i){ var kw=String(vals[i][COL.KW-1]).toLowerCase(); return {id:String(i), kw:vals[i][COL.KW-1], titles:(cache[kw].titles||[])}; });
    var res; try{ res=classifyBatch(items, cfg); }catch(e){ res={}; }
    slice.forEach(function(i){ var kw=String(vals[i][COL.KW-1]).toLowerCase(), o=res[String(i)]; if(o){ cache[kw].audience=o.audience; cache[kw].type=o.type; cache[kw].keep=o.keep; cache[kw].reason=o.reason; } else { cache[kw].audience='General'; } });
  }
  todo.forEach(function(i){ var v=vals[i], kw=String(v[COL.KW-1]).toLowerCase(), c=cache[kw];
    v[COL.AUD-1]=c.audience||'General'; v[COL.TYPE-1]=c.type||''; v[COL.DOMAINS-1]=(c.domains||[]).join(',');
    v[COL.MOD-1]=modifiersOf(v[COL.KW-1], cfg); v[COL.BOFU-1]=isBofu(v[COL.KW-1])?'Yes':'No';
    if(String(v[COL.STATUS-1])!=='Selected'){
      var hit=evalRules({kw:v[COL.KW-1],topic:v[COL.TOPIC-1],vol:v[COL.VOL-1],rel:v[COL.REL-1],pageType:v[COL.PT-1],domains:(c.domains||[])}, cfg);
      if(hit){ v[COL.STATUS-1]='Rejected'; v[COL.REASON-1]=hit.reason; v[COL.LAYER-1]='Rule'; }
      else if(c.keep===false){ v[COL.STATUS-1]='Rejected'; v[COL.REASON-1]=c.reason||'Off intent'; v[COL.LAYER-1]='AI'; }
      else if(String(v[COL.STATUS-1])==='Rejected'){ v[COL.STATUS-1]='Pending'; v[COL.REASON-1]=''; v[COL.LAYER-1]=''; }
    }
  });
  rng.setValues(vals); saveCache(cache);
  return todo.length;
}
function enrichForeground(){ var start=Date.now(), did=0; while(Date.now()-start<FG_BUDGET_MS){ var n=processBatch(); if(n===0) break; did+=n; } return did; }

/* ----------------- BACKGROUND (chunked via trigger) --------------- */
function startBackgroundSilent(){ stopBackground(); ScriptApp.newTrigger('backgroundTick').timeBased().everyMinutes(1).create(); }
function stopBackground(){ ScriptApp.getProjectTriggers().forEach(function(tr){ if(tr.getHandlerFunction()==='backgroundTick') ScriptApp.deleteTrigger(tr); }); }
function backgroundTick(){ var done=processBatch(); if(done===0){ stopBackground(); runRules(); } }

/* --------------------------- SELF-REVIEW -------------------------- */
function selfReview(){
  var t=sheet(SHEET.TOPICS); if(!t||t.getLastRow()<2) return;
  var cfg=getConfig(), cache=loadCache(), n=t.getLastRow()-1, rng=t.getRange(2,1,n,NCOL), vals=rng.getValues(), idxs=[];
  for(var i=0;i<vals.length;i++){ if(String(vals[i][COL.STATUS-1])==='Selected'){ idxs.push(i); vals[i][COL.RVERDICT-1]=''; vals[i][COL.RREASON-1]=''; } }
  if(!idxs.length){ SpreadsheetApp.getUi().alert('No rows with Status = Selected. Pick some first.'); return; }
  var need=[];
  idxs.forEach(function(i){ var v=vals[i], domains=String(v[COL.DOMAINS-1]||'').split(',').filter(String);
    var hit=evalRules({kw:v[COL.KW-1],topic:v[COL.TOPIC-1],vol:v[COL.VOL-1],rel:v[COL.REL-1],pageType:v[COL.PT-1],domains:domains}, cfg);
    if(hit){ v[COL.RVERDICT-1]='FLAG'; v[COL.RREASON-1]='[Rule] '+hit.reason; } else need.push(i); });
  for(var b=0;b<need.length;b+=AI_BATCH){
    var slice=need.slice(b,b+AI_BATCH);
    var items=slice.map(function(i){ var c=cache[String(vals[i][COL.KW-1]).toLowerCase()]||{}; return {id:String(i),kw:vals[i][COL.KW-1],topic:vals[i][COL.TOPIC-1],audience:vals[i][COL.AUD-1],type:vals[i][COL.TYPE-1],titles:(c.titles||[])}; });
    var res; try{ res=reviewBatch(items, cfg); }catch(e){ res={}; }
    slice.forEach(function(i){ var o=res[String(i)]; if(o&&o.ok===false){ vals[i][COL.RVERDICT-1]='FLAG'; vals[i][COL.RREASON-1]='[AI] '+o.reason; } else if(!vals[i][COL.RVERDICT-1]){ vals[i][COL.RVERDICT-1]='OK'; } });
  }
  idxs.forEach(function(i){ if(!vals[i][COL.RVERDICT-1]) vals[i][COL.RVERDICT-1]='OK'; });
  rng.setValues(vals);
  var flagged=idxs.filter(function(i){ return vals[i][COL.RVERDICT-1]==='FLAG'; }).length;
  SpreadsheetApp.getUi().alert('Self-review done: '+flagged+' of '+idxs.length+' selected topics flagged (see the Review / Review Reason columns).');
}
function reviewBatch(items, cfg){
  var sys='You are a senior SEO editor doing QC. A human SELECTED these keywords as pages to build for this client. Catch SELECTION MISTAKES.\n\nCLIENT: '+clientDesc(cfg)+'\n\nJudge intent from the keyword + ranking_titles IN THE CLIENT\'S CONTEXT (same words mean different things per business). Do NOT flag just because a word is ambiguous/broad/low-volume.\nFlag ok=false ONLY when: a DIFFERENT product/industry; wrong audience/ICP; job/education seeker; a SPECIFIC company/brand NAME (incl. unfamiliar: a proper-noun name + an org word like Communications/Press/Studio/Co/Inc/LLC/Agency, confirmed by ranking titles) but NOT generic words (branded/custom/personalized/foil/engraved/letterpress); or obvious junk.\nBe CONSERVATIVE. Return ONLY JSON: {"results":[{"id":<id>,"ok":true|false,"severity":"high|low","reason":"<=12 words"}]}.';
  var lines=items.map(function(it){ return JSON.stringify({id:it.id,keyword:it.kw,topic:it.topic,audience:it.audience,type:it.type,ranking_titles:(it.titles||[]).slice(0,6).join(' | ')}); }).join('\n');
  var j=openai([{role:'system',content:sys},{role:'user',content:'QC these:\n'+lines}]), byId={};
  (j.results||[]).forEach(function(o){ var ok=o.ok!==false; byId[String(o.id)]={ok:ok,reason:ok?'':(String(o.reason||'Looks off')).slice(0,120)}; });
  return byId;
}

/* --------------------------- FORMATTING --------------------------- */
function applyFormatting(silent){
  var t=sheet(SHEET.TOPICS); if(!t) return; var n=Math.max(t.getLastRow()-1,1);
  try{ t.showColumns(1,NCOL); t.hideColumns(COL.DOMAINS); }catch(e){}
  var body=t.getRange(2,1,n,NCOL), rules=[];
  rules.push(SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=$K2="Rejected"').setBackground('#fde7e7').setRanges([body]).build());
  rules.push(SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=$K2="Selected"').setBackground('#e7f6ec').setRanges([body]).build());
  rules.push(SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=$O2="FLAG"').setBackground('#fde7e7').setFontColor('#b00020').setRanges([body]).build());
  t.setConditionalFormatRules(rules);
  if(t.getFilter()) t.getFilter().remove();
  t.getRange(1,1,Math.max(t.getLastRow(),1),NCOL).createFilter();
  if(!silent) SpreadsheetApp.getUi().alert('Formatting + filter applied.');
}
function clearCache(){
  var ui=SpreadsheetApp.getUi();
  if(ui.alert('Start over?','Clears the processed Topics + AI/SERP cache (AKR and Client info kept). Continue?',ui.ButtonSet.YES_NO)!==ui.Button.YES) return;
  stopBackground();
  var c=sheet(SHEET.CACHE); if(c && c.getLastRow()>1) c.getRange(2,1,c.getLastRow()-1,7).clearContent();
  var t=sheet(SHEET.TOPICS); if(t && t.getLastRow()>1) t.getRange(2,1,t.getLastRow()-1,NCOL).clearContent();
  ui.alert('Cleared. Refresh the AKR tab and click "Run everything".');
}
