# Topic Shortlisting Tool — Google Sheets edition

The whole tool (rule engine + Serper SERP + OpenAI classify + BOFU + two-layer self-review)
running inside a single Google Sheet via Apps Script. No hosting, no deploys, no stale-tab issues.

## One-time setup (5 minutes)

1. Create a new Google Sheet.
2. **Extensions ▸ Apps Script.**
3. Delete the empty `Code.gs`, then paste in the contents of **`Code.gs`** from this folder.
   (Optional: also switch the manifest to **`appsscript.json`** here — *Project Settings ▸ "Show appsscript.json"*, then paste it. It just declares the permissions below.)
4. **Save**, then reload the Google Sheet. A **🎯 Topic Tool** menu appears.
5. **🎯 Topic Tool ▸ ① Initialise sheets** — creates the `AKR`, `Config`, `Topics` tabs (and a hidden `_Cache`).
6. **🎯 Topic Tool ▸ ② Set API keys…** — paste your OpenAI key and Serper key. They are stored in
   *Script Properties* (per-script, not visible to people who only **view** the sheet).
   The first run will ask you to **authorise** the script (UrlFetch + manage triggers) — that's expected.

## Daily use

1. **Paste your keyword report into the `AKR` tab** (columns: Primary Keyword, Page Type, Topic,
   Secondary Keywords, Total Search Volume, Relevance Score). Header names are matched loosely.
2. Fill the **`Config`** tab — `services`, `industries`, `competitors`, `locations` (comma-separated),
   `geoMode` = `all` or `restricted`, plus the `rule_*` toggles (TRUE/FALSE).
3. **③ Import AKR → Topics** — copies rows into the `Topics` working tab and runs the rules immediately.
4. **④ Run rules** anytime you change Config (instant, no API calls).
5. **⑤ Process next batch (SERP + AI)** — enriches ~100 rows per click with rankings + audience/type/intent.
   For a big sheet use **⑤ Process ALL in background** (a trigger runs a batch every minute until done;
   you can close the sheet). **⏹ Stop** cancels it.
6. **Pick your topics:** set **Status = `Selected`** on the rows you want (a dropdown is added).
   Rules never override a `Selected` row.
7. **⑥ Self-review selected** — two-layer QC of your `Selected` rows (Layer 1 = all rules,
   Layer 2 = AI intent). Flags land in the **Review** / **Review Reason** columns, tagged `[Rule]` / `[AI]`.
8. **🎨 Apply formatting** — colours Rejected/Selected/flagged rows and adds a column filter so you can
   slice by Status / BOFU / Audience / Type / Page Type natively.

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
