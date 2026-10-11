# Family Specials Finder

A cost-of-living app for our family: it collects specials (and regular prices for the things we
buy) from the stores we use, keeps a price history, and shows it on a page you can install on
your phone like an app.

The product vision and the rules every stage follows are in [CLAUDE.md](CLAUDE.md); the current
stage's spec is [docs/next-stage-spec.md](docs/next-stage-spec.md). Store research, the build plan,
the Phase 1 report and the decisions log are kept as local notes (not published).

## The family page

**https://marqueztandog7-del.github.io/family-specials/**

- **Install it on a phone.**
  - iPhone: open the link in Safari, tap Share, then "Add to Home Screen".
  - Android: open it in Chrome, tap the menu, then "Install app" (or "Add to Home screen").
- **What's on it.** It shows **only products related to what we buy** (our tracked categories now,
  watch-item matches later). It is public to anyone with the link, so it never carries receipt
  data, and search engines are asked not to list it.
- **How it's built.** It's a static web app in `site/`:
  - `index.html`, `styles.css` and `js/app.js` are the screens.
  - **`js/data.js` is the only file that reads data** (`site/data/products.json` and `status.json`).
    A future App Store / Google Play build (Capacitor) can wrap `site/` as it is and only needs
    to change `data.js` if the data moves.
  - `sw.js` keeps the app and the last prices available offline. `manifest.webmanifest` and
    `icons/` make it installable (`scripts/make_icons.py` redraws the icons).

## Quick start (on the Mac)

```bash
cd ~/Claude/family-specials
./scripts/mac-update.sh                # pull, run the Mac's stores, rebuild the page data, push
uv run specials serve                  # the family page locally at http://127.0.0.1:8000
uv run specials search "milk"          # search from the command line (full local database)
uv run specials status                 # what was collected, and when
```

`uv` and `gh` live in `~/.local/bin`. If they aren't found, run `export PATH="$HOME/.local/bin:$PATH"`.

## How the data updates

