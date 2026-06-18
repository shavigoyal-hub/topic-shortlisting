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
