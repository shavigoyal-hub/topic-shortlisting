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
var COL = { KW:1, PT:2, TOPIC:3, SEC:4, VOL:5, REL:6, AUD:7, PROF:8, TYPE:9, MOD:10, BOFU:11, STATUS:12, REASON:13, REXP:14, CONF:15, LAYER:16, DOMAINS:17, RVERDICT:18, RREASON:19 };
var TOPIC_HEADERS = ['Keyword','Page Type','Topic','Secondary','Volume','Relevance','Audience','Profession','Type','Modifier','BOFU','Status','Reason','Reason Explained','Confidence','Layer','_domains','Review','Review Reason'];
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
function isServicePage(pt){ return /serv|product/i.test(String(pt||'')); }   // Service/Product run vs everything else (Blog, Category, …)
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
  for(var i=0;i<top.length;i++){ var name = top[i].replace(/\.[a-z.]+$/,'').replace(/[^a-z0-9]/g,''); if(name && name===kwc) return top[i]; }   // EXACT match only (domain name IS the keyword)
  return null;
}

/* Status column uses 1 = keep/selected, 0 = rejected, blank = pending (words also accepted). */
function statSel(v){ v=String(v==null?'':v).trim().toLowerCase(); return v==='1'||v==='selected'||v==='yes'||v==='y'||v==='keep'; }
function statRej(v){ v=String(v==null?'':v).trim().toLowerCase(); return v==='0'||v==='rejected'||v==='no'||v==='n'||v==='reject'; }
function statNorm(v){ return statSel(v)?'1':(statRej(v)?'0':''); }   // canonical form

/* ----------------------------- MENU ------------------------------- */
// The bootstrap delegates to this, so the menu auto-updates with the code (no re-paste for menu changes).
function buildMenu(ui){
  ui = ui || SpreadsheetApp.getUi();
  var menu=ui.createMenu('Topic Tool')
    .addItem('1. Set / edit client info', 'showSetup')
    .addItem('2. Run Service / Product', 'runEverything')
    .addItem('3. Run Blog', 'runBlog')
    .addItem('4. Run all (Service + Blog)', 'act1')
    .addSeparator()
    .addItem('Re-classify (reuse saved rankings — no fetch)', 'act2')
    .addItem('Self-review my selected', 'selfReview')
    .addSeparator()
    .addItem('Clear & start over', 'clearCache');
  if(typeof forceUpdate==='function') menu.addItem('Update to latest version', 'forceUpdate');
  menu.addToUi();
}
function onOpen(){
  try{ ensureAllSheets(); }catch(e){}
  buildMenu();
}

/* --------------------- VIEWS (filter the one tab) ----------------- */
function topicsFilter(){ var t=sheet(SHEET.TOPICS); if(!t) return null; ss().setActiveSheet(t); var f=t.getFilter(); if(!f){ applyFormatting(true); f=t.getFilter(); } return f; }
function clearViewCriteria(f){ [COL.PT, COL.STATUS].forEach(function(c){ try{ f.removeColumnFilterCriteria(c); }catch(e){} }); }
function setView(col, value){ var f=topicsFilter(); if(!f) return; clearViewCriteria(f);
  if(col){ var crit = value===null ? SpreadsheetApp.newFilterCriteria().whenCellEmpty().build() : SpreadsheetApp.newFilterCriteria().whenTextEqualTo(value).build(); f.setColumnFilterCriteria(col, crit); } }
function viewService(){ setView(COL.PT, 'Service'); }
function viewBlog(){ setView(COL.PT, 'Blog'); }
function viewSelected(){ setView(COL.STATUS, '1'); }
function viewPending(){ setView(COL.STATUS, null); }   // blank = pending
function viewRejected(){ setView(COL.STATUS, '0'); }
function viewAll(){ setView(0); }   // 0 (falsy col) = clear all view criteria

/* --------------------------- SHEETS / CONFIG ---------------------- */
function ss(){ return SpreadsheetApp.getActiveSpreadsheet(); }
function sheet(name){ return ss().getSheetByName(name); }
function ensureSheet(name){ var s=sheet(name); if(!s) s=ss().insertSheet(name); return s; }

