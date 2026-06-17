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
   - imports the data into `Topics`,
   - runs every rejection rule,
   - builds the live **✅ Selected / 🔎 To review / ❌ Rejected** tabs (auto-updating),
   - and processes Google rankings + buyer intent (AI) **in the background** to fill Audience, Type & BOFU.
   - (First time only, it prompts once for the OpenAI + Serper API keys.)
3. **Pick:** in the `Topics` tab, set **Status = `Selected`** on the keywords you want. The view tabs update live.
4. **🎯 Topic Tool ▸ ✔ Self-review my selected** — two-layer QC (rules + AI) of your Selected rows;
   flags appear in the **Review** columns, tagged `[Rule]` / `[AI]`.

Optional: edit the **`Config`** tab (services / competitors / locations, rule toggles) and use
**🔁 Re-apply rules**. **🧹 Clear cache & start over** wipes Topics + cache to begin a new client.

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
