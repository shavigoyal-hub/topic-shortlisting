/**********************************************************************
 * DRAFT PAGES — live Metabase refresh for THIS sheet.
 * Paste this whole file into Extensions ▸ Apps Script (of this spreadsheet),
 * Save, reload the sheet. Then: menu "Draft Pages ▸ Set Metabase login" once,
 * then "🔄 Refresh Draft Pages" (or the on-sheet button) any time.
 *
 * Writes the "Draft Pages" column = count of clusters with page_status NULL
 * and d_at NULL ("Yet to be Generated") for each domain, live from Metabase.
 * Metabase credentials live in Script Properties (never in this code).
 **********************************************************************/
function onOpen(){
  SpreadsheetApp.getUi().createMenu('Draft Pages')
    .addItem('🔄 Refresh Draft Pages (this tab)', 'refreshDraftPages')
    .addSeparator()
    .addItem('Set Metabase login', 'setMetabaseCreds')
    .addToUi();
}

/* ---- one-time: store Metabase creds in Script Properties ---- */
function setMetabaseCreds(){
  var ui=SpreadsheetApp.getUi(), p=PropertiesService.getScriptProperties();
  function ask(label,key){ var r=ui.prompt(label, '(blank = keep current)', ui.ButtonSet.OK_CANCEL);
    if(r.getSelectedButton()===ui.Button.OK && r.getResponseText().trim()) p.setProperty(key, r.getResponseText().trim()); }
  ask('Metabase URL (e.g. https://metabase.yourco.com)','METABASE_URL');
  ask('Metabase username / email','METABASE_USERNAME');
  ask('Metabase password','METABASE_PASSWORD');
  ask('Metabase database name or id (e.g. gw_stormbreaker)','METABASE_DATABASE_ID');
  ui.alert('Saved. Now click "🔄 Refresh Draft Pages".');
}

/* ---- main: read domains from this tab, write live draft counts ---- */
function refreshDraftPages(){
  var ui=SpreadsheetApp.getUi(), sh=SpreadsheetApp.getActiveSheet();
  var data=sh.getDataRange().getValues();
  // find the header row that has both a Domain column and a Draft Pages column
  var hr=-1, dc=-1, pc=-1;
  for(var i=0;i<data.length;i++){ var d=-1,p=-1;
    for(var j=0;j<data[i].length;j++){ var h=String(data[i][j]).toLowerCase().trim();
      if(d<0 && h.indexOf('domain')>=0) d=j;
      if(p<0 && h.indexOf('draft')>=0 && h.indexOf('page')>=0) p=j; }
    if(d>=0 && p>=0){ hr=i; dc=d; pc=p; break; } }
  if(hr<0){ ui.alert('Could not find a "Domain Name" + "Draft Pages" header on this tab.'); return; }

  var rows=[]; for(var r=hr+1;r<data.length;r++){ var raw=String(data[r][dc]||'').trim(); rows.push({r:r, raw:raw, d:raw?normDomain_(raw):''}); }
  var doms=[]; var seen={}; rows.forEach(function(x){ if(x.d && !seen[x.d]){ seen[x.d]=1; doms.push(x.d); } });
  if(!doms.length){ ui.alert('No domains found under the "Domain Name" column.'); return; }

  var s, db;
  try{ s=mbLogin_(); db=mbDbId_(s); }catch(e){ ui.alert('Metabase login failed — run "Set Metabase login" first.\n\n'+e.message); return; }

  var cnt={};
  for(var k=0;k<doms.length;k+=400){
    var chunk=doms.slice(k,k+400).map(function(d){return "'"+esc_(d)+"'";}).join(',');
    var sql="SELECT LOWER(p.root_domain), COUNT(*) FROM public.clusters c JOIN public.projects p ON p.id=c.p_id "
      +"WHERE c.page_status IS NULL AND c.d_at IS NULL AND LOWER(p.root_domain) IN ("+chunk+") GROUP BY LOWER(p.root_domain)";
    var res=mbRunSql_(s,db,sql);
    (res.rows||[]).forEach(function(row){ cnt[String(row[0])]=row[1]; });
  }

  // write the whole Draft Pages column in one shot (blank for rows with no domain)
  var col=rows.map(function(x){ return [ x.d ? (x.d in cnt ? cnt[x.d] : 0) : '' ]; });
  sh.getRange(hr+2, pc+1, col.length, 1).setValues(col);
  var filled=doms.filter(function(d){return d in cnt;}).length;
  ui.alert('✅ Refreshed Draft Pages for '+doms.length+' domain(s) — '+filled+' found in Metabase, updated '+(new Date()).toLocaleString()+'.');
}

/* ---- Metabase helpers (self-contained) ---- */
function mbCfg_(k){ var v=PropertiesService.getScriptProperties().getProperty(k); if(!v) throw new Error('Missing script property: '+k+' (run "Set Metabase login")'); return v; }
function esc_(s){ return String(s).replace(/'/g,"''"); }
function normDomain_(s){ return String(s||'').toLowerCase().replace(/^https?:\/\//,'').replace(/^www\./,'').replace(/\/.*$/,'').replace(/#.*$/,'').trim(); }
function mbLogin_(){
  var cache=CacheService.getScriptCache(), hit=cache.get('MB_SESSION'); if(hit) return hit;
  var base=mbCfg_('METABASE_URL').replace(/\/$/,'');
  var resp=UrlFetchApp.fetch(base+'/api/session',{method:'post',contentType:'application/json',
    payload:JSON.stringify({username:mbCfg_('METABASE_USERNAME'),password:mbCfg_('METABASE_PASSWORD')}),muteHttpExceptions:true});
  if(resp.getResponseCode()!==200) throw new Error('Metabase login failed: '+resp.getContentText().slice(0,300));
  var id=JSON.parse(resp.getContentText()).id; cache.put('MB_SESSION',id,21600); return id;
}
function mbDbId_(s){
  var raw=mbCfg_('METABASE_DATABASE_ID').trim(); if(/^\d+$/.test(raw)) return Number(raw);
  var base=mbCfg_('METABASE_URL').replace(/\/$/,'');
  var resp=UrlFetchApp.fetch(base+'/api/database',{headers:{'X-Metabase-Session':s},muteHttpExceptions:true});
  var list=(JSON.parse(resp.getContentText()).data)||[]; var m=list.find(function(db){return (db.name||'').toLowerCase()===raw.toLowerCase();});
  if(!m) throw new Error('DB not found. Available: '+list.map(function(d){return d.name;}).join(', ')); return m.id;
}
function mbRunSql_(s,db,sql){
  var base=mbCfg_('METABASE_URL').replace(/\/$/,'');
  var resp=UrlFetchApp.fetch(base+'/api/dataset',{method:'post',contentType:'application/json',headers:{'X-Metabase-Session':s},
    payload:JSON.stringify({type:'native',native:{query:sql},database:db,constraints:{'max-results':1000000,'max-results-bare-rows':1000000}}),muteHttpExceptions:true});
  var code=resp.getResponseCode(); if(code!==200&&code!==202) throw new Error('Query failed: '+code+' '+resp.getContentText().slice(0,400));
  var body=JSON.parse(resp.getContentText()); if(body.status==='failed'||body.error) throw new Error('Metabase error: '+(body.error||'').slice(0,300));
  return { rows: (body.data&&body.data.rows)||[] };
}
