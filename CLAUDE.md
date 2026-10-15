# Family Specials Finder

Cost-of-living app for our household in North Kellyville NSW 2155 first, possibly the public later. Stores in priority order: Woolworths, Coles, Chemist Warehouse, Costco, ALDI.

- Local notes, kept out of the public repo (listed in .gitignore): RECON.md (what each store exposes, store IDs, cycles, terms of use), PLAN.md (build plan and status; check it before starting work), PHASE1_REPORT.md and docs/decisions.md (decisions log; keep it up to date).
- README.md: how to run it, and each store's coverage and limits.

## Product vision (the north star; don't build ahead of the current stage)

A cost-of-living app, built for our family first and possibly the public later. Users add the things they buy (by searching, scanning a receipt or importing purchase history) to a watchlist. The app matches each watched item to the same product and to close alternatives at every store we use, and tells them when any of those go on special.

Stores, in priority order: Woolworths, Coles, Chemist Warehouse, Costco, ALDI. (Tong Li was dropped on 16 Oct 2026.)

Watch levels: 1 exact (one product at one store), 2 same product at any store (barcode, else brand + normalised name + size, with a confidence score), 3 similar (a rule such as "beef mince, any brand, 500 g to 2 kg", including store-brand equivalents).

Every stage must keep these possible. When a design choice would block one of them, stop and raise it. The product brief is docs/weekly-routine.md: every feature should make that routine faster or cheaper. The app plan is docs/app-plan.md (not started until the Part 5 accuracy report is approved). The previous stage is docs/next-stage-spec.md. Decisions so far: docs/decisions.md.

## Pricing rules (apply everywhere)

- Compare stores on shelf prices and specials only. Leave out member discounts (e.g. Everyday Extra), staff discounts, rewards dollars, delivery fees and bag fees.
- Multibuys ("2 for $8") are specials: show the effective price per item and per unit.
- Not specials: Chemist Warehouse "$X Off RRP" and Woolworths "Everyday Low Price". Store them as normal prices.
- Sponsored or ad items never count as matches and never rank higher.
- Compare on a normalised unit price: per kg, per L, per 100 g or per each, or a count (per sheet, bag, can, tea bag) where a rule says so. Weighed items (e.g. chicken thigh trays) compare per kg.

## Data rules that serve the vision

- **Product identity:** key products on the retailer's own product ID (Woolworths stockcode, Coles id, CW SKU, Costco code, ALDI SKU), never on the name.
  - Capture barcodes (GTINs) wherever a store exposes them. A product can have several barcodes, so store them separately, normalised to 14 digits with the check digit validated.
  - Never use in-store or variable-weight barcodes (deli, meat) for cross-store matching.
  - Where barcodes come from: Woolworths in listings; Coles and Costco only on product detail (fetch lazily for watched or matched products, cache forever); Chemist Warehouse partly, from supplier image links (source `supplier_content`); ALDI none.
- **Names and sizes:** always keep the raw product name and the store's own size and unit-price text.
  - Parse brand, size, unit, pack count and (for medicines) active ingredient and strength separately, tagged with a parser version.
  - Keep the raw store payload (a new copy only when it changes), so items can be re-parsed later without re-fetching.
- **Weighted items:** record whether a price is per each or per kg.
- **Receipt names:** a product can have several names (e.g. receipt abbreviations), so names are never unique.
- **Price history:** append-only and never overwritten.
  - Each observation records the specific store the price applies to, the price basis (in-store, online, or online incl. delivery), shelf, was, member and multibuy prices, valid dates, and the run that saw it.
  - Record regular prices too, not just specials.
  - Log which store pages each run actually covered, so "not seen" is never mistaken for "not on special". History can't be backfilled.
- **Never make up data.** No guessed prices, sizes, dates or matches.
  - If something can't be read reliably, mark it "not comparable" or leave it unknown.
  - Costco online prices include delivery, so never present them as warehouse prices.
  - Chemist Warehouse savings are against RRP, not a was price. Its `in_catalogue` flag is unreliable (on 86% of products), so it is never used to mark specials.
  - Woolworths and Coles give no end dates; weekly specials get the Wednesday-to-Tuesday cycle end, marked `weekly_cycle_assumed`, never presented as the store's date.
