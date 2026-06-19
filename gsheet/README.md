# Topic Shortlisting Tool — Google Sheets edition

The whole tool (rule engine + Serper SERP + OpenAI classify + BOFU + two-layer self-review)
running inside a single Google Sheet via Apps Script. No hosting, no deploys, no stale-tab issues.

## One-time setup (≈3 minutes, done by whoever installs it)

1. Create a new Google Sheet.
2. **Extensions ▸ Apps Script.** Delete the empty `Code.gs`, paste in **`Code.gs`** from this folder, **Save**.
   (Optional: paste **`appsscript.json`** too via *Project Settings ▸ "Show appsscript.json"* — it just declares permissions.)
3. Reload the Sheet. The tabs (`AKR`, `Config`, `Topics`, view tabs) are created automatically and a
   **🎯 Topic Tool** menu appears. The first run asks you to **authorise** the script — that's expected.

## The CSM workflow — paste, then one click

1. **Paste the keyword report into the `AKR` tab** (Primary Keyword, Page Type, Topic, Secondary,
   Total Search Volume, Relevance Score — header names matched loosely).
2. **🎯 Topic Tool ▸ ▶ Run everything.** That single action:
   - opens the **🏢 Client info** form the first time (website, services, industries, competitors,
     locations) — fill it once so the rules + AI know the client,
   - imports the data into the single **`Topics`** tab,
   - runs every rejection rule and fills **Modifier** + **BOFU**,
   - processes Google rankings + buyer intent (AI) to fill **Audience** & **Type** — as much as fits in
     ~4.5 min up front, then the rest continues in the background (refresh after a couple of minutes),
   - (prompts once for the OpenAI + Serper API keys the first time).
3. **Everything is in one tab** (`Topics`). Use the column-filter arrows to slice by Status / BOFU /
   Audience / Type / Page Type. Rejected rows are tinted red, picks green.
4. **Pick:** set **Status = `Selected`** on the keywords you want (dropdown).
5. **🎯 Topic Tool ▸ ✔ Self-review my selected** — two-layer QC (rules + AI); flags appear in the
   **Review** columns, tagged `[Rule]` / `[AI]`.

Re-open **🏢 Client info** anytime to update the profile (it re-runs the rules). **🧹 Clear & start over**
wipes Topics + cache for a new client. **⚙ Set API keys** changes the keys.

## Easiest auto-update: the bootstrap (paste once, never again)

Instead of `Code.gs`, paste **`Bootstrap.gs`** into Apps Script (just once). It fetches the latest
`Code.gs` from this repo and runs it, so **every update I push goes live automatically** — no clasp,
no npm, no re-pasting.

1. In your Sheet → **Extensions ▸ Apps Script**, delete whatever's there, paste **`Bootstrap.gs`**, **Save**.
2. Reload the Sheet, approve the one-time authorization. Done — forever.
3. When you want the very latest immediately, use **🎯 Topic Tool ▸ 🔄 Update to latest version**
   (otherwise it refreshes itself every ~5 minutes).

Trade-off: the sheet runs code fetched from the repo URL in `Bootstrap.gs`. That's fine because it's
your own tool's repo — just don't point it at a repo you don't control.

## Power-user auto-update: `clasp`

One-time setup so every future change is a single `clasp push`:

```bash
npm install -g @google/clasp          # 1. install Google's Apps Script CLI
clasp login                           # 2. log in (opens a browser; approve)
cd "Topic Shortlisting Tool/gsheet"   # 3. into this folder
cp .clasp.json.example .clasp.json    # 4. create the config
# 5. open Apps Script ▸ Project Settings, copy the "Script ID",
#    and paste it into .clasp.json (replace PASTE_YOUR_SCRIPT_ID_HERE)
clasp push -f                         # 6. push Code.gs + appsscript.json to your script
```

After that, whenever `Code.gs` changes here, just run **`clasp push -f`** and reload the sheet —
no pasting. (`.clasp.json` holds *your* script id and is git-ignored, so it stays local.)

> First `clasp push` may complain the Apps Script API is off — open
> <https://script.google.com/home/usersettings>, toggle **Apps Script API → On**, then retry.

## Views (Service / Product vs Blog)

Everything stays in one `Topics` tab; the **🎯 Topic Tool ▸ 👁 Views** submenu filters it instantly:
**Service / Product**, **Blog**, **Selected**, **To review**, **Rejected**, **Show all**. These are the
Sheets equivalent of the web app's phase tabs (they just set the column filter — your data isn't moved).

## Notes & limits

- **6-minute execution limit:** that's why processing is chunked. ~100 rows/run; the background mode
  resumes automatically. Everything is **cached per keyword** in the hidden `_Cache` tab, so re-runs
  and re-imports never re-call the APIs for a keyword already done. **🧹 Clear enrichment cache** forces a refresh.
- **Quotas:** Serper/OpenAI usage is billed to your keys. Apps Script `UrlFetch` has a generous daily
  quota (≈20k consumer / 100k Workspace) — fine for typical AKRs.
- **Logic parity:** the rules, BOFU, strict exact-match branded detection, classify and self-review
  prompts are ported verbatim from the web app, so verdicts match.

## Permissions the script needs (declared in `appsscript.json`)

- `spreadsheets.currentonly` — read/write this sheet only.
- `script.external_request` — call Serper + OpenAI.
- `script.scriptapp` — install the background-processing trigger.
