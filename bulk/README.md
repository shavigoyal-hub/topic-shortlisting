# Bulk published-page audit (300+ accounts, one run)

Runs the exact Sheets shortlisting logic (rules + AI classify) over every account's
**PUBLISHED** Metabase pages and writes only the **rejected** (off-offering) rows.
No Apps Script, no 6-minute limit — one command does all accounts, in parallel.

## Setup (once)
1. `cp .env.example .env` and fill in Metabase creds + `OPENAI_API_KEY` (stays local; never committed).
2. Put your inputs in this folder:
   - **`Client Knowledge Bases.csv`** — export that tab from the Sheet (File ▸ Download ▸ CSV). Columns: `Client | Product Names | Service Names`.
   - **`domains.txt`** — the accounts to run, one domain per line (or a CSV whose first column is the domain).

## Run
```bash
cd bulk
node bulk_audit.mjs --kb "Client Knowledge Bases.csv" --accounts domains.txt --out rejected.csv
```
Options: `--concurrency 6` (parallel requests), `--batch 50` (pages per AI call).

## Output
`rejected.csv` — one row per off-offering published page:
`client, primaryKeyword, pageType, topic, volume, publishedUrl, Audience, Profession, Type, Modifier, BOFU, Status, Reason, Reason Explained, Confidence`
Plus a per-account summary (pages / rejected / resolved offering) printed to the console.

The offering for each domain is looked up from the KB CSV by domain/name core-match — a
`[NO KB match]` in the summary means that domain wasn't found in the KB (only rule-based
rejects apply for it).
