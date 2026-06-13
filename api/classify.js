// Vercel serverless intent classifier — keeps the OpenAI key server-side (OPENAI_API_KEY env var).
// POST { items:[{id, kw, titles?:[]}], client?:{offering,sells,icp,site} }
//   -> { results:[{id, audience, type, keep, reason}] }
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
// when keep=false, reason MUST be one of these (keeps the Rejected reason list short + intent-based)
const REJECT_REASONS = ['Job-seeker intent', 'Researcher/student intent', 'Other brand', 'Off-ICP audience', 'No commercial intent'];

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const key = process.env.OPENAI_API_KEY;
  if (!key) { res.statusCode = 500; return res.end(JSON.stringify({ error: 'OPENAI_API_KEY env var not set in Vercel' })); }
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const items = (body && body.items) || [];
  const client = (body && body.client) || {};
  if (!Array.isArray(items) || !items.length) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'missing items' })); }

  const lines = items.slice(0, 50).map(it => {
    const titles = (it.titles || []).slice(0, 6).map(t => String(t).slice(0, 160)).join(' | ');
    return `{"id": ${JSON.stringify(it.id)}, "keyword": ${JSON.stringify(String(it.kw || ''))}, "ranking_titles": ${JSON.stringify(titles)}}`;
  }).join('\n');

  const clientDesc = [
    client.offering ? `Offering: ${client.offering}.` : '',
    client.sells ? `Sells: ${client.sells}.` : '',
    client.icp ? `Ideal customers (ICP): ${client.icp}.` : '',
    client.site ? `Site: ${client.site}.` : '',
  ].filter(Boolean).join(' ') || '(client profile not provided — judge generic buyer intent)';

  const system = `You are an SEO analyst classifying keywords for a client by INTENT (who is searching and why), using the keyword and the titles/snippets of the pages currently ranking for it.

CLIENT: ${clientDesc}

For each keyword return:
- "audience": exactly one of: ${AUDIENCES.join(' | ')}
- "type": a BROAD product/service category (Title Case, 1-2 words, plural where natural). Use a SMALL consistent vocabulary (~8-12 categories for the whole client). Do NOT add qualifiers or make near-duplicates: use "Coaching" (not "Executive/Business/Mindset Coaching"), "Retreats" (not "Yoga/Leadership/Wellness Retreat"), "Workshops", "Speaking" (not "Keynote Speaker"/"Speaking Engagements"), "Monitor Stands", "Baskets". Reuse the same label across similar keywords.
- "keep": true if the searcher is a plausible BUYER/customer for THIS client; false only when they clearly are NOT.
- "reason": when keep=false, exactly one of: ${REJECT_REASONS.join(' | ')}. When keep=true, "".

Judge real intent, not surface words:
- "custom bathroom remodeling experts" = homeowner hiring a contractor => Individual / Consumer, keep.
- "mesh basket bulk supplier india" = business sourcing in bulk => B2B / Corporate, keep.
- keep=false for: job/career seekers ("jobs", "salary", "career"), pure researchers/students ("what is", "meaning", "statistics" with no buying intent), searches for a DIFFERENT company's brand, or an audience clearly outside the client's ICP.
- When unsure, keep=true (do not over-reject).

Return ONLY JSON: {"results":[{"id":<id>,"audience":"...","type":"...","keep":true|false,"reason":"..."}]} — one entry per input id.`;

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
    const validAud = new Set(AUDIENCES), validRej = new Set(REJECT_REASONS);
    const results = (parsed.results || []).map(o => {
      const keep = o.keep !== false;
      return {
        id: o.id,
        audience: validAud.has(o.audience) ? o.audience : 'General',
        type: (o.type && String(o.type).trim().slice(0, 40)) || '',
        keep,
        reason: keep ? '' : (validRej.has(o.reason) ? o.reason : 'No commercial intent'),
      };
    });
    res.statusCode = 200;
    res.end(JSON.stringify({ results }));
  } catch (e) {
    res.statusCode = 502;
    res.end(JSON.stringify({ error: String(e) }));
  }
};
