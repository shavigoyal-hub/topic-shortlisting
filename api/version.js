// Returns the deployed git short-hash (Vercel injects VERCEL_GIT_COMMIT_SHA at build time).
module.exports = (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify({ sha: (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7) || 'dev' }));
};
