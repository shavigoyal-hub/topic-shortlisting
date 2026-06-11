// Vercel serverless proxy for Serper.dev — keeps the API key server-side (SERPER_KEY env var).
module.exports = async (req, res) => {
  const key = process.env.SERPER_KEY;
  if (!key) { res.statusCode = 500; res.setHeader('Content-Type','application/json'); return res.end(JSON.stringify({ error: 'SERPER_KEY env var not set in Vercel' })); }
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};
  const q = body.q || (req.query && req.query.q);
  const gl = (body.gl || (req.query && req.query.gl) || '').toString().trim();
  if (!q) { res.statusCode = 400; res.setHeader('Content-Type','application/json'); return res.end(JSON.stringify({ error: 'missing q' })); }
  const payload = { q, num: 10, page: 1 };
  if (/^[a-z]{2}$/i.test(gl)) payload.gl = gl.toLowerCase(); else if (gl) payload.location = gl;
  try {
    const r = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const text = await r.text();
    res.statusCode = r.status;
    res.setHeader('Content-Type', 'application/json');
    res.end(text);
  } catch (e) {
    res.statusCode = 502; res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify({ error: String(e) }));
  }
};
