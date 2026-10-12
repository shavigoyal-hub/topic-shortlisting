// Public front-end config. The Google OAuth Client ID is public by design (safe to expose).
module.exports = (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const kvConfigured = !!((process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL) && (process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN));
  res.end(JSON.stringify({ googleClientId: process.env.GOOGLE_CLIENT_ID || '', kvConfigured }));
};
