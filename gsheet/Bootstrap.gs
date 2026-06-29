/**********************************************************************
 * Topic Shortlisting Tool — BOOTSTRAP (paste this ONCE, never again).
 *
 * This tiny file pulls the latest Code.gs from GitHub and runs it, so
 * any update I push goes live in your sheet automatically — no re-paste.
 *
 * Setup: paste this whole file into Apps Script, Save, reload the sheet.
 * (It needs the same permissions: this sheet + external requests.)
 *
 * NOTE: this executes code fetched from the public repo below. That's
 * fine because it's your own tool's repo — but only point SRC_URL at a
 * repo you trust.
 **********************************************************************/
var SRC_URL = 'https://raw.githubusercontent.com/shavigoyal-hub/topic-shortlisting/main/gsheet/Code.gs';

function _src(){
  var c = CacheService.getScriptCache(), s = c.get('tt_src');
  if(!s){
    s = UrlFetchApp.fetch(SRC_URL, {muteHttpExceptions:true}).getContentText();
    if(s && s.indexOf('function runEverything') >= 0) c.put('tt_src', s, 300);  // cache 5 min
  }
  return s;
}
function _call(fn, args){
  var code = _src();
  if(!code || code.indexOf('function runEverything') < 0) throw new Error('Could not load the latest code from GitHub — check your connection, then try again.');
  eval(code);            // defines all the tool functions in this scope
  var f; eval('f=' + fn);
  return f.apply(this, args || []);
}
function forceUpdate(){ CacheService.getScriptCache().remove('tt_src'); SpreadsheetApp.getActive().toast('Updated to the latest version.'); }

function onOpen(){
  // Prefer the menu from the latest code (auto-updates). Uses the cached copy — no network in onOpen.
  try{
    var code = CacheService.getScriptCache().get('tt_src');
    if(code && code.indexOf('function buildMenu') >= 0){ eval(code); buildMenu(SpreadsheetApp.getUi()); return; }
  }catch(e){}
  bootMenu();   // fallback (only if latest code isn't cached yet)
}
function bootMenu(){
  SpreadsheetApp.getUi().createMenu('Topic Tool')
    .addItem('1. Set / edit client info', 'showSetup')
    .addItem('2. Run Service / Product', 'runEverything')
    .addItem('3. Run Blog', 'runBlog')
    .addSeparator()
    .addItem('Self-review my selected', 'selfReview')
    .addItem('Re-apply rules', 'runRules')
    .addSeparator()
    .addItem('Stop background processing', 'stopBackground')
    .addItem('Clear & start over', 'clearCache')
    .addItem('Update to latest version', 'forceUpdate')
    .addToUi();
}

/* thin wrappers — each just runs the matching function from the latest code */
function runEverything(){ return _call('runEverything'); }
function runBlog(){ return _call('runBlog'); }
function showSetup(){ return _call('showSetup'); }
function saveClientInfo(d){ return _call('saveClientInfo', [d]); }
function selfReview(){ return _call('selfReview'); }
function runRules(){ return _call('runRules'); }
function stopBackground(){ return _call('stopBackground'); }
function setApiKeys(){ return _call('setApiKeys'); }
function clearCache(){ return _call('clearCache'); }
function backgroundTick(){ return _call('backgroundTick'); }
function viewService(){ return _call('viewService'); }
function viewBlog(){ return _call('viewBlog'); }
function viewSelected(){ return _call('viewSelected'); }
function viewPending(){ return _call('viewPending'); }
function viewRejected(){ return _call('viewRejected'); }
function viewAll(){ return _call('viewAll'); }
/* future-proof spare slots so new menu items never need another bootstrap paste */
function act1(){ return _call('act1'); }
function act2(){ return _call('act2'); }
function act3(){ return _call('act3'); }
function act4(){ return _call('act4'); }
function act5(){ return _call('act5'); }
function act6(){ return _call('act6'); }

/* REAL-TIME NEGATIVES — runs instantly when you edit the "Negatives" tab (self-contained, no network).
   Any topic whose keyword/topic/secondary contains a negative (whole word) flips Status to 0;
   remove the negative and rows it alone rejected flip back to blank. Manual 1 (keep) is never touched. */
function onEdit(e){
  try{
    if(!e || !e.range || e.range.getSheet().getName() !== 'Negatives') return;
    var code = CacheService.getScriptCache().get('tt_src');   // delegate to the auto-updating code (uses current column layout)
    if(code && code.indexOf('function applyNegativesNow') >= 0){ eval(code); applyNegativesNow(); }
  }catch(err){}
}
