// Consolidate messy type labels into a clean, short taxonomy. POST { types:[...], existing?:[...], client?:{} }
//   -> { map: { "<raw>": "<canonical>", ... } }
module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const key = process.env.OPENAI_API_KEY;
  if (!key) { res.statusCode = 500; return res.end(JSON.stringify({ error: 'OPENAI_API_KEY env var not set in Vercel' })); }
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const types = (body && body.types) || [];
  const existing = (body && body.existing) || [];
  const client = (body && body.client) || {};
  if (!Array.isArray(types) || !types.length) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'missing types' })); }
  const clientDesc = [client.offering ? `Offering: ${client.offering}.` : '', client.sells ? `Sells: ${client.sells}.` : ''].filter(Boolean).join(' ') || '(generic)';

  const system = `You consolidate messy SEO product/service category labels into a clean, SHORT taxonomy.
CLIENT: ${clientDesc}
${existing.length ? `Prefer reusing these existing canonical categories where they fit: ${existing.join(', ')}.` : ''}
Map EACH raw label to a broad canonical category. Rules:
- Aim for ~8-12 canonical categories total for the whole client — fewer is better.
- Merge near-duplicates aggressively: singular/plural ("Workshop"/"Workshops"); specificity ("Executive Coaching","Business Coaching","Mindset Coaching" => "Coaching"; "Yoga Retreat","Leadership Retreat","Wellness Retreat" => "Retreats"; "Keynote Speaker","Speaking Engagements","Public Speaking" => "Speaking").
- Canonical labels: Title Case, 1-2 words, plural where natural ("Retreats","Workshops","Monitor Stands").
Return ONLY JSON: {"map":{"<raw>":"<canonical>"}} — include EVERY raw label exactly as given (same string) as a key.`;

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
          { role: 'user', content: 'Raw labels:\n' + JSON.stringify(types) },
        ],
      }),
    });
    if (!r.ok) { const t = await r.text(); res.statusCode = r.status; return res.end(JSON.stringify({ error: 'openai ' + r.status, detail: t.slice(0, 500) })); }
    const j = await r.json();
    let parsed = {}; try { parsed = JSON.parse(j.choices[0].message.content); } catch (e) {}
    const map = {};
    types.forEach(t => { const v = parsed.map && parsed.map[t]; map[t] = (v && String(v).trim().slice(0, 40)) || t; });
    res.statusCode = 200;
    res.end(JSON.stringify({ map }));
  } catch (e) {
    res.statusCode = 502;
    res.end(JSON.stringify({ error: String(e) }));
  }
};
