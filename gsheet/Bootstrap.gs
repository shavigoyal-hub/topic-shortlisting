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
  try{ _call('ensureAllSheets'); }catch(e){}
  var ui = SpreadsheetApp.getUi();
  var views = ui.createMenu('👁 Views (Service / Blog / picks)')
    .addItem('🛠 Service / Product', 'viewService').addItem('📝 Blog', 'viewBlog').addSeparator()
    .addItem('✅ Selected', 'viewSelected').addItem('🔎 To review (Pending)', 'viewPending')
    .addItem('❌ Rejected', 'viewRejected').addItem('↺ Show all', 'viewAll');
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
    .addItem('🔄 Update to latest version', 'forceUpdate')
    .addToUi();
}

/* thin wrappers — each just runs the matching function from the latest code */
function runEverything(){ return _call('runEverything'); }
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
