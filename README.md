# Topic Shortlisting Tool

A single-file webapp for SEO topic shortlisting from an AKR keyword report. Upload one multi-tab
data sheet (Services / Industry / Competitors / AKR), and the tool auto-fills your inputs,
auto-rejects noise (zero-volume, "free", "near me", competitors, off-geo, wrong-intent),
builds identifiers (service type + modifiers), classifies a Customer Profile (ICP) per query,
and lets you review by **ICP → identifier → topic** and export a decision CSV.

Everything runs locally in the browser; nothing is uploaded.

## Top-10 rankings (Serper)
The "Rankings" feature pulls the top-10 Google results per keyword via [serper.dev](https://serper.dev)
and refines the ICP from who actually ranks. The API key is **never** in the client:

- **On Vercel:** set an env var `SERPER_KEY`. The browser calls `/api/serp` (a serverless proxy) which adds the key server-side.
- **Locally / no proxy:** paste a key into the Setup screen (it stays in your browser only).

## Deploy
1. Push to GitHub.
2. Import the repo in Vercel (no build step — static + `/api`).
3. In Vercel → Project → Settings → Environment Variables, add `SERPER_KEY = <your serper key>`.
4. Redeploy.
