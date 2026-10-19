# Family Specials Finder

Cost-of-living app for our household in North Kellyville NSW 2155 first, possibly the public later. Stores in priority order: Woolworths, Coles, Chemist Warehouse, Costco, ALDI.

- Local notes, kept out of the public repo (listed in .gitignore): RECON.md (what each store exposes, store IDs, cycles, terms of use), PLAN.md (build plan and status; check it before starting work), PHASE1_REPORT.md and docs/decisions.md (decisions log; keep it up to date).
- README.md: how to run it, and each store's coverage and limits.

## Product vision (the north star; don't build ahead of the current stage)

A cost-of-living app, built for our family first and possibly the public later. Users add the things they buy (by searching, scanning a receipt or importing purchase history) to a watchlist. The app matches each watched item to the same product and to close alternatives at every store we use, and tells them when any of those go on special.

Stores, in priority order: Woolworths, Coles, Chemist Warehouse, Costco, ALDI. (Tong Li was dropped on 16 Oct 2026.)

Watch levels: 1 exact (one product at one store), 2 same product at any store (barcode, else brand + normalised name + size, with a confidence score), 3 similar (a rule such as "beef mince, any brand, 500 g to 2 kg", including store-brand equivalents).

Every stage must keep these possible. When a design choice would block one of them, stop and raise it. The product brief is docs/weekly-routine.md: every feature should make that routine faster or cheaper. The app plan is docs/app-plan.md (in progress since 16 Oct 2026: five tabs This Week · Watchlist · Home · List · Savings, opening on Home). The current spec is docs/accounts-and-families-spec.md (designs, accounts, families and invites, per-family notifications; the backend needs the user's OK before building). The previous stage is docs/next-stage-spec.md. Decisions so far: docs/decisions.md.

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

- **The rule (16 Oct 2026):** never push anything with names, emails, receipts, what our family buys or spends, passwords, keys, invite codes or the database. Keys and secrets go in GitHub secrets only. **Before every push, check the file list (and the diff) against this rule and tell the user if anything looks personal.**
- `docs/design` (the Stitch designs and brief) is private (`.gitignore`) and used from the Mac only. The app rebuilds the look (layout, colours, fonts, components); never copy the designs' sample text, names, prices or savings into code.

- The GitHub repo is public. Never commit: the database, raw collector responses, anything in `data/private/` (receipt files), `.env` or secrets. Test fixtures are a small, deliberate set of saved store responses.
- `data/private/` holds our receipt-derived files **and the watchlist** (`watchlist.yaml`, `watch-decisions.csv`, `notify-sent.csv`, `family-watchlist.json`). Since 19 Oct 2026 the watchlist and its Core Essentials / Regulars groups are private: they're what our family buys, so they live only in `data/private/` and the family's own Supabase row (`family_watchlist`), never in the repo or a public file. The public data file (`site/data/specials.json`) and `history/` hold store specials only (every store's, never a selection made by the watchlist); full ranges go to Supabase (`store_products`).
- Online receipts don't mark specials (in-store receipts mark them with ^), so a price from an online order is never treated as the normal price.
- Third-party keys found in store websites (e.g. Chemist Warehouse's Algolia search key) live in `.env` / GitHub Actions secrets, not in the repo.

## Collection rules

- Household use only. The data source sits behind each store's adapter so it can be swapped. Licensed data is required before any public release, because most of these stores' website terms prohibit automated access.
- Be polite and low volume: only fetch what's needed, at most once or twice per specials cycle per store, with delays between requests.
- Respect robots.txt, including `*` wildcards (the client checks every request). Store search pages are disallowed, so use category pages. Coles' `/*/*/*/on-special*` rule also blocks the `/_next/data/.../on-special.json` route, so Coles specials come from the normal `/on-special?page=N` pages.
- No CAPTCHA solving, no proxy rotation, no logins, and no bypassing bot protection. Stop at the first sign of blocking.
- Ask before calling a store's third-party search service with the site's own browser key. Chemist Warehouse's Algolia is approved (5 Oct 2026) and, since 19 Oct 2026, for its full range once a week (marketplace sellers left out).
- Catalogues (approved 19 Oct 2026): Costco's In-Warehouse Savings booklet is read from its viewer's text pages; Chemist Warehouse's catalogue from page images with AI (Anthropic API, key in `.env`). Anything unclear or not matched with confidence goes on the review list (`specials catalogue review`), never into prices. A Chemist Warehouse catalogue price is a special only when it's below the price we recorded there before the catalogue started, or the catalogue says the saving is off its everyday price.
- A store that refuses or challenges us is paused (`pause_on_block`) until the user runs `specials resume <store>`; tell the user. Never retry around it.
- One store breaking must never stop the others.
- Store timestamps in UTC; specials cycles follow Sydney time (daylight saving).

## Stack

- Python 3.12 (via uv), httpx, pydantic, SQLite with FTS5, rapidfuzz, PyYAML.
- The family page is a static web app in `site/` on GitHub Pages. `site/js/data.js` is the only file that reads or saves data, and `site/js/push.js` the only one that talks to the push service, so a Capacitor (App Store / Google Play) build can wrap `site/` later. Phone-first; nothing desktop-only.
- **Design:** the Stitch designs in `docs/design` (Pantry Standard: `pantry_standard/DESIGN.md`, one mock-up per screen, and the design brief) are the visual reference for every screen: layout, spacing, type (Plus Jakarta Sans, JetBrains Mono for prices), components and colours (terracotta actions, sage savings, store colour tags). They replace the earlier greys-only rule (16 Oct 2026). Sample numbers in the mock-ups are always replaced by live data, and where a mock-up conflicts with an agreed rule (Coles paused, data rules), the agreed rule wins and is raised.
- **Updates (one weekly refresh, 19 Oct 2026):** every store is `run_on: mac` and refreshes once a week from Wednesday morning: specials, then full range (category pages only), then catalogue. `specials update` then re-runs matching, writes `site/data/specials.json`, sends ranges and the family watchlist to Supabase, and sends notifications. `scripts/mac-update.sh` commits only `history/` and `site/data/`. GitHub only runs `keepalive.yml` (daily Supabase check-in) and `pages.yml` (publish on push).
- **Mac schedule** (installed 16 Oct 2026): launchd runs `scripts/mac-update.sh` at 7:30am and 6:30pm. Collection happens only when due; otherwise it's a check that commits nothing. A weekly backup goes to iCloud Drive/family-specials-backups (`specials backup`: SQLite backup API, integrity check, xz, newest 8 kept, notification on failure). `.env`, tokens and the live database never go to iCloud.
- **Coles:** paused for good. Its one trial (16 Oct 2026) was challenged on half-price page 6 (`pause_for_good_on_block`); never add retries or workarounds. The configured read is half-price pages plus watchlist categories only. A possible fallback (not built) is reading Coles' weekly specials emails from the inbox.
- **Watchlist:**
  - `data/private/watchlist.yaml` (private) drives matching. Products added from search are family watch items in Supabase (no group chooser yet: added with no group).
  - `data/private/watch-decisions.csv` holds confirm/reject decisions; a rejection is permanent.
  - Matching (`matching.py`) runs after every update, across every store's full range.
  - The accuracy report is private (`data/reports/`), because it uses receipt names.
- **Accounts and families:** Supabase (free plan, Sydney), OK'd 16 Oct 2026.
  - `site/js/account.js` is the only file that talks to it. The app finds it through `site/app-config.json` (address + public key), which is written at publish time from GitHub secrets and never committed.
  - `supabase/migrations/NNN_*.sql` are applied by `specials backend migrate`. Every table has row-level security (a family only sees its own rows), and writes go through security-definer functions.
  - Secrets (access token, secret key) are only in `.env` and GitHub secrets.
  - Actions logs are public: never print family data in them.
  - Spec: `docs/family-accounts-spec.md`. Built 17 Oct 2026, end to end (migration 004):
    - **Invites:** the link carries a random token only. The code is sent separately and stored as a bcrypt hash, shown once.
    - **Joining:** `join_family(token, code, nickname)` checks everything, with 5 wrong codes per 15 minutes per person.
    - **Owner and member controls** are in Profile.
    - **Shared data:** `family_list_items`, `family_savings` and `family_watch_items` merge field by field, latest wins, never deleted, synced live by `site/js/sync.js`.
  - **Testing:** I can't create accounts on Supabase, so test the database with `specials backend test` (a rolled-back transaction with pretend people), and the user tests sign-in and joining on real phones.
- **Phone notifications:** free Web Push, sent from the Mac by `specials update` after a refresh (it needs the private watchlist): at most one notification per watch item per specials week (Wednesday to Tuesday), plus a weekly digest. `data/private/notify-sent.csv` records what was sent. Phones opt in from Settings; their subscriptions live in `data/push/devices.json` and the `PUSH_SUBSCRIPTIONS` secret, never in git. The signing key is in `.env` and the `VAPID_PRIVATE_KEY` secret. `site/js/push.js` is the only file that talks to the push service.
- **Home numbers:** every number on Home comes from real data or says there isn't enough yet. "New this week" needs a read of the product in the week before. "Usually $X" needs that normal price recorded in 2 different weeks. Recommendations come only from the watchlist (tiers come from receipts: core = bought in 4+ shops). Never publish purchase dates or "due" timing derived from receipts.
- **Published data:** `history/` and `site/data/` hold store specials only (all stores). No member prices, no raw store data, nothing chosen by the watchlist.
- **Password reset:** Supabase's recovery email with our own template (needs the custom sender: a Gmail account made for the app, set with `specials backend email`). The link is `<app>#/reset?token_hash=…&type=recovery`, used with `verifyOtp` only when the new password is submitted (works in mail apps' own browsers). Supabase's standard link (`#access_token=…&type=recovery`) is handled too.
- **Testing the app without Supabase:** `tests/fake_backend.py` (localhost only, pretend accounts).
