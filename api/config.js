// Public front-end config. The Google OAuth Client ID is public by design (safe to expose).
module.exports = (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ googleClientId: process.env.GOOGLE_CLIENT_ID || '' }));
};
