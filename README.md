# Family Specials Finder

Collects current specials (and regular prices for the things we buy) from the stores our
household in North Kellyville (2155) uses, keeps them in one database with full price history,
and makes them searchable.

Phase 1: collection + search. The product vision and the data rules every phase follows are in
[CLAUDE.md](CLAUDE.md), and the current stage's spec in [docs/next-stage-spec.md](docs/next-stage-spec.md).
Store research, the build plan, the Phase 1 report and the decisions log are kept as local notes
(not published).

## Quick start

```bash
cd ~/Claude/family-specials
uv run specials status                 # what was collected, and when
uv run specials search "milk"          # specials matching "milk"
uv run specials search "rice" --all    # include regular prices too
uv run specials serve                  # search page at http://127.0.0.1:8000
```

`uv` lives in `~/.local/bin`. If `uv` isn't found, run `export PATH="$HOME/.local/bin:$PATH"` first.

## Collecting

```bash
uv run specials collect                          # every store, specials + tracked categories
uv run specials collect --due                    # only stores not yet collected this cycle
uv run specials collect --chain aldi             # one store
uv run specials collect --chain coles --kind specials --max-pages 1   # quick test
```

Each store runs on its own: if one is blocked or breaks, the others still run. Every run is
logged (`collection_runs`), together with exactly which pages it read (`run_coverage`).

### What each store gives us

| Store | Source | Our store | Specials | Regular prices | Barcodes |
|---|---|---|---|---|---|
| Woolworths | JSON API the site uses | Default online store #7008 (pinning Kellyville North needs a login) | Half Price, Lower Shelf Price*, Seasonal*, Buy More Save More, Online Only | Tracked categories | In listings (almost all) |
| Coles | The site's page data | Kellyville #0883 (set with a cookie, no login) | Everything on /on-special | Tracked categories | Product pages only (not fetched yet) |
| ALDI | Public JSON API | North Kellyville G449 | Special Buys (each Wed/Sat drop), Super Savers, Lower Prices* | Tracked categories | None (mostly own brands) |
| Costco | JSON API the site uses | Online, national | Hot Buys with a member saving and real end dates | Keyword searches | Product detail only (not fetched yet) |
| Chemist Warehouse | Algolia search index (approved, limited to tracked categories) | Online, national | Clearance only (see below) | Tracked categories | Some, from supplier image links |
| Tong Li | None online | Castle Hill | Typed in from the flyer (CSV) | n/a | n/a |

\* Recorded as regular prices with the store's label, not as specials: the store doesn't mark
them as on special and shows no was price.

**Honest limits:**
- **Woolworths** prices are from its default online store; weekly specials are set state-wide.
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

## Scheduling

`scheduling/au.family-specials.collect.plist` runs `specials collect --due` at 7:30 and 18:30
each day (launchd catches up after sleep). It isn't installed yet. To install:

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

## Development

```bash
uv run pytest            # parser, robots.txt matcher and per-store normalisers (real saved items)
```

Code is in `src/family_specials/`: one adapter per store in `collectors/` behind a shared
interface (`fetch_specials()` returns raw items, `normalise(raw_item)` returns a normalised item).
