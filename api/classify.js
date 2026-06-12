// Vercel serverless intent classifier — keeps the OpenAI key server-side (OPENAI_API_KEY env var).
// POST { items: [{ id, kw, titles?: string[] }] }  ->  { results: [{ id, audience }] }
const AUDIENCES = [
  'B2B / Corporate',        // buyer is a business: procurement, wholesale/bulk, manufacturers sourcing, companies buying for staff/office, SaaS/enterprise buyers
  'Healthcare / Clinical',  // clinicians, hospitals, patients seeking medical/clinical info or care
  'Aspiring Practitioner',  // someone wanting to get certified / trained / become a practitioner or provider
  'Athlete / Sports',       // athletes, sports teams, players, coaches (sport context)
  'Local Seeker',           // looking for a nearby provider/service ("near me", local contractors/venues)
  'Individual / Consumer',  // an individual researching/buying for personal or home use, incl. homeowners hiring a service
  'Researcher / Student',   // academic, definitional, "what is", statistics, study/research intent
  'General',                // genuinely ambiguous — no clear buyer
];

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const key = process.env.OPENAI_API_KEY;
  if (!key) { res.statusCode = 500; return res.end(JSON.stringify({ error: 'OPENAI_API_KEY env var not set in Vercel' })); }
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const items = (body && body.items) || [];
  if (!Array.isArray(items) || !items.length) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'missing items' })); }

  const lines = items.slice(0, 60).map(it => {
    const titles = (it.titles || []).slice(0, 6).map(t => String(t).slice(0, 160)).join(' | ');
    return `{"id": ${JSON.stringify(it.id)}, "keyword": ${JSON.stringify(String(it.kw || ''))}, "ranking_titles": ${JSON.stringify(titles)}}`;
  }).join('\n');

  const system = `You are an SEO analyst. For each keyword, decide WHO the searcher/buyer is — their intent — using the keyword and the titles/snippets of the pages currently ranking for it.
Choose exactly ONE audience from this list (use the label verbatim):
${AUDIENCES.map(a => '- ' + a).join('\n')}
Rules:
- Judge real intent, not surface words. e.g. "custom bathroom remodeling experts" = a homeowner hiring a contractor => Individual / Consumer (NOT B2B just because a page says "commercial"). "mesh basket bulk supplier" = a business sourcing in bulk => B2B / Corporate.
- Use the ranking titles to disambiguate: if marketplaces/wholesale/manufacturer pages rank => B2B; if retail/home-service/personal pages rank => Individual / Consumer; clinical orgs => Healthcare / Clinical; etc.
- If genuinely unclear, use "General".
Return ONLY JSON: {"results":[{"id":<id>,"audience":"<label>"}]} with one entry per input id.`;

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
          { role: 'user', content: 'Classify these:\n' + lines },
        ],
      }),
    });
    if (!r.ok) { const t = await r.text(); res.statusCode = r.status; return res.end(JSON.stringify({ error: 'openai ' + r.status, detail: t.slice(0, 500) })); }
    const j = await r.json();
    let parsed = {}; try { parsed = JSON.parse(j.choices[0].message.content); } catch (e) {}
    const valid = new Set(AUDIENCES);
    const results = (parsed.results || []).map(o => ({ id: o.id, audience: valid.has(o.audience) ? o.audience : 'General' }));
    res.statusCode = 200;
    res.end(JSON.stringify({ results }));
  } catch (e) {
    res.statusCode = 502;
    res.end(JSON.stringify({ error: String(e) }));
  }
};
