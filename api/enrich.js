// Vercel serverless — enrich ONE chunk of AKR rows with the CURRENT engine (SERP + classify + rules).
// Keeps OPENAI_API_KEY / SERPER_KEY server-side. The browser sends small chunks so each call is quick.
// POST { items:[{id,kw,pageType,topic,vol,sec,rel}], config:{services[],products[],category,industries[],serpGl,useSerp,name,website} }
//   -> { rows:[{id, status, confidence, reason, explained, audience, profession, type, modifier, bofu, services, icp, icpFit}] }
module.exports.config = { maxDuration: 60 };

/* ---- engine (ported from bulk/akr_enrich.mjs; keep in sync) ---- */
const norm = s => (s == null ? '' : String(s)).toLowerCase();
const INFO_RX = /\b(how to|how-to|what is|what's|meaning|definition|define|youtube|you ?tube|video|videos|pdf|template|reddit|wiki|free download|guide|tutorial|at home|diy|recording|app|login|download|coupon|reviews?|quotes?|images?|examples?)\b/;
const FORMAT_RX = /\b(login|sign in|apk|download|coupon|promo code|discount code|cracked|torrent|free pdf)\b/;
const JUNK_RX = /\b(news|quotes?|images?|videos?|movies?|wiki|wikis|www|login|log ?in|trends?|trending)\b/;
const BOFU_RX = /\b(buy|buying|purchase|purchasing|order|ordering|reorder|for sale|price|prices|pricing|cost|costs|how much|cheap|cheapest|affordable|discount|quote|quotation|estimate|near me|nearby|supplier|suppliers|wholesale|bulk|vendor|vendors|manufacturer|manufacturers|distributor|distributors|compan(y|ies)|service|services|shop|store|online|hire|rent|rental|custom|customi(z|s)ed?|personali(z|s)ed?|monogram|monogrammed|engraved|branded|promotional|made to order|best|top)\b/;
const US_STATES = ['alabama','alaska','arizona','arkansas','california','colorado','connecticut','delaware','florida','georgia','hawaii','idaho','illinois','indiana','iowa','kansas','kentucky','louisiana','maine','maryland','massachusetts','michigan','minnesota','mississippi','missouri','montana','nebraska','nevada','new hampshire','new jersey','new mexico','new york','north carolina','north dakota','ohio','oklahoma','oregon','pennsylvania','rhode island','south carolina','south dakota','tennessee','texas','utah','vermont','virginia','washington','west virginia','wisconsin','wyoming'];
const MODIFIER_WORDS = ['corporate','executive','online','virtual','remote','hybrid','best','top','free','cheap','affordable','premium','private','group','beginner','advanced','intensive','custom','customized','tailored','professional','certified','accredited','small','large','team','teams','employee','staff','business','b2b','women','men','kids','senior','student'];
const MODSET = {}; MODIFIER_WORDS.forEach(w => MODSET[w] = 1);
const STATEset = {}; US_STATES.forEach(w => STATEset[w] = 1);
const isBofu = kw => { const t = norm(kw); if (INFO_RX.test(t)) return false; return BOFU_RX.test(t); };
function modifiersOf(kw, cfg) {
  const inds = {}; (cfg.industries || []).forEach(i => norm(i).split(/\s+/).forEach(w => { if (w) inds[w] = 1; }));
  const seen = {}, out = [];
  norm(kw).split(/[^a-z0-9]+/).filter(Boolean).forEach(w => { if ((MODSET[w] || STATEset[w] || inds[w]) && !seen[w]) { seen[w] = 1; out.push(w); } });
  return out.join('; ');
}
function clientDesc(cfg) {
  const sells = (cfg.services || []).concat(cfg.products || []);
  return [cfg.category ? ('BUSINESS CATEGORY (this IS the client\'s field — anything in this category is in-field): ' + cfg.category + '.') : '',
    sells.length ? ('Sells: ' + sells.join(', ') + '.') : '',
    (cfg.industries && cfg.industries.length) ? ('Ideal customers (ICP): ' + cfg.industries.join(', ') + '.') : '',
    cfg.website ? ('Site: ' + cfg.website + '.') : ''].filter(Boolean).join(' ') || '(client profile not provided)';
}
const CLASSIFY_SYS = cfg => 'You audit a client\'s candidate SEO topics. Decide ONLY one thing, the same way for EVERY industry: is the topic within the client\'s field/offering, or a genuinely DIFFERENT product / service / industry?\n\nCLIENT: ' + clientDesc(cfg) + '\n\nKEEP (off=false) if the topic is one of the client\'s products/services, OR a category, type, model, variant, brand, color, size, feature, part, or accessory of what they sell, OR content about their field — INCLUDING how-to, guide, ideas, "what is", certification, exam, course, training, comparison, "best X", cost/price, reviews, or "near me". The client\'s listed offerings are EXAMPLES, NOT exhaustive — judge the whole field/category they operate in. When a topic is a SERVICE applied to a target market ("<service> for <industry>"), judge it by the SERVICE, not the market. Search INTENT and whether the searcher looks like a student / researcher / job-seeker DO NOT matter and are NEVER a reason to reject.\n\nUse ranking_titles (actual top-10 Google results) in two steps: STEP 1 name the single INDUSTRY/FIELD those results belong to, ignoring the client. STEP 2 compare it to the client\'s BUSINESS CATEGORY — same KIND of business => KEEP. If the ranking pages are the client\'s COMPETITORS or a "best/top X in <city>" directory of businesses in the client\'s category, that PROVES the keyword is their category => KEEP. Set off=true ONLY when the ranking field is a clearly DIFFERENT business category (e.g. shares the word "application" but results are software roadmap tools while the client does university admissions).\n\nconfidence = how sure of the REJECT: "high" = clearly a different industry; "medium" = probably off but they MIGHT do it; "low" = unsure. When off=false confidence is unused.\nREJECT (off=true) ONLY when CONFIDENT the topic is a DIFFERENT product/service/industry the client clearly does NOT provide. When unsure, KEEP.\n\nTARGET ICP: ' + (cfg.anyBusiness ? 'ANY business or consumer — horizontal, so every keyword fits (icpFit always true).' : ((cfg.industries && cfg.industries.length) ? cfg.industries.join('; ') : 'not specified — treat icpFit as true')) + '\nFor each keyword return: "icp" = the single customer segment the page targets (short phrase); "icpFit" = true if that segment is a client ICP above or the client is horizontal, else false (independent of off; if unsure true). "services" = the client\'s own listed products/services (verbatim) this keyword maps to — array, max 4, [] if none. Also return audience/type/profession for reporting only.\nAlso return "product": the CORE product or service the keyword is about, as 1-3 words with the modifiers/adjectives (style, color, material, size, finish, brand, location) REMOVED — the term you would type to search a store for it. Examples: "kitchen faucet commercial style" -> "kitchen faucet"; "copper finish 33 inch farmhouse sink" -> "farmhouse sink"; "best erisa 103 audit service" -> "erisa audit". Keep the noun that names the thing; drop the qualifiers.\nReturn ONLY JSON: {"results":[{"id":<id>,"off":true|false,"reason":"<if off: the different product/industry, <=12 words; else \'\'>","confidence":"high|medium|low","audience":"...","type":"...","profession":"...","icp":"...","icpFit":true|false,"services":["..."],"product":"..."}]}.';
function parseClassify(j) {
  const byId = {};
  (j.results || []).forEach(o => { byId[String(o.id)] = { off: o.off === true, reason: String(o.reason || '').slice(0, 160), conf: (['high','medium','low'].includes(String(o.confidence || '').toLowerCase()) ? String(o.confidence).toLowerCase() : 'low'), audience: String(o.audience || 'General').slice(0, 40), type: String(o.type || '').slice(0, 40), profession: String(o.profession || '').slice(0, 40), icp: String(o.icp || '').slice(0, 50), icpFit: o.icpFit !== false, services: (Array.isArray(o.services) ? o.services : []).map(s => String(s).trim()).filter(Boolean).slice(0, 4), product: String(o.product || '').slice(0, 60) }; });
  return byId;
}
const GENERIC = new Set(['the','and','for','with','your','you','are','can','how','what','why','does','from','that','this','into','best','top','near','free','cost','price','guide','tips','ideas','service','services','product','products','solution','solutions','company','companies','custom','professional','online','list','types','type','about','more','other','their','they','when','where','which','will','make','made','need','using','used','vs']);
const stem = t => t.replace(/ies$/, 'y').replace(/s$/, '');
function inOffering(kw, names) {
  if (!names || !names.length) return false;
  const hayToks = names.join(' ').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter(Boolean).map(stem);
  const hay = new Set(hayToks), hayStr = ' ' + hayToks.join(' ') + ' ';
  const toks = String(kw || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter(t => t && t.length >= 4 && !GENERIC.has(t)).map(stem);
  for (let i = 0; i < toks.length - 1; i++) { if (hayStr.includes(' ' + toks[i] + ' ' + toks[i + 1] + ' ')) return true; }
  return toks.some(t => t.length >= 4 && hay.has(t));
}
const CATSTOP = new Set(['services','service','solutions','solution','company','companies','group','agency','firm','and','the','for','with','your','business','industry','provider','providers','professional','training','trainings','course','courses','coaching','coach','skill','skills','customer','customers','support','supporting','team','teams','staff','employee','employees','online','virtual','corporate','program','programs','management','consulting','consultant','consultants','marketing','digital','software','technology','technologies','systems','system','media','design','studio','learning','education','academy','platform','tools','products','product']);
function inCategory(kw, category) {
  if (!category) return false;
  const catToks = String(category).toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter(t => t.length >= 5 && !CATSTOP.has(t)).map(t => t.slice(0, 5));
  if (!catToks.length) return false;
  const kwToks = String(kw || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter(t => t.length >= 5).map(t => t.slice(0, 5));
  const set = new Set(catToks);
  return kwToks.some(t => set.has(t));
}
const IGNORE_DOMAINS = /(wikipedia|wikihow|britannica|fandom|youtube|youtu\.be|vimeo|reddit|quora|stackexchange|stackoverflow|medium\.com|tumblr|facebook|instagram|tiktok|twitter|x\.com|pinterest|linkedin\.com|snapchat|threads\.net|discord|news\.ycombinator)/;
const hostOf = u => { try { return String(u).replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].toLowerCase(); } catch (e) { return ''; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function serper(kw, gl, key) {
  if (!key) return [];
  for (let a = 0; a < 2; a++) {
    try {
      const r = await fetch('https://google.serper.dev/search', { method: 'POST', headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' }, body: JSON.stringify({ q: kw, gl: gl || 'us', num: 10 }) });
      if (r.status === 429 || r.status >= 500) { await sleep(900 * (a + 1)); continue; }
      if (!r.ok) return [];
      const j = await r.json(), titles = [];
      for (const o of (j.organic || []).slice(0, 10)) { const h = hostOf(o.link || ''); if (h && !IGNORE_DOMAINS.test(h)) titles.push(((o.title || '') + ' ' + (o.snippet || '')).trim()); }
      return titles;
    } catch (e) { await sleep(600); }
  }
  return [];
}
const cleanDomain = d => String(d || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '').replace(/\s+/g, '');
// For the site: search, strip qualifier words (styles/materials/colors/sizes/positions) that derail recall toward
// showroom/display pages — "kitchen faucet commercial style" -> "kitchen faucet". The AI still confirms against the
// FULL keyword, so broadening the search only improves recall; it can't cause a false keep.
const SITE_STRIP = new Set(['commercial','industrial','residential','professional','modern','rustic','farmhouse','traditional','contemporary','sleek','luxury','premium','budget','cheap','affordable','best','top','style','styles','styled','finish','finished','matte','polished','brushed','stainless','surface','mount','mounted','freestanding','undermount','single','double','triple','small','large','wide','narrow','tall','short','mini','compact','big','custom','customized','decorative','euro','european','classic','vintage','black','white','grey','gray','copper','brass','chrome','gold','golden','bronze','nickel','silver','beige','cream','ivory','pewter','cognac','champagne','emerald','rose','blue','green','red','pink','the','for','with','and','near','me','inch','inches']);
function coreQuery(kw) {
  const toks = String(kw || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter(Boolean);
  const core = toks.filter(t => !SITE_STRIP.has(t));
  return core.length ? core.join(' ') : String(kw || '');
}
// OWN-SITE COVERAGE: site:domain kw -> genuine (non-/feeds) pages that show they sell it
async function serperLinks(q, gl, key) {
  if (!key) return [];
  try {
    const r = await fetch('https://google.serper.dev/search', { method: 'POST', headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' }, body: JSON.stringify({ q, gl: gl || 'us', num: 10 }) });
    if (!r.ok) return [];
    return ((await r.json()).organic || []).map(o => ({ link: o.link || '', title: o.title || '', snippet: o.snippet || '' })).filter(o => o.link);
  } catch (e) { return []; }
}
async function openai(messages, key) {
  const resp = await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'gpt-4o', temperature: 0, response_format: { type: 'json_object' }, messages }) });
  if (!resp.ok) throw new Error('OpenAI ' + resp.status + ': ' + (await resp.text()).slice(0, 200));
  try { return JSON.parse((await resp.json()).choices[0].message.content); } catch (e) { return {}; }
}

/* ------------------------------- handler ------------------------------- */
module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const okey = process.env.OPENAI_API_KEY, skey = process.env.SERPER_KEY;
  if (!okey) { res.statusCode = 500; return res.end(JSON.stringify({ error: 'OPENAI_API_KEY not set in Vercel' })); }
  let body = req.body; if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const items = (body && body.items) || [];
  const cfg = (body && body.config) || {};
  if (!Array.isArray(items) || !items.length) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'missing items' })); }
  cfg.services = cfg.services || []; cfg.products = cfg.products || []; cfg.industries = cfg.industries || [];
  cfg.anyBusiness = cfg.industries.length ? false : true;
  const useSerp = cfg.useSerp !== false && !!skey;
  const gl = (cfg.serpGl || 'us').toLowerCase();
  const names = cfg.services.concat(cfg.products);

  try {
    // 1) SERP per keyword (limited concurrency)
    if (useSerp) {
      let i = 0;
      const worker = async () => { while (i < items.length) { const it = items[i++]; it.titles = await serper(it.kw, gl, skey); } };
      await Promise.all(Array.from({ length: Math.min(5, items.length) }, worker));
    } else { items.forEach(it => it.titles = []); }

    // 2) classify (one call for the chunk)
    const payload = items.map((it, idx) => ({ id: String(idx), keyword: it.kw, page_title: it.topic || '', ranking_titles: (it.titles || []).slice(0, 6).join(' | ') }));
    const j = await openai([{ role: 'system', content: CLASSIFY_SYS(cfg) }, { role: 'user', content: 'Classify these:\n' + payload.map(p => JSON.stringify(p)).join('\n') }], okey);
    const byId = parseClassify(j);

    // 3) preliminary decision per item
    const offeringText = ' ' + names.join(' ').toLowerCase() + ' ' + String(cfg.category || '').toLowerCase() + ' ';
    const domain = cleanDomain(cfg.domain);
    const dec = items.map((it, idx) => {
      const c = byId[String(idx)] || { off: false, conf: 'low', reason: '', audience: 'General', type: '', profession: '', icp: '', icpFit: true, services: [] };
      const t = norm(it.kw);
      const guarded = inCategory(it.kw, cfg.category) || (!useSerp && inOffering(it.kw, names));
      const junkM = t.match(JUNK_RX);
      const junkWord = junkM ? junkM[0].replace(/\s+/g, '') : '';
      const junkStem = junkWord.length > 5 ? junkWord.replace(/s$/, '') : junkWord;
      const junk = !!junkWord && !(junkStem && offeringText.includes(junkStem));
      let status = '', reason = '', explained = '', aiReject = false;
      if (FORMAT_RX.test(t)) { status = '0'; reason = 'Wrong-format / login/app intent'; explained = reason; }
      else if (junk) { status = '0'; reason = 'Wrong intent/format ("' + junkWord + '")'; explained = reason; }
      else if (c.off && c.conf !== 'low' && !guarded) { status = '0'; reason = c.reason || 'Off-topic (different product)'; explained = c.reason || ''; aiReject = true; }
      else if (c.off && c.conf === 'low' && !guarded) { status = ''; explained = c.reason || ''; }
      else { status = '1'; reason = 'In-field'; }
      return { it, idx, c, status, reason, explained, aiReject };
    });

    // 3b) OWN-SITE COVERAGE CHECK — for AI rejects, run site:domain kw; if the client's own (non-/feeds) pages
    // show they actually sell it, override to KEEP. This is what catches e.g. a cabinet site that also sells faucets.
    if (domain && skey) {
      const cands = dec.filter(d => d.aiReject);
      const withPages = [];
      await Promise.all(cands.map(async d => {
        const q = (d.c.product && d.c.product.trim()) ? d.c.product.trim() : coreQuery(d.it.kw);   // LLM-extracted product term; word-list fallback
        const hits = await serperLinks('site:' + domain + ' ' + q, gl, skey);
        const genuine = hits.filter(h => { const u = h.link.toLowerCase(); return !/\/feeds?(\/|$)/.test(u) && !/\/(blog|feeds)\//.test(u); }).slice(0, 3);
        if (genuine.length) withPages.push({ d, genuine });
      }));
      if (withPages.length) {
        let verdict = {};
        try {
          const j = await openai([
            { role: 'system', content: 'A client sells home products. For each keyword, their OWN website (excluding auto-generated /feeds SEO pages) has these pages. Decide if those pages show the client actually SELLS / OFFERS that product or service (a product or product-category page = yes; a mere blog mention = no). Return ONLY JSON: {"results":[{"id":<id>,"offers":true|false}]}.' },
            { role: 'user', content: withPages.map((w, i) => JSON.stringify({ id: i, keyword: w.d.it.kw, pages: w.genuine.map(g => g.title + ' — ' + g.link) })).join('\n') }
          ], okey);
          (j.results || []).forEach(o => { verdict[String(o.id)] = o.offers === true; });
        } catch (e) {}
        withPages.forEach((w, i) => {
          if (verdict[String(i)]) { w.d.status = '1'; w.d.reason = 'Sold on client’s own site'; w.d.explained = 'Own site sells it: ' + (w.genuine[0] ? w.genuine[0].link : ''); w.d.aiReject = false; }
        });
      }
    }

    // 3c) finalize rows (+ ICP explainer on remaining rejects)
    const rows = dec.map(d => {
      const c = d.c; let explained = d.explained;
      if (d.status === '0' && c.icp) explained = (explained ? explained + ' — ' : '') + 'people searching this are most likely ' + c.icp + (c.icpFit === false ? ", which is NOT the client's target ICP" : '');
      return { id: d.it.id, status: d.status, confidence: d.status === '' ? '' : c.conf, reason: d.reason, explained, audience: c.audience || '', profession: c.profession || '', type: c.type || '', modifier: modifiersOf(d.it.kw, cfg), bofu: isBofu(d.it.kw) ? 'Yes' : 'No', services: (c.services || []).join(', '), icp: c.icp || '', icpFit: c.icpFit === false ? 'no' : 'yes' };
    });
    res.statusCode = 200;
    res.end(JSON.stringify({ rows }));
  } catch (e) {
    res.statusCode = 502;
    res.end(JSON.stringify({ error: String(e && e.message || e) }));
  }
};