- **What counts as a special:** a temporary price drop or multibuy.
  - Everyday pricing is stored but never flagged: Woolworths "Everyday Low Price" and Chemist Warehouse "$X Off RRP".
  - Long-term price cuts with no was price (Woolworths "Lower shelf price", ALDI "Lower Prices") are stored as regular prices with the store's label.
  - Sponsored ads and marketplace sellers (Woolworths Everyday Market) are deduped or excluded so they don't skew results.
- **Multi-household ready:** watchlists and preferences belong to a household (one row for now), with room for users later.

## Private data and the public repo

- The GitHub repo is public. Never commit: the database, raw collector responses, anything in `data/private/` (receipt files), `.env` or secrets. Test fixtures are a small, deliberate set of saved store responses.
- `data/private/` holds our receipt-derived files. The published page and repo may show watchlist item names and rules only: no receipt lines, dates, prices we paid or spend.
- Online receipts don't mark specials (in-store receipts mark them with ^), so a price from an online order is never treated as the normal price.
- Third-party keys found in store websites (e.g. Chemist Warehouse's Algolia search key) live in `.env` / GitHub Actions secrets, not in the repo.

## Collection rules

- Household use only. The data source sits behind each store's adapter so it can be swapped. Licensed data is required before any public release, because most of these stores' website terms prohibit automated access.
- Be polite and low volume: only fetch what's needed, at most once or twice per specials cycle per store, with delays between requests.
- Respect robots.txt, including `*` wildcards (the client checks every request). Store search pages are disallowed, so use category pages. Coles' `/*/*/*/on-special*` rule also blocks the `/_next/data/.../on-special.json` route, so Coles specials come from the normal `/on-special?page=N` pages.
- No CAPTCHA solving, no proxy rotation, no logins, and no bypassing bot protection. Stop at the first sign of blocking.
- Ask before calling a store's third-party search service with the site's own browser key. Chemist Warehouse's Algolia is approved (5 Oct 2026), limited to the categories our searched or watched items fall in.
- Image-only sources (catalogue flipbooks) aren't collected. There is no flyer-upload path.
- One store breaking must never stop the others.
- Store timestamps in UTC; specials cycles follow Sydney time (daylight saving).

## Stack

- Python 3.12 (via uv), httpx, pydantic, SQLite with FTS5, rapidfuzz, PyYAML.
- The family page is a static web app in `site/` on GitHub Pages. `site/js/data.js` is the only file that reads data, so a Capacitor (App Store / Google Play) build can wrap `site/` later. Phone-first; greys, black and white, no colour accents; nothing desktop-only.
- **Updates:**
  - GitHub Actions (`.github/workflows/collect.yml`) runs the stores with `run_on: github`; `scripts/mac-update.sh` runs the ones with `run_on: mac`.
  - Both use `specials update`: load `history/` → collect what's due → append to `history/` → rebuild `site/data/`.
  - Per-store history files mean GitHub and the Mac never edit the same file.
- **Mac schedule** (installed 16 Oct 2026): launchd runs `scripts/mac-update.sh` at 7:30am and 6:30pm. Collection happens only when due; otherwise it's a check that commits nothing. A weekly backup goes to iCloud Drive/family-specials-backups (`specials backup`: SQLite backup API, integrity check, xz, newest 8 kept, notification on failure). `.env`, tokens and the live database never go to iCloud.
- **Coles:** paused for good. Its one trial (16 Oct 2026) was challenged on half-price page 6 (`pause_for_good_on_block`); never add retries or workarounds. The configured read is half-price pages plus watchlist categories only. A possible fallback (not built) is reading Coles' weekly specials emails from the inbox.
- **Watchlist:**
  - `config/watchlist.yaml` (names and rules, committed) drives matching and the store categories that are read. `tracked_categories.yaml` only holds extras.
  - `watchlist/decisions.csv` holds confirm/reject decisions; a rejection is permanent.
  - Matching (`matching.py`) runs after every update.
  - The accuracy report is private (`data/reports/`), because it uses receipt names.
- **Published data:** `history/` and `site/data/` hold only products related to what we buy (seen in a tracked category, or matched to a watch item). No member prices and no raw store data.