function ensureAllSheets(){
  var cfg = ensureSheet(SHEET.CONFIG);
  if(cfg.getLastRow()===0){
    cfg.getRange(1,1,1,2).setValues([['Key','Value']]).setFontWeight('bold');
    var defaults = [['offering','Both'],['website',''],['services',''],['industries',''],['products',''],
      ['target_professions',''],['competitors',''],['locations',''],['geoMode','all'],['serpGl','us'],
      ['rule_zero','TRUE'],['rule_free','TRUE'],['rule_nearme','FALSE'],['rule_competitor','TRUE'],
      ['rule_location','TRUE'],['rule_info','TRUE'],['rule_jobs','TRUE'],['rule_format','TRUE'],
      ['rule_org','TRUE'],['rule_lowrel','FALSE'],['lowrel_threshold','1']];
    cfg.getRange(2,1,defaults.length,2).setValues(defaults);
    cfg.setColumnWidth(1,180); cfg.setColumnWidth(2,460);
  }
  var akr = ensureSheet(SHEET.AKR);
  if(akr.getLastRow()===0) akr.getRange(1,1,1,7).setValues([['Primary Keyword','Page Type','Topic','Secondary Keywords','Total Search Volume','Relevance Score','Shortlisting']]).setFontWeight('bold');
  var t = ensureSheet(SHEET.TOPICS);
  var hdr = t.getRange(1,1,1,NCOL).getValues()[0], mismatch=false;
  for(var hi=0;hi<NCOL;hi++){ if(String(hdr[hi]==null?'':hdr[hi])!==TOPIC_HEADERS[hi]){ mismatch=true; break; } }
  if(mismatch){
    t.getRange(1,1,1,NCOL).setValues([TOPIC_HEADERS]).setFontWeight('bold'); t.setFrozenRows(1);
    var last=t.getLastRow();
    if(last>1){   // heal stale data-validation left on the old Status column; re-apply at the correct one
      t.getRange(2,1,last-1,NCOL).clearDataValidations();   // remove any old dropdown
      var sr=t.getRange(2,COL.STATUS,last-1,1); sr.setNumberFormat('@');
      var sv=sr.getValues(); for(var si=0;si<sv.length;si++){ sv[si][0]=statNorm(sv[si][0]); } sr.setValues(sv);   // migrate old Selected/Rejected/Pending → 1/0/blank
    }
    try{ applyFormatting(true); }catch(e){}   // re-point conditional formatting/colours at the new columns
  }
  var c = ensureSheet(SHEET.CACHE);
  if(c.getLastRow()===0) c.getRange(1,1,1,10).setValues([['Keyword','Domains','Audience','Type','Keep','Reason','Titles','Confidence','Explain','Profession']]).setFontWeight('bold');
  c.hideSheet();
  // your own negative list — keep adding words/phrases here; topics containing them get auto-rejected
  var neg = ensureSheet('Negatives');
  if(neg.getLastRow()===0){ neg.getRange(1,1).setValue('Negative keyword / phrase  (one per row — any topic whose keyword contains this is auto-rejected when you Run / Re-apply rules)').setFontWeight('bold').setBackground('#fde7e7'); neg.setColumnWidth(1,560); neg.setFrozenRows(1); }
  // one-tab edition: remove the old separate view tabs if present
  VIEW_TABS.forEach(function(nm){ var s=sheet(nm); if(s){ try{ ss().deleteSheet(s); }catch(e){} } });
  var s1=sheet('Sheet1'); if(s1 && s1.getLastRow()===0 && ss().getSheets().length>1){ try{ ss().deleteSheet(s1); }catch(e){} }
  try{ ss().setActiveSheet(sheet(SHEET.AKR)); ss().moveActiveSheet(1); }catch(e){}
}

