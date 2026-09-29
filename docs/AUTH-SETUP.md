# Google login (@gushwork.ai) + per-user history — setup

The tool now signs in with Google, restricted to **@gushwork.ai**, verifies the token **server-side**, and
saves each run's history under the signed-in user's id in **Vercel KV**.

**Deploy order matters:** set the environment variables and create the KV store **before** this ships to
`main`, or the app will show "Google sign-in not configured" and every `/api/*` call returns 401.

## 1) Create a Google OAuth Client ID (~5 min)
1. Go to <https://console.cloud.google.com/apis/credentials> (any project; create one if needed).
2. If asked, configure the **OAuth consent screen**: User type **Internal** (keeps it to your Workspace),
   app name "Gushwork AKR Enricher", your email, Save.
3. **Create Credentials → OAuth client ID → Application type: Web application.**
4. **Authorized JavaScript origins** — add both:
   - `https://topic-shortlisting.vercel.app`
   - `http://localhost:3000` (only if you run `vercel dev` locally)
5. Leave "Authorized redirect URIs" empty (Google Identity Services uses the origins above).
6. **Create** → copy the **Client ID** (looks like `xxxxx.apps.googleusercontent.com`). It's public/safe.

## 2) Create the Vercel KV store (~1 min)
Vercel dashboard → the `topic-shortlisting` project → **Storage → Create → KV** → accept defaults.
This auto-adds `KV_REST_API_URL` and `KV_REST_API_TOKEN` to the project's env vars.

## 3) Set environment variables
Project → **Settings → Environment Variables** (Production + Preview):

| Name | Value |
|---|---|
| `GOOGLE_CLIENT_ID` | the Client ID from step 1 |
| `SESSION_SECRET` | a long random string — e.g. `openssl rand -hex 32` |
| `ADMIN_EMAILS` | comma-separated gushwork emails that get the admin view (Cannibalization + "show all users" history), e.g. `shavi.goyal@gushwork.ai` |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | added automatically by step 2 |

(`OPENAI_API_KEY`, `SERPER_KEY`, `COMPOSIO_*` stay as they were.)

## 4) Deploy
Merge this branch to `main` (or redeploy). Visit the site → **Sign in with Google** → only @gushwork.ai works.

## What changed
- **`lib/session.js`** — HMAC-signed session cookie; `getUser` / `requireUser` / `isAdmin` helpers.
- **`api/auth.js`** — verifies the Google ID token, enforces `gushwork.ai`, sets the session cookie.
- **`api/config.js`** — serves the public `GOOGLE_CLIENT_ID` to the page.
- **`api/history.js`** — per-user history in KV (`LPUSH hist:<email>`); `?all=1` merges everyone for admins.
- **Gated endpoints** (now require a valid session): `profile`, `enrich`, `consolidate`, `classify`,
  `classify-tabs`, `group-types`, `review`, `cannibalize`. This also stops anonymous callers from burning
  the OpenAI/Serper keys.
- **`enrich.html`** — Google button gate; history reads/writes the server per user; admins get a
  "Show all users" toggle. CSVs still cache locally for re-download.

## Notes
- History entries store metadata (tool, domain, counts, cost) — **not** the CSV (kept small). The produced
  CSV stays cached in the browser that made it, for re-download.
- The old admin **password** still works as a local fallback to unlock the admin view even if
  `ADMIN_EMAILS` is unset.
- Health check once live: `curl https://topic-shortlisting.vercel.app/api/config` should return your
  `googleClientId`.
