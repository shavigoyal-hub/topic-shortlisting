# AKR Enricher (`akr_enrich.mjs`)

Standalone. Three steps, one run — **no 6-min limit, no batching, no clicking**.

    node akr_enrich.mjs --akr akr.csv --config client.json --out enriched.csv

## 1. Input AKR (`--akr`)
Any CSV with these headers (case-insensitive, extra columns ignored):
`Primary Keyword`, `Page Type`, `Topic`, `Secondary Keywords`, `Total Search Volume` (or **`SV`** / `Vol`), `Relevance`.

## 2. Set config (`--config`)
Either a **JSON** file (see `client.example.json`) or the **Config-tab key/value CSV** exported
from the Sheets tool. Fields: `name`, `category`, `offering`, `website`, `services[]`, `products[]`,
`industries[]` (ICP — leave empty = horizontal/serves anyone), `competitors[]`, `locations[]`,
`target_professions[]`, optional `does[]`/`doesNot[]`, and `rule_*` toggles (`rule_format` on by default).
Set `category` to a **distinctive** phrase (e.g. "automotive glass", "commercial signage") — not generic
words like "training/services", which carry no signal.

## 3. Output (`--out`)
Enriched CSV = the AKR columns + `Status` (1 keep / 0 reject / blank = review),
`Confidence` (high/medium/low), `Reason`, `Reason Explained` (incl. ICP note), `Audience`,
`Profession`, `Type`, `Modifier`, `BOFU`, `Matched Services`, `ICP (keyword)`, `ICP fit`.

## Flags
- `--site` — also fetch the client website and merge its real offering into the config.
- `--serp false` — fast keyword-only mode (skips Google; weaker on word-sense traps).
- `--model`, `--concurrency N`, `--batch N` — overrides (defaults: gpt-4o w/ SERP, 6, 30).

Needs `bulk/.env` with `OPENAI_API_KEY` and `SERPER_KEY`. SERP results cache to `serp_cache.json`, so re-runs are cheap.
