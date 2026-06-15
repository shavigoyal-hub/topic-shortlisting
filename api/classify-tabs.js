// Semantically classify the tabs of an uploaded data sheet (server-side, OPENAI_API_KEY).
// POST { tabs:[{name, sample:[[...]]}] }  ->  { roles:{ "<tab>": "offerings|industries|competitors|geography|keywords|other" }, offeringKind:"product|service|both" }
const ROLES = ['offerings', 'industries', 'competitors', 'geography', 'keywords', 'other'];

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const key = process.env.OPENAI_API_KEY;
  if (!key) { res.statusCode = 500; return res.end(JSON.stringify({ error: 'OPENAI_API_KEY env var not set in Vercel' })); }
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const tabs = (body && body.tabs) || [];
  if (!Array.isArray(tabs) || !tabs.length) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'missing tabs' })); }

  const desc = tabs.slice(0, 20).map(t => {
    const rows = (t.sample || []).slice(0, 5).map(r => (r || []).slice(0, 5).map(c => String(c == null ? '' : c).slice(0, 60)));
    return `TAB "${String(t.name).slice(0, 60)}": ${JSON.stringify(rows)}`;
  }).join('\n');

  const system = `You classify the tabs of a marketing/SEO data workbook by what the tab CONTAINS (use the tab name AND the sample rows). Assign each tab exactly one role:
- "offerings": the client's own products or services they sell (a list of offerings).
- "industries": target industries / verticals / customer segments the client serves.
- "competitors": competitor companies or other brand names.
- "geography": locations / regions / cities / markets served.
- "keywords": the keyword report — rows of search keywords (usually has a 'keyword' column + volume/topic).
- "other": anything else (notes, instructions, blank).
Also decide "offeringKind": are the offerings physical "product"s, "service"s, or "both"?
Judge by content, not just the tab's name. Return ONLY JSON: {"roles":{"<tab name>":"<role>"},"offeringKind":"product|service|both"} with every tab name as a key (verbatim).`;

  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: desc },
        ],
      }),
    });
    if (!r.ok) { const t = await r.text(); res.statusCode = r.status; return res.end(JSON.stringify({ error: 'openai ' + r.status, detail: t.slice(0, 400) })); }
    const j = await r.json();
    let parsed = {}; try { parsed = JSON.parse(j.choices[0].message.content); } catch (e) {}
    const roles = {};
    tabs.forEach(t => { const v = parsed.roles && parsed.roles[t.name]; roles[t.name] = ROLES.includes(v) ? v : 'other'; });
    const ok = ['product', 'service', 'both'].includes(parsed.offeringKind) ? parsed.offeringKind : 'both';
    res.statusCode = 200;
    res.end(JSON.stringify({ roles, offeringKind: ok }));
  } catch (e) {
    res.statusCode = 502;
    res.end(JSON.stringify({ error: String(e) }));
  }
};
