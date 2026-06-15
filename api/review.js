// Self-review (QC) of topics a human SELECTED — flags ones that look wrongly selected (server-side, OPENAI_API_KEY).
// POST { items:[{id, kw, topic?, audience?, type?}], client?:{offering,sells,icp,site} }
//   -> { results:[{id, ok:true|false, severity:"high"|"low", reason}] }
module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const key = process.env.OPENAI_API_KEY;
  if (!key) { res.statusCode = 500; return res.end(JSON.stringify({ error: 'OPENAI_API_KEY env var not set in Vercel' })); }
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const items = (body && body.items) || [];
  const client = (body && body.client) || {};
  if (!Array.isArray(items) || !items.length) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'missing items' })); }

  const lines = items.slice(0, 60).map(it => `{"id": ${JSON.stringify(it.id)}, "keyword": ${JSON.stringify(String(it.kw || ''))}, "topic": ${JSON.stringify(String(it.topic || ''))}, "audience": ${JSON.stringify(String(it.audience || ''))}, "type": ${JSON.stringify(String(it.type || ''))}}`).join('\n');

  const clientDesc = [
    client.offering ? `Offering: ${client.offering}.` : '',
    client.sells ? `Sells: ${client.sells}.` : '',
    client.icp ? `Ideal customers (ICP): ${client.icp}.` : '',
    client.site ? `Site: ${client.site}.` : '',
  ].filter(Boolean).join(' ') || '(client profile not provided — judge generic buyer intent)';

  const system = `You are a senior SEO editor doing QC. A human has SELECTED the following keywords/topics as pages to build for this client. Your job is to catch SELECTION MISTAKES — items that should probably NOT have been selected.

CLIENT: ${clientDesc}

For each item decide:
- "ok": true if it is a reasonable page to build for THIS client; false if it looks wrongly selected.
- "severity": "high" if it is clearly a mistake (off-topic / wrong business / no buyer), "low" if it is merely questionable / borderline.
- "reason": when ok=false, a SHORT specific reason (max ~12 words). When ok=true, "".

Flag ok=false when the topic is:
- Not related to what the client offers (different product/industry/service).
- Wrong audience / outside the client's ICP.
- Pure information/research with no path to the client's offering (e.g. "what is", "meaning", "history of") — only if it does not support the offering.
- Job/career/education seeker intent ("jobs", "salary", "course", "certification").
- A specific competitor's or other company's BRAND name (navigational) — NOT generic descriptive words like "branded/custom/personalized/promotional".
- Obvious junk, duplicate-looking, or nonsensical.

Be CONSERVATIVE: when it is a plausible fit, return ok=true. Do not flag something just because it is broad or low-volume. Judge real intent, not surface words.

Return ONLY JSON: {"results":[{"id":<id>,"ok":true|false,"severity":"high|low","reason":"..."}]} — one entry per input id.`;

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
          { role: 'user', content: 'QC these selected topics:\n' + lines },
        ],
      }),
    });
    if (!r.ok) { const t = await r.text(); res.statusCode = r.status; return res.end(JSON.stringify({ error: 'openai ' + r.status, detail: t.slice(0, 500) })); }
    const j = await r.json();
    let parsed = {}; try { parsed = JSON.parse(j.choices[0].message.content); } catch (e) {}
    const results = (parsed.results || []).map(o => {
      const ok = o.ok !== false;
      return { id: o.id, ok, severity: o.severity === 'high' ? 'high' : 'low', reason: ok ? '' : (String(o.reason || 'Looks off').slice(0, 120)) };
    });
    res.statusCode = 200;
    res.end(JSON.stringify({ results }));
  } catch (e) {
    res.statusCode = 502;
    res.end(JSON.stringify({ error: String(e) }));
  }
};
