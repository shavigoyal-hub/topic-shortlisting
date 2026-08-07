// Vercel serverless — consolidate messy free-text Audience/Profession/Type labels into a small canonical vocabulary.
// POST { audience:[...distinct], profession:[...distinct], type:[...distinct] }
//   -> { audience:{raw:canonical}, profession:{...}, type:{...} }  (maps EVERY input value)
module.exports.config = { maxDuration: 30 };

async function openai(messages, key) {
  const resp = await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'gpt-4o-mini', temperature: 0, response_format: { type: 'json_object' }, messages }) });
  if (!resp.ok) throw new Error('OpenAI ' + resp.status);
  try { return JSON.parse((await resp.json()).choices[0].message.content); } catch (e) { return {}; }
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const key = process.env.OPENAI_API_KEY;
  if (!key) { res.statusCode = 500; return res.end(JSON.stringify({ error: 'OPENAI_API_KEY not set' })); }
  let body = req.body; if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const fields = ['audience', 'profession', 'type'];
  const input = {};
  fields.forEach(f => { input[f] = (Array.isArray(body && body[f]) ? body[f] : []).map(x => String(x).trim()).filter(Boolean).slice(0, 400); });
  if (!fields.some(f => input[f].length)) { res.statusCode = 200; return res.end(JSON.stringify({ audience: {}, profession: {}, type: {} })); }

  const sys = 'You consolidate messy free-text labels into a SMALL, consistent, canonical vocabulary. For EACH field independently, merge values that mean the same thing — singular/plural, casing, abbreviations, synonyms, and semantically-equivalent phrasings — into ONE canonical label (Title Case, singular, concise, 1-3 words). Examples: "geneticist" / "geneticists" / "genomics researcher" -> "Geneticist"; "printing company" / "printing companies" -> "Printing Company"; "homeowner" / "home owners" / "residential customer" -> "Homeowner". Prefer the fewest distinct labels that stay meaningful (aim for <=12 per field). You MUST return a mapping for EVERY input value in each field (a value can map to itself, Title-cased). Return ONLY JSON: {"audience":{"<raw>":"<canonical>",...},"profession":{...},"type":{...}}.';
  try {
    const j = await openai([{ role: 'system', content: sys }, { role: 'user', content: JSON.stringify(input) }], key);
    const out = {};
    fields.forEach(f => { out[f] = (j && j[f] && typeof j[f] === 'object') ? j[f] : {}; });
    res.statusCode = 200; res.end(JSON.stringify(out));
  } catch (e) {
    res.statusCode = 502; res.end(JSON.stringify({ error: String(e && e.message || e) }));
  }
};