| Where | What | When |
|---|---|---|
| GitHub Actions (`.github/workflows/collect.yml`) | Stores with `run_on: github` in `config/stores.yaml` | Wednesday morning (Woolworths, Coles, ALDI), Thursday (Chemist Warehouse), Saturday (ALDI), Monday (Costco), plus a daily catch-up. Times are Sydney time. |
| Your Mac (`./scripts/mac-update.sh`) | Stores with `run_on: mac` (ones that block GitHub's servers) | Whenever you run it, or on a schedule if you install the launchd file in `scheduling/` |
| By hand | Tong Li, from the flyer | `uv run specials import-tongli <file.csv>` |

Every update does the same thing: it **loads the price history** from `history/`, **collects** each
store that's due this specials cycle, **appends** the new prices to `history/`, **rebuilds**
`site/data/`, commits, and publishes the page. A store that's blocked or breaks makes the run
fail, and **GitHub emails you** (check that github.com/settings/notifications has Actions →
email for failed workflows turned on).

### Price history in the repo (`history/`)

Small CSV files that only ever grow:

- `history/observations/<store>-<year>.csv`: every price we've seen, one row per product per run.
- `history/products/<store>.csv`: product names, sizes and barcodes.
- `history/runs/<store>.csv`: every collection run (where, when, status).

The page and history are limited to products related to what we buy. Member prices and raw store data stay in
the local database (`data/specials.db`, never committed), which keeps everything the Mac collects.

## Collecting by hand

```bash
uv run specials update --where mac               # what mac-update.sh runs, without the git steps
uv run specials collect                          # every store, specials + tracked categories (local DB only)
uv run specials collect --due                    # only stores not yet collected this cycle
uv run specials collect --chain aldi             # one store
uv run specials collect --chain coles --kind specials --max-pages 1   # quick test
```

Each store runs on its own: if one is blocked or breaks, the others still run. Every run is
logged (`collection_runs`), together with exactly which pages it read (`run_coverage`).

### What each store gives us

| Store | Source | Our store | Specials | Regular prices | Barcodes |
|---|---|---|---|---|---|
| Woolworths (from the Mac: it blocks GitHub) | JSON API the site uses | Woolworths' default store for anonymous visitors, which changes (#7008 on 5 Oct, #2631 on 12 Oct); pinning Kellyville North needs a login | Half Price, Lower Shelf Price*, Seasonal*, Buy More Save More, Online Only | Tracked categories | In listings (almost all) |
| Coles (paused: challenges scripts after a page or two) | The site's page data | Kellyville #0883 (set with a cookie, no login) | Everything on /on-special | Tracked categories | Product pages only (not fetched yet) |
| ALDI (from GitHub) | Public JSON API | North Kellyville G449 | Special Buys (each Wed/Sat drop), Super Savers, Lower Prices* | Tracked categories | None (mostly own brands) |
| Costco (from GitHub) | JSON API the site uses | Online, national | Hot Buys with a member saving and real end dates | Keyword searches | Product detail only (not fetched yet) |
| Chemist Warehouse (from GitHub) | Algolia search index (approved, limited to tracked categories) | Online, national | Clearance only (see below) | Tracked categories | Some, from supplier image links |
| Tong Li | None online | Castle Hill | Typed in from the flyer (CSV) | n/a | n/a |

\* Recorded as regular prices with the store's label, not as specials: the store doesn't mark
them as on special and shows no was price.

**Honest limits:**
- **Woolworths** prices are from the store it picks for anonymous visitors, which changes from week to week. Weekly specials are set state-wide; everyday prices can differ slightly between stores.
- **Coles** is paused (`enabled: false` in `config/stores.yaml`): it challenged our script after about 20 requests in an hour on 5 Oct.
- **Costco** prices are online prices, often including delivery. They are not warehouse shelf prices, and are always labelled.
- **Chemist Warehouse** shows "$X Off RRP" on nearly everything; that's everyday pricing, never a
  special. Its "in catalogue" flag turned out to be on 86% of products, so it isn't used.
- **Valid dates:** Woolworths and Coles don't give end dates. Their weekly specials are marked as ending Tuesday,
  labelled "(weekly cycle)". ALDI Special Buys have a start date only (while stocks last).
  Costco gives real end dates.

### Tracked categories (regular prices)

`config/tracked_categories.yaml` lists the categories whose regular prices are read each cycle,
so price history builds up for things we actually buy. It's seeded with a 10-item test basket
until the family shopping list replaces it. Find category ids with:

```bash
uv run specials categories --chain woolworths --find milk
uv run specials categories --chain aldi --refresh    # re-read the store's category tree
```

### Tong Li (manual)

Copy `config/tongli_template.csv`, type in the flyer's specials, then:

```bash
uv run specials import-tongli ~/Downloads/tongli-week-41.csv
```

## Collection rules (built into the code)

- At most one full collection per store per specials cycle (`--due`), with 3–8 second gaps
  between requests and a request budget per run.
- robots.txt is checked before every request, including `*` wildcards. This caught a Coles rule
  that blocks the lighter data route, so Coles specials are read from the normal web pages.
- No logins, no CAPTCHA solving, no proxies. Any refusal, challenge page or unexpected response
  stops that store's run immediately, and the scheduler then waits at least a day before trying it again.
- Requests identify themselves as `FamilySpecialsFinder/0.1 (household use)`.

## Scheduling on the Mac (optional)

`scheduling/au.family-specials.collect.plist` runs `scripts/mac-update.sh` at 7:30 and 18:30
each day (launchd catches up after sleep). Only needed if some stores have to run from the Mac.
It isn't installed. To install:

```bash
cp scheduling/au.family-specials.collect.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/au.family-specials.collect.plist
```

To stop it: `launchctl unload ~/Library/LaunchAgents/au.family-specials.collect.plist`.
Logs go to `data/logs/collect.log`.

## The database

One SQLite file: `data/specials.db`. The main tables:

| Table | Holds |
|---|---|
| `retailer_products` | One row per store product, keyed on the store's own product id; raw name, brand, size text |
| `retailer_product_gtins` | Barcodes, several per product allowed, normalised to 14 digits |
| `price_observations` | Append-only price history: price, was, RRP, special type, multibuy, unit price, valid dates, price basis (in store / online / online incl. delivery), per each or per kg |
| `product_attributes` | What the parser read: size, unit, pack count, own brand |
| `raw_snapshots` | The store's raw product data, saved when it changes, for re-parsing later |
| `collection_runs`, `run_coverage` | Every run and exactly what it read |
| `store_categories` | Each store's category tree |

## Secrets

`.env` (never committed; see `.env.example`) holds Chemist Warehouse's public search key, which
its website uses. On GitHub it's the repository secret `CW_ALGOLIA_SEARCH_KEY`.

## Development

```bash
uv run pytest            # parser, robots.txt, store normalisers, history round trip, unit prices
```

Code is in `src/family_specials/`: one adapter per store in `collectors/` behind a shared
interface (`fetch_specials()` returns raw items, `normalise(raw_item)` returns a normalised item).