function getConfig(){
  var s=sheet(SHEET.CONFIG); if(!s){ ensureAllSheets(); s=sheet(SHEET.CONFIG); }
  var vals=s.getDataRange().getValues(), o={};
  for(var i=1;i<vals.length;i++){ if(vals[i][0]!=='') o[String(vals[i][0]).trim()]=vals[i][1]; }
  // one-per-line when you use line breaks (so commas inside a name are kept); else comma/semicolon separated
  var list=function(k){ var s=String(o[k]||''); var parts=/\n/.test(s)?s.split(/\n+/):s.split(/[,;]+/); return parts.map(function(x){return x.trim();}).filter(String); };
  var bool=function(k){ return String(o[k]).toUpperCase()==='TRUE'; };
  return { offering:o.offering||'Both', website:o.website||'', services:list('services'), industries:list('industries'), products:list('products'),
    targetProfessions:list('target_professions'),
    competitors:list('competitors'), locations:list('locations'), negatives:getNegatives(), geoMode:o.geoMode||'all', serpGl:o.serpGl||'us',
    rules:{ zero:bool('rule_zero'), free:bool('rule_free'), nearme:bool('rule_nearme'), competitor:bool('rule_competitor'),
      location:bool('rule_location'), info:bool('rule_info'), jobs:bool('rule_jobs'), format:bool('rule_format'), org:bool('rule_org'), lowrel:bool('rule_lowrel') },
    lowRel:Number(o.lowrel_threshold||1) };
}
// your own blocklist: any keyword containing one of these is auto-rejected. Add freely to the "Negatives" tab.
function getNegatives(){
  var s=sheet('Negatives'); if(!s||s.getLastRow()<2) return [];
  var v=s.getRange(2,1,s.getLastRow()-1,1).getValues(), out=[];
  v.forEach(function(r){ var c=String(r[0]==null?'':r[0]).trim(); if(c) out.push(c); });
  return out;
}
// real-time negatives (called by the bootstrap onEdit, via cached code, so it uses the current column layout)
function applyNegativesNow(){
  var t=sheet(SHEET.TOPICS), neg=sheet('Negatives');
  if(!t || t.getLastRow()<2) return;
  var negs=[]; if(neg && neg.getLastRow()>1){ neg.getRange(2,1,neg.getLastRow()-1,1).getValues().forEach(function(r){ var c=String(r[0]||'').trim(); if(c) negs.push(c.toLowerCase()); }); }
  var n=t.getLastRow()-1, rng=t.getRange(2,1,n,NCOL), v=rng.getValues();
  var esc=function(s){ return s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'); };
  for(var i=0;i<v.length;i++){
    var kw=String(v[i][COL.KW-1]||''); if(!kw) continue;
    var status=String(v[i][COL.STATUS-1]||''), reason=String(v[i][COL.REASON-1]||'');
    if(status==='1') continue;
    var blob=(kw+' '+(v[i][COL.TOPIC-1]||'')).toLowerCase(), hit=null;
    for(var j=0;j<negs.length;j++){ if(new RegExp('\\b'+esc(negs[j])+'\\b').test(blob)){ hit=negs[j]; break; } }
    if(hit){
      if(status===''){ v[i][COL.STATUS-1]='0'; v[i][COL.REASON-1]='Negative keyword: '+hit; v[i][COL.REXP-1]='Blocklisted term: '+hit; v[i][COL.LAYER-1]='Rule'; }
      else if(/^Negative keyword:[^;]*$/.test(reason)){ v[i][COL.REASON-1]='Negative keyword: '+hit; v[i][COL.REXP-1]='Blocklisted term: '+hit; }
    } else if(status==='0' && /^Negative keyword:[^;]*$/.test(reason)){
      v[i][COL.STATUS-1]=''; v[i][COL.REASON-1]=''; v[i][COL.REXP-1]=''; v[i][COL.LAYER-1]='';
    }
  }
  var sc=t.getRange(2,COL.STATUS,n,1); try{ sc.clearDataValidations(); }catch(e){} sc.setNumberFormat('@');
  rng.setValues(v);
}
function setConfigVal(key, val){
  var s=sheet(SHEET.CONFIG), vals=s.getDataRange().getValues();
  for(var i=1;i<vals.length;i++){ if(String(vals[i][0]).trim()===key){ s.getRange(i+1,2).setValue(val); return; } }
  s.getRange(s.getLastRow()+1,1,1,2).setValues([[key,val]]);
}

/* ---- client-info form (one dialog instead of editing the Config tab) ---- */
function showSetup(){
  ensureAllSheets(); autofillClientFromTabs(); var c=getConfig();   // pre-fill from any client-datasheet tabs present
  var v=function(x){ return String(x==null?'':x).replace(/"/g,'&quot;'); };
  var html='<style>body{font-family:Arial;font-size:13px;margin:0;padding:14px;color:#222}label{display:block;font-weight:600;margin:10px 0 3px}'
    +'input,select,textarea{width:100%;box-sizing:border-box;padding:7px;border:1px solid #ccc;border-radius:6px;font-size:13px}'
    +'small{color:#888;font-weight:400}button{margin-top:14px;background:#3b5bdb;color:#fff;border:0;border-radius:7px;padding:9px 16px;font-weight:700;cursor:pointer}</style>'
    +'<div style="background:#eef4ff;border:1px solid #cdd9f8;border-radius:7px;padding:8px 10px;font-size:12px;color:#33518f;margin-bottom:6px">💡 Have the client datasheet? Use <b>File ▸ Import ▸ Upload</b> → <b>Insert new sheet(s)</b>, then re-open this (or Run everything) — the Services / Industry / Competitors / Geographies tabs auto-fill below.</div>'
    +'<label>Client website / domain</label><input id="website" value="'+v(c.website)+'" placeholder="https://client.com">'
    +'<label>Offering</label><select id="offering"><option '+(c.offering==='Product'?'selected':'')+'>Product</option><option '+(c.offering==='Services'?'selected':'')+'>Services</option><option '+(c.offering!=='Product'&&c.offering!=='Services'?'selected':'')+'>Both</option></select>'
    +'<label>Services / Products <small>(one per line)</small></label><textarea id="services" rows="4" placeholder="One service per line&#10;Charts, Tables &amp; Graphs&#10;White-label customization">'+v(c.services.join('\n'))+'</textarea>'
    +'<label>Industries / ICP <small>(one per line)</small></label><textarea id="industries" rows="3" placeholder="Wealth Managers&#10;Financial Advisors (RIAs)">'+v(c.industries.join('\n'))+'</textarea>'
    +'<label>Competitors / brands to reject <small>(one per line)</small></label><textarea id="competitors" rows="3" placeholder="vistaprint&#10;moo&#10;minted">'+v(c.competitors.join('\n'))+'</textarea>'
    +'<label>Served locations <small>(one per line; leave blank if national)</small></label><textarea id="locations" rows="2" placeholder="new york&#10;los angeles">'+v(c.locations.join('\n'))+'</textarea>'
    +'<label>Geo mode</label><select id="geoMode"><option value="all" '+(c.geoMode!=='restricted'?'selected':'')+'>Serve anywhere (don\'t reject by location)</option><option value="restricted" '+(c.geoMode==='restricted'?'selected':'')+'>Only the locations above</option></select>'
    +'<button onclick="save()">Save</button>'
    +'<script>function save(){var d={website:website.value,offering:offering.value,services:services.value,industries:industries.value,competitors:competitors.value,locations:locations.value,geoMode:geoMode.value};google.script.run.withSuccessHandler(function(){google.script.host.close();}).saveClientInfo(d);}</script>';
  SpreadsheetApp.getUi().showModalDialog(HtmlService.createHtmlOutput(html).setWidth(430).setHeight(560), 'Client info');
}
function saveClientInfo(d){
  setConfigVal('website', d.website||''); setConfigVal('offering', d.offering||'Both');
  setConfigVal('services', d.services||''); setConfigVal('industries', d.industries||'');
  setConfigVal('competitors', d.competitors||''); setConfigVal('locations', d.locations||'');
  setConfigVal('geoMode', d.geoMode||'all');
  var props=PropertiesService.getScriptProperties();
  if(d.openaiKey && d.openaiKey.trim()) props.setProperty('OPENAI_API_KEY', d.openaiKey.trim());
  if(d.serperKey && d.serperKey.trim()) props.setProperty('SERPER_KEY', d.serperKey.trim());
  try{ var profs=deriveTargetProfessions(getConfig()); if(profs.length) setConfigVal('target_professions', profs.join('\n')); }catch(e){}   // refresh target buyer roles from the new info
  runRules();   // re-evaluate competitor/location rules with the new info
  return true;
}
function clientConfigured(){ var c=getConfig(); return !!(c.website || c.services.length); }

/* Auto-fill client info from the client datasheet's tabs (Services / Industry / Competitors / Geographies).
   Drop the client's xlsx in via File ▸ Import ▸ "Insert new sheet(s)", then this reads those tabs. */
function autofillClientFromTabs(){
  var reserved={AKR:1,Config:1,Topics:1,'_Cache':1,'Negatives':1};
  var found={services:[],industries:[],competitors:[],locations:[]}, hits=[];
  ss().getSheets().forEach(function(sh){
    var name=sh.getName(); if(reserved[name]) return;
    var n=name.toLowerCase(), role = /service|product|offering/.test(n)?'services'
      : (/industr|vertical|segment|icp|audience/.test(n)?'industries'
      : (/competitor|brand|rival/.test(n)?'competitors'
      : (/geograph|location|geo|region|market|cities|countr/.test(n)?'locations':null)));
    if(!role) return;
    if(sh.getLastRow()<1) return;
    hits.push(name+' → '+role);
    var vals=sh.getDataRange().getValues();
    for(var i=0;i<vals.length;i++){ var c=String(vals[i][0]==null?'':vals[i][0]).trim();
      if(!c) continue;
      if(i===0 && /\b(name|service|product|industr|competitor|brand|location|geo|region|market|keyword|website)\b/i.test(c)) continue;  // skip a header row
      found[role].push(c);
    }
  });
  if(!hits.length) return {hits:[], filled:0};
  var uniq=function(a){ var s={},o=[]; a.forEach(function(x){ var k=x.toLowerCase(); if(!s[k]){ s[k]=1; o.push(x); } }); return o; };
  var filled=0;
  if(found.services.length){ setConfigVal('services', uniq(found.services).join('\n')); filled++; }
  if(found.industries.length){ setConfigVal('industries', uniq(found.industries).join('\n')); filled++; }
  if(found.competitors.length){ setConfigVal('competitors', uniq(found.competitors).join('\n')); filled++; }
  if(found.locations.length){ setConfigVal('locations', uniq(found.locations).join('\n')); setConfigVal('geoMode','restricted'); filled++; }
  return {hits:hits, filled:filled, counts:{services:found.services.length,industries:found.industries.length,competitors:found.competitors.length,locations:found.locations.length}};
}

function setApiKeys(){
  var ui=SpreadsheetApp.getUi(), props=PropertiesService.getScriptProperties();
  var a=ui.prompt('OpenAI API key', 'Paste OPENAI_API_KEY (blank = keep current):', ui.ButtonSet.OK_CANCEL);
  if(a.getSelectedButton()===ui.Button.OK && a.getResponseText().trim()) props.setProperty('OPENAI_API_KEY', a.getResponseText().trim());
  var b=ui.prompt('Serper API key', 'Paste SERPER_KEY (blank = keep current):', ui.ButtonSet.OK_CANCEL);
  if(b.getSelectedButton()===ui.Button.OK && b.getResponseText().trim()) props.setProperty('SERPER_KEY', b.getResponseText().trim());
}
function prop(k){ return PropertiesService.getScriptProperties().getProperty(k); }

/* ------------------------- RUN BY PHASE --------------------------- */
function runEverything(){ return runPhase('Service'); }   // "Run Service / Product"
function runBlog(){ return runPhase('Blog'); }
function runAll(){ return runPhase('All'); }               // Service + Blog in one go
function act1(){ return runAll(); }                        // mapped to a spare bootstrap wrapper (no re-paste)
// Re-run the AI using the rankings ALREADY saved in _Cache — no new SERP/UrlFetch (avoids the daily quota).
function reclassifyKeepRankings(){
  var ui=SpreadsheetApp.getUi();
  if(ui.alert('Re-classify (reuse saved rankings)','Re-run the AI (Audience / Profession / Type / keep-reject) using the Google rankings already saved — NO new SERP calls, so it won\'t hit the daily fetch quota. Auto keep/reject are recomputed; your manual 1/0 picks are kept. Continue?',ui.ButtonSet.YES_NO)!==ui.Button.YES) return;
  var cs=sheet(SHEET.CACHE);
  if(cs && cs.getLastRow()>1){ var nr=cs.getLastRow()-1;
    cs.getRange(2,3,nr,2).clearContent();   // Audience, Type
    cs.getRange(2,5,nr,2).clearContent();   // Keep, Reason   (Domains col2 + Titles col7 KEPT → no re-SERP)
    cs.getRange(2,8,nr,3).clearContent();   // Confidence, Explain, Profession
  }
  var t=sheet(SHEET.TOPICS);
  if(t && t.getLastRow()>1){ var n=t.getLastRow()-1, rng=t.getRange(2,1,n,NCOL), v=rng.getValues();
    for(var i=0;i<v.length;i++){ if(!v[i][COL.KW-1]) continue;
      v[i][COL.AUD-1]=''; v[i][COL.PROF-1]=''; v[i][COL.TYPE-1]=''; v[i][COL.CONF-1]=''; v[i][COL.REXP-1]='';   // clear so rows re-process
      if(String(v[i][COL.LAYER-1])==='AI'||String(v[i][COL.LAYER-1])==='Rule'){ v[i][COL.STATUS-1]=''; v[i][COL.REASON-1]=''; v[i][COL.LAYER-1]=''; }   // reset auto decisions; keep manual picks
    }
    var sc=t.getRange(2,COL.STATUS,n,1); try{ sc.clearDataValidations(); }catch(e){} sc.setNumberFormat('@');
    rng.setValues(v);
  }
  ui.alert('Done — AI verdicts cleared, rankings kept. Now click "Run all": it reuses the saved rankings (no SERP) and only re-calls the AI.');
}
function act2(){ return reclassifyKeepRankings(); }
function runPhase(phase){
  var ph = (phase==='All') ? null : phase;                // null = all phases
  var ui=SpreadsheetApp.getUi();
  ensureAllSheets();
  if(sheet(SHEET.AKR).getLastRow()<2){ ui.alert('Paste your keyword report into the "AKR" tab first.'); return; }
  autofillClientFromTabs();
  // always confirm client info before running
  var c=getConfig();
  var summary='Services: '+(c.services.join(', ')||'(none)')+'\nIndustries: '+(c.industries.join(', ')||'(none)')+'\nTarget roles: '+(c.targetProfessions.join(', ')||'(auto-derived on run)')+'\nCompetitors: '+(c.competitors.join(', ')||'(none)')+'\nDomain: '+(c.website||'(none)');
  var resp=ui.alert('Check client info before running '+phase, summary+'\n\nYes = run.   No = edit it first.', ui.ButtonSet.YES_NO);
  if(resp!==ui.Button.YES){ showSetup(); return; }
  if(!clientConfigured()){ ui.alert('Set the client info first (services / competitors / domain).'); showSetup(); return; }
  if(!prop('OPENAI_API_KEY') || !prop('SERPER_KEY')){ ui.alert('Set your OpenAI + Serper API keys first (in "Set / edit client info").'); showSetup(); return; }
  if(!c.targetProfessions.length){ var profs=deriveTargetProfessions(c); if(profs.length){ setConfigVal('target_professions', profs.join('\n')); c=getConfig(); } }   // derive target buyer roles from the config once

  var t=sheet(SHEET.TOPICS);
  importAkrSilent();   // re-sync Topics to the current AKR (carries over picks + enrichment for keywords that remain)
  runRules(); applyFormatting(true);
  var did=enrichForeground(ph);
  var remaining=0; t.getRange(2,1,Math.max(t.getLastRow()-1,1),NCOL).getValues().forEach(function(r){ if(r[COL.KW-1] && (ph===null || (phase==='Service')===isServicePage(r[COL.PT-1])) && !r[COL.AUD-1]) remaining++; });

  var label = phase==='All'?'all':phase;
  var msg='Processed '+did+' '+label+' topics.';
  if(remaining>0){ msg+=' '+remaining+' more to go — click the same Run option again to continue.'; }
  else { msg+=' All '+label+' topics done.'; }
  msg+='\n\nThe AI auto-decided the confident ones (Status 1 = keep, 0 = reject) and left the borderline ones BLANK for you. Filter the Confidence column to "low" to review just those. 1 = keep, 0 = reject.';
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
  // snapshot existing rows by keyword so carried-over keywords keep their picks + enrichment
  var prev={};
  if(t.getLastRow()>1){ t.getRange(2,1,t.getLastRow()-1,NCOL).getValues().forEach(function(r){ var k=String(r[COL.KW-1]||'').toLowerCase(); if(k) prev[k]=r; }); }
  var keep=[COL.AUD,COL.TYPE,COL.MOD,COL.BOFU,COL.STATUS,COL.REASON,COL.REXP,COL.LAYER,COL.DOMAINS,COL.RVERDICT,COL.RREASON,COL.CONF,COL.PROF];
  var seen={}, out=[];
  for(var i=1;i<rows.length;i++){
    var a=rows[i], kw=String(a[ci.kw]||'').trim(); if(!kw) continue;
    var topic=ci.topic>=0?String(a[ci.topic]||'').trim():'';
    var key=(kw+'|'+topic).toLowerCase(); if(seen[key]) continue; seen[key]=1;
    var pt=(ci.pt>=0?String(a[ci.pt]||'').trim():'')||'Blog';   // keep the original Page Type (Category stays Category)
    var vol=ci.vol>=0?(parseInt(String(a[ci.vol]||'').replace(/[^0-9]/g,''),10)||0):0;
    var row=[kw, pt, topic, ci.sec>=0?String(a[ci.sec]||'').trim():'', vol, ci.rel>=0?a[ci.rel]:'', '','','','','','','','','','','','',''];   // 19 cols (…Confidence, Profession)
    var p=prev[kw.toLowerCase()];
    if(p){ keep.forEach(function(c){ row[c-1]=p[c-1]; }); }   // carry over enrichment + pick for a keyword that still exists
    out.push(row);
  }
  out.sort(function(a,b){ return (isServicePage(a[COL.PT-1])?0:1)-(isServicePage(b[COL.PT-1])?0:1); });   // Service/Product first, then the rest
  if(t.getLastRow()>1) t.getRange(2,1,t.getLastRow()-1,NCOL).clearContent();
  if(out.length){
    t.getRange(2,1,out.length,NCOL).setValues(out);
    t.getRange(2,COL.STATUS,out.length,1).setNumberFormat('@');   // keep 0/1 as text
  }
  return out.length;
}

/* --------------------------- RULE ENGINE -------------------------- */
function evalRules(row, cfg){
  var R=cfg.rules, t=norm(row.kw), hits=[];
  // Negatives = your blocklist identifiers: match as a whole word across keyword + topic + secondary
  if(cfg.negatives && cfg.negatives.length){
    var negblob=norm(row.kw+' '+(row.topic||''));   // primary keyword + topic only — NOT the secondary variant cluster (it contains every phrasing, incl. "near me")
    for(var ni=0;ni<cfg.negatives.length;ni++){ var neg=norm(cfg.negatives[ni]); if(!neg) continue;
      if(new RegExp('\\b'+neg.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\b').test(negblob)){ hits.push('Negative keyword: '+cfg.negatives[ni]); break; } }
  }
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
  if(R.info && !/blog/i.test(String(row.pageType||'')) && INFO_RX.test(t)) hits.push('Informational/DIY intent');   // skip blogs; Category/Service get the info rule
  if(R.jobs && JOBS_RX.test(t)) hits.push('Job / education-seeker intent');
  if(R.format && FORMAT_RX.test(t)) hits.push('Wrong-format / login/app intent');
  if(R.org && (ORG_RX.test(t)||BIG_BRANDS_RX.test(t))) hits.push('Other company / brand');
  if(R.lowrel){ var nv=parseFloat(row.rel); if(!isNaN(nv) && nv<=cfg.lowRel) hits.push('Low relevance ('+row.rel+')'); }
  if(row.domains && row.domains.length){ var b2=serpBrandHit(row.domains, row.kw); if(b2 && !hits.some(function(h){return /brand/i.test(h);})) hits.push('Branded / navigational ('+b2+')'); }
  return hits.length ? {reason:hits.join('; '), layer:'Rule'} : null;
}
function runRules(){
  ensureAllSheets();   // self-heal the header/columns if the layout changed
  var t=sheet(SHEET.TOPICS); if(!t||t.getLastRow()<2) return;
  var cfg=getConfig(), n=t.getLastRow()-1, rng=t.getRange(2,1,n,NCOL), vals=rng.getValues();
  for(var i=0;i<vals.length;i++){
    var v=vals[i]; if(!v[COL.KW-1]) continue;
    v[COL.MOD-1]=modifiersOf(v[COL.KW-1], cfg); v[COL.BOFU-1]=isBofu(v[COL.KW-1])?'Yes':'No';
    v[COL.STATUS-1]=statNorm(v[COL.STATUS-1]);                 // migrate Selected/Rejected/Pending → 1/0/blank
    if(v[COL.STATUS-1]==='1') continue;                        // human keep — protected
    var domains=String(v[COL.DOMAINS-1]||'').split(',').filter(String);
    var hit=evalRules({kw:v[COL.KW-1],topic:v[COL.TOPIC-1],sec:v[COL.SEC-1],vol:v[COL.VOL-1],rel:v[COL.REL-1],pageType:v[COL.PT-1],domains:domains}, cfg);
    if(hit){ v[COL.STATUS-1]='0'; v[COL.REASON-1]=hit.reason; v[COL.LAYER-1]=hit.layer; }
    else if(String(v[COL.LAYER-1])==='Rule'){ v[COL.STATUS-1]=''; v[COL.REASON-1]=''; v[COL.LAYER-1]=''; }   // was rule-rejected, no longer
  }
  var sc=t.getRange(2,COL.STATUS,n,1); try{ sc.clearDataValidations(); }catch(e){}   // remove any old dropdown
  sc.setNumberFormat('@');   // keep 0/1 as text
  rng.setValues(vals);
}

/* --------------------------- ENRICHMENT --------------------------- */
function loadCache(){
  var c=sheet(SHEET.CACHE), map={}; if(!c||c.getLastRow()<2) return map;
  var v=c.getRange(2,1,c.getLastRow()-1,10).getValues();
  for(var i=0;i<v.length;i++){ if(v[i][0]) map[String(v[i][0]).toLowerCase()]={domains:String(v[i][1]||'').split(',').filter(String),audience:v[i][2],type:v[i][3],keep:!(v[i][4]===false||v[i][4]==='FALSE'),reason:v[i][5],titles:String(v[i][6]||'').split(' ||| ').filter(String),conf:v[i][7]||'',explain:v[i][8]||'',profession:v[i][9]||''}; }
  return map;
}
function saveCache(cache){
  var cs=sheet(SHEET.CACHE), rows=[];
  Object.keys(cache).forEach(function(kw){ var c=cache[kw]; rows.push([kw,(c.domains||[]).join(','),c.audience||'',c.type||'',c.keep!==false,c.reason||'',(c.titles||[]).join(' ||| '),c.conf||'',c.explain||'',c.profession||'']); });
  if(cs.getLastRow()>1) cs.getRange(2,1,cs.getLastRow()-1,10).clearContent();
  if(rows.length) cs.getRange(2,1,rows.length,10).setValues(rows);
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
    cfg.industries.length?('Ideal customers (ICP): '+cfg.industries.join(', ')+'.'):'',
    (cfg.targetProfessions&&cfg.targetProfessions.length)?('TARGET BUYER ROLES: '+cfg.targetProfessions.join(', ')+'.'):'',
    cfg.website?('Site: '+cfg.website+'.'):''].filter(String).join(' ') || '(client profile not provided)';
}
// derive the client's target buyer professions/roles from the whole config (one cheap AI call)
function deriveTargetProfessions(cfg){
  if(!prop('OPENAI_API_KEY')) return [];
  var base=[cfg.offering?('Offering: '+cfg.offering+'.'):'', cfg.services.length?('Sells: '+cfg.services.join(', ')+'.'):'',
    cfg.industries.length?('Industries/ICP: '+cfg.industries.join(', ')+'.'):'', cfg.website?('Site: '+cfg.website+'.'):''].filter(String).join(' ');
  if(!base) return [];
  try{
    var j=openai([
      {role:'system',content:'You are an ICP analyst. From the client profile, list the specific BUYER PROFESSIONS / JOB ROLES this client sells to — the people who decide to buy or use the offering (e.g. "Wealth Manager", "Credit Analyst", "Marketing Manager", "Homeowner"). 4-10 concise role titles, most important first. Return ONLY JSON: {"professions":["...","..."]}.'},
      {role:'user',content:base}
    ]);
    return (j.professions||[]).map(function(x){return String(x).trim();}).filter(String).slice(0,12);
  }catch(e){ return []; }
}
function classifyBatch(items, cfg){
  var sys='You are an SEO analyst classifying keywords for a SPECIALIST client by INTENT, using the keyword and the titles of pages currently ranking.\n\nCLIENT: '+clientDesc(cfg)+'\n\nThe client is a SPECIALIST in the offering above — judge fit STRICTLY against THAT specific offering, not "anyone who buys supplements/services".\n\nFor each keyword return:\n- "audience": exactly one of: '+AUDIENCES.join(' | ')+'\n- "type": a BROAD product/service category (Title Case, 1-2 words). Reuse a small consistent vocabulary.\n- "keep": true only if the topic is squarely within the client\'s specific offering; false when it is off-topic for THIS client.\n- "reason": when keep=false, exactly one of: '+REJECT_REASONS.join(' | ')+'. When keep=true, "".\n\nSet keep=false (reason "Off-ICP audience") when the topic is a DIFFERENT product, condition, or category than the client treats — e.g. a gut/candida client should REJECT general potassium/magnesium/multivitamin/heart/metabolic topics; a printing client should reject unrelated products. Being a plausible "supplement buyer" or "consumer" is NOT enough — it must match the client\'s actual niche.\n\nSet keep=false (reason "Branded query") for a SPECIFIC company OR product brand name — including ones you do not recognise: a proper-noun product name (e.g. "Culturelle IBS Support", "Matol KM", "Candida X", "Brand X supplement") is a branded query. Do NOT reject the client\'s own generic category words.\n\nAlso keep=false for: job/career seekers ("Job-seeker intent"); pure "what is / definition / statistics / toxicity" research with no buying path ("Researcher/student intent").\n\nJudge real intent from the ranking titles. When the topic is clearly OUTSIDE the client\'s niche, prefer keep=false. Only keep=true when it genuinely fits.\n\nAlso return "confidence": "high" when the keep/reject call is obvious, or "low" when it is borderline / you are unsure (a human will review the low ones). Be honest — use "low" whenever it is a judgement call.\nAlso return "explain": a SHORT, SPECIFIC plain-English reason (max ~14 words) grounded in what the keyword really means + the ranking titles — e.g. "“CRA” = Canada Revenue Agency tax, not the client’s field", "Academic credit-risk content", "Brand/product name (Culturelle)", "Good fit: on-niche buyer". Not a generic restatement.\nAlso return "profession": the likely SEARCHER\'S role/profession in 1-3 words — prefer one of the client\'s ICP roles above when it fits (e.g. "Wealth Manager", "Financial Advisor", "Credit Analyst"); otherwise a general role like "Consumer", "Business owner", "Job seeker", "Student/Researcher", "Clinician". Use "General" only if truly unclear.\nThe PROFESSION is a primary fit test: if the profession is clearly NOT someone the client sells to (a job seeker, student/academic, or a role outside the ICP roles above), set keep=false, reason "Off-ICP audience", confidence "high", and put the role mismatch in "explain" (e.g. "Searcher is a job seeker, not the client’s buyer"). Keep=true only when the profession is a plausible TARGET buyer for THIS client.\nReturn ONLY JSON: {"results":[{"id":<id>,"audience":"...","type":"...","keep":true|false,"reason":"...","confidence":"high|low","explain":"...","profession":"..."}]}.';
  var lines=items.map(function(it){ return JSON.stringify({id:it.id, keyword:it.kw, ranking_titles:(it.titles||[]).slice(0,6).join(' | ')}); }).join('\n');
  var j=openai([{role:'system',content:sys},{role:'user',content:'Classify these:\n'+lines}]); var byId={};
  (j.results||[]).forEach(function(o){ byId[String(o.id)]={ audience:AUDIENCES.indexOf(o.audience)>=0?o.audience:'General', type:(o.type||'').toString().slice(0,40), keep:o.keep!==false, reason:o.keep!==false?'':(REJECT_REASONS.indexOf(o.reason)>=0?o.reason:'No commercial intent'), conf:(String(o.confidence||'').toLowerCase()==='high'?'high':'low'), explain:(o.explain||'').toString().slice(0,160), profession:(o.profession||'').toString().slice(0,40) }; });
  return byId;
}
// process the next BATCH of un-enriched Topics rows (optionally only one phase); returns count processed
function processBatch(phase){
  var t=sheet(SHEET.TOPICS); if(!t||t.getLastRow()<2) return 0;
  var cfg=getConfig(), cache=loadCache();
  var n=t.getLastRow()-1, rng=t.getRange(2,1,n,NCOL), vals=rng.getValues(), todo=[];
  for(var i=0;i<vals.length && todo.length<BATCH;i++){ var v=vals[i]; if(!v[COL.KW-1]) continue; if(phase && (phase==='Service')!==isServicePage(v[COL.PT-1])) continue; if(v[COL.AUD-1]) continue; todo.push(i); }
  if(!todo.length) return 0;
  var needSerp=todo.filter(function(i){ return !cache[String(vals[i][COL.KW-1]).toLowerCase()]; });
  if(needSerp.length){
    var kws=needSerp.map(function(i){ return vals[i][COL.KW-1]; });
    var serp=serperFetchAll(kws, cfg.serpGl);
    needSerp.forEach(function(i,idx){ cache[String(vals[i][COL.KW-1]).toLowerCase()]={domains:serp[idx].domains,titles:serp[idx].titles,audience:'',type:'',keep:true,reason:'',conf:''}; });
  }
  var toAI=todo.filter(function(i){ var c=cache[String(vals[i][COL.KW-1]).toLowerCase()]; return !c.audience; });
  for(var b=0;b<toAI.length;b+=AI_BATCH){
    var slice=toAI.slice(b,b+AI_BATCH);
    var items=slice.map(function(i){ var kw=String(vals[i][COL.KW-1]).toLowerCase(); return {id:String(i), kw:vals[i][COL.KW-1], titles:(cache[kw].titles||[])}; });
    var res; try{ res=classifyBatch(items, cfg); }catch(e){ res={}; }
    slice.forEach(function(i){ var kw=String(vals[i][COL.KW-1]).toLowerCase(), o=res[String(i)]; if(o){ cache[kw].audience=o.audience; cache[kw].type=o.type; cache[kw].keep=o.keep; cache[kw].reason=o.reason; cache[kw].conf=o.conf; cache[kw].explain=o.explain; cache[kw].profession=o.profession; } else { cache[kw].audience='General'; cache[kw].conf='low'; } });
  }
  todo.forEach(function(i){ var v=vals[i], kw=String(v[COL.KW-1]).toLowerCase(), c=cache[kw];
    v[COL.AUD-1]=c.audience||'General'; v[COL.TYPE-1]=c.type||''; v[COL.DOMAINS-1]=(c.domains||[]).join(',');
    v[COL.MOD-1]=modifiersOf(v[COL.KW-1], cfg); v[COL.BOFU-1]=isBofu(v[COL.KW-1])?'Yes':'No'; v[COL.CONF-1]=c.conf||''; v[COL.REXP-1]=c.explain||''; v[COL.PROF-1]=c.profession||'';
    v[COL.STATUS-1]=statNorm(v[COL.STATUS-1]);
    if(v[COL.STATUS-1]!=='1'){   // keeps (human or AI) are protected; review/override them manually
      var hit=evalRules({kw:v[COL.KW-1],topic:v[COL.TOPIC-1],sec:v[COL.SEC-1],vol:v[COL.VOL-1],rel:v[COL.REL-1],pageType:v[COL.PT-1],domains:(c.domains||[])}, cfg);
      var conf=String(c.conf||'').toLowerCase();
      if(hit){ v[COL.STATUS-1]='0'; v[COL.REASON-1]=hit.reason; v[COL.REXP-1]=hit.reason; v[COL.LAYER-1]='Rule'; }                       // rules are definitive
      else if(c.keep===false && conf!=='low'){ v[COL.STATUS-1]='0'; v[COL.REASON-1]=c.reason||'Off intent'; v[COL.LAYER-1]='AI'; }   // confident reject (REXP = AI explain)
      else if(c.keep!==false && conf==='high'){ v[COL.STATUS-1]='1'; v[COL.REASON-1]='AI keep'; v[COL.LAYER-1]='AI'; }   // confident keep → auto-select
      else { if(String(v[COL.LAYER-1])==='Rule'||String(v[COL.LAYER-1])==='AI'){ v[COL.STATUS-1]=''; v[COL.REASON-1]=''; v[COL.LAYER-1]=''; } }   // low confidence → leave blank for you to review
    }
  });
  t.getRange(2,COL.STATUS,n,1).setNumberFormat('@');   // keep 0/1 as text
  rng.setValues(vals); saveCache(cache);
  return todo.length;
}
function enrichForeground(phase){ var start=Date.now(), did=0; while(Date.now()-start<FG_BUDGET_MS){ var n=processBatch(phase); if(n===0) break; did+=n; } return did; }

/* Background triggers removed (they need a permission Google can't auto-detect through the bootstrap).
   Processing is foreground-only now; click "Run …" again to continue a large set. These are safe no-ops
   so any leftover trigger / menu wrapper can't error. */
function startBackgroundSilent(phase){}
function stopBackground(){ try{ ScriptApp.getProjectTriggers().forEach(function(tr){ if(tr.getHandlerFunction()==='backgroundTick') ScriptApp.deleteTrigger(tr); }); }catch(e){} }
function backgroundTick(){ try{ processBatch(prop('bg_phase')||null); }catch(e){} }

/* --------------------------- SELF-REVIEW -------------------------- */
function selfReview(){
  var t=sheet(SHEET.TOPICS); if(!t||t.getLastRow()<2) return;
  var cfg=getConfig(), cache=loadCache(), n=t.getLastRow()-1, rng=t.getRange(2,1,n,NCOL), vals=rng.getValues(), idxs=[];
  for(var i=0;i<vals.length;i++){ if(statSel(vals[i][COL.STATUS-1])){ idxs.push(i); vals[i][COL.RVERDICT-1]=''; vals[i][COL.RREASON-1]=''; } }
  if(!idxs.length){ SpreadsheetApp.getUi().alert('No rows marked Status = 1 (keep). Mark some first (1 = keep, 0 = reject).'); return; }
  var need=[];
  idxs.forEach(function(i){ var v=vals[i], domains=String(v[COL.DOMAINS-1]||'').split(',').filter(String);
    var hit=evalRules({kw:v[COL.KW-1],topic:v[COL.TOPIC-1],sec:v[COL.SEC-1],vol:v[COL.VOL-1],rel:v[COL.REL-1],pageType:v[COL.PT-1],domains:domains}, cfg);
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
  try{ t.showColumns(1,NCOL); t.hideColumns(COL.LAYER, 4); var sc=t.getRange(2,COL.STATUS,n,1); sc.clearDataValidations(); sc.setNumberFormat('@'); }catch(e){}   // hide Layer, _domains, Review, Review Reason (cols 16-19)
  try{ t.clearConditionalFormatRules(); }catch(e){}   // no row colouring
  if(t.getFilter()) t.getFilter().remove();
  t.getRange(1,1,Math.max(t.getLastRow(),1),NCOL).createFilter();   // keep native column filters (use them for Service/Blog/picks)
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
