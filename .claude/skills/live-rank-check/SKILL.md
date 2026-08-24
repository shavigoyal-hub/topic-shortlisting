---
name: live-rank-check
description: >-
  Check the LIVE Google position of SPECIFIC page URLs for given queries (real
  current SERP, top 100, via Serper) — and, for pairs, whether BOTH pages rank
  live (the confirmation of active cannibalization). Use to verify a
  cannibalization report against live Google ("do both these pages actually rank
  now?", "is this still cannibalizing?", "verify the pairs live", "check live
  rank of these URLs"), or to confirm a specific page ranks for a query. This is
  PAGE-level (exact URL positions); for domain-level "where does this site rank"
  use the rank-check skill instead.
---

# Live Rank Check (page-level)

Report the **live Google position of exact page URLs** for given queries — the
real, current SERP placement (top 100, chosen country), not GSC's blended
average. Built to **verify cannibalization findings**: for a `(query, page A,
page B)` row it says whether **both** pages actually appear in live Google — the
only proof that a historical GSC co-occurrence is a *live, active* split rather
than stale deep impressions.

## When to use

- Verifying a cannibalization report ("are both these pages really ranking
  now?", "confirm the pairs live", "which of these flags still hold up").
- Checking whether a **specific page** (not just the domain) ranks for a query.
- Deciding a winner: whichever of two pages ranks higher live.

For "where does DOMAIN rank for these keywords" (domain-level, one position per
keyword) use **rank-check** instead. This skill is for **exact-URL** checks and
**page-vs-page** co-ranking.

## Inputs (ask, don't demand)

- **rows** — `(query, url[, url2, …])`. Accept:
  - a **file** (`--file`): a CSV that has a query/keyword column + one or more
    url columns. Our cannibalization exports work as-is — it auto-detects
    `Query` / `Deciding query` / `shared query` and `Primary URL` /
    `Cannibalising URL` / `url` / `page` columns.
  - **inline**: `--query "…" --url <u> [--url <u2>]`.
- **country** — 2-letter, default `us` (`--country in`, `--country gb`, …).

If the user just triggers the skill, ask for the CSV (or a query + URLs) and the
market (default `us` silently). Then run the helper and relay the table — don't
make the user build the command.

## Two helpers (pick by the question)

- **`rank-domain.mjs`** — *simple:* **query + domain + country → live position + the ranking URL.**
  Use for "where does DOMAIN rank for these queries, and which page is Google showing?"
- **`rank-pages.mjs`** — *page-level:* checks **exact URLs** and **page-vs-page co-ranking**
  (the cannibalization confirmation — do BOTH pages rank live?).

Call either by its skill base directory (shown at invocation as "Base directory
for this skill: …"). Needs only `node` + internet + a Serper key.

### rank-domain.mjs — query + domain → live rank + URL
```bash
# a few queries
node "<skill-base-dir>/rank-domain.mjs" --domain qrstuff.com "twitter qr code generator" "coupon qr code" --country us

# a keyword list (auto-detects a query/keyword column, else every line)
node "<skill-base-dir>/rank-domain.mjs" --domain site.com --file keywords.csv --country in

# pipe queries in / machine-readable
printf "%s\n" "kw one" "kw two" | node "<skill-base-dir>/rank-domain.mjs" --domain site.com --json
```
Output per query: `#<position>  <query>  <ranking url>` (or `none` if past top-100),
plus a headline (on page 1 / in top-100 / not ranking).

### rank-pages.mjs — exact URLs + co-ranking
```bash
# verify a whole cannibalization report (auto-detects query + url columns)
node "<skill-base-dir>/rank-pages.mjs" --file ~/Downloads/cannibalization_pairs.csv --country us

# one query, two pages (co-ranking check)
node "<skill-base-dir>/rank-pages.mjs" --query "intranet software" \
  --url https://site.com/guides/intranet-software --url https://site.com/employee-intranet/intranet-software

# machine-readable
node "<skill-base-dir>/rank-pages.mjs" --file pairs.csv --json
```

The helper prints, per row, each page's live position (`#N` or `not ranking`)
and a summary line: how many rows have ≥1 page ranking, and — for pairs — how
many have **both** pages ranking live (confirmed active cannibalization) vs not
(stale / one-sided). Relay that; lead with the confirmed‑vs‑stale headline.

## Serper key

`--key <k>`, or `SERPER_KEY` env, or a `SERPER_KEY=` line in `bulk/.env` /
`.env`. No key → the script exits with a clear message.

## Notes & guardrails

- **Top 100 only** — a page past #100 comes back as `not ranking`. `position` is
  the exact live rank of that URL today.
- **URL matching** ignores scheme / `www` / trailing slash / query string, so
  the exact GSC URL form doesn't matter.
- **Why it matters:** a GSC co-occurrence is only *active* cannibalization if
  both pages rank live. Pages that historically shared a query but now sit past
  #100 are stale — don't redirect on those. This skill is the check that
  separates the two (on our hubengage test, 100% of top historical pairs failed
  it — none co-ranked live).
- **Freshness:** live SERPs drift day to day; a re-check can move a page a spot
  or two. Say so when comparing against an older export.
- **Cost/scale:** one Serper call per **unique** query (cached across rows),
  5 in parallel. A report with many repeated queries is cheap; thousands of
  distinct queries is a real Serper spend — mention it before a huge run.
