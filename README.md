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
- **The screens.** Five tabs along the bottom: **This Week · Watchlist · Home · List · Savings**. The app
  opens on **Home**, in the middle (bolder label, larger filled icon).
  - **Home:** potential savings this week, new on special this week, recently added to the list,
    recommended to add, and Family (a placeholder until family accounts). The **bell** in Home's top-right
    opens **Alerts**, with a count of unread ones.
  - **This Week:** every watched item on special at the stores you compare, core items first, with its
    signals and "Add to list".
  - **Watchlist:** every watched item. Tap one for its price at each store, a price history chart and its
    signals. Search products here, then "Add to list" or "Suggest to watch".
  - **List:** the shopping list, saved on this phone (ticking off, totals and where to shop come next).
  - **Savings:** coming next.
  - **Alerts and Settings** open over the tabs (no tab bar), as in the designs. Item detail keeps the tab bar.
  - **Settings** (the gear, top-right of every screen): notifications, which stores to compare and when
    each last updated, how our prices work, and clearing this phone's list and savings. It grows into
    Account and Settings when family accounts arrive.
- **Every number comes from real data, or the app says there isn't enough yet.** Savings use each store's
  own was price (or multibuy). "New this week" needs a read of the product the week before. "Usually $X"
  needs that normal price in 2 different weeks. "Lowest in N weeks" needs 4 weeks of history.
  Recommendations only come from the watchlist (built from our receipts).
- **What's on it.** It shows **only products related to what we buy** (the watchlist's store
  categories and matches). It is public to anyone with the link, so it never carries receipt data
  (item names, rules and tiers only), and search engines are asked not to list it.
- **How it looks.** Built to the Pantry Standard Stitch designs in `docs/design`: warm limestone surfaces,
  terracotta buttons, sage savings badges, store colour tags, Plus Jakarta Sans for text and JetBrains Mono for every
  price. The fonts and icons come from Google Fonts and are kept on the phone after the first visit.
- **How it's built.** It's a static web app in `site/`:
  - `index.html`, `styles.css` and `js/app.js` are the screens.
  - **`js/data.js` is the only file that reads or saves data:** `site/data/watchlist.json` (the watchlist with
    offers, history and signals), `status.json`, `products.json` (only loaded to search), and the list,
    settings and alerts kept on this phone. **`js/push.js`** is the only file that talks to the phone's
    push service. A future App Store / Google Play build (Capacitor) can wrap `site/` as it is and only
    swap those two files.
  - `sw.js` keeps the app and the last prices available offline and shows notifications.
    `manifest.webmanifest` and `icons/` make it installable (`scripts/make_icons.py` redraws the icons).

## Phone notifications

**Free.** Standard Web Push: phones get notifications through Apple's and Google's own push services
(free), sent by a GitHub Actions workflow (free on a public repo). No other service, account or app.

- **What arrives:** a notification when a watched item goes on special, **at most one per item per
  specials week** (Wednesday to Tuesday). Four or more at once come as one notification. Plus a **weekly
  digest** once Woolworths has the week's prices (by Thursday 6pm at the latest). A special that carries
  on into the next week isn't announced again.
- **Each phone opts in for itself:** Settings → Allow notifications. iPhone needs iOS 16.4 or later and
  the app opened from its Home Screen icon. Then tap "Copy code" and add the phone on the Mac:

```bash
uv run specials notify add            # reads the copied code from the clipboard (or paste it after "add")
uv run specials notify test           # a test notification to every phone
uv run specials notify devices        # phones that get notifications
uv run specials notify remove 2       # stop sending to phone 2
uv run specials notify run --dry-run  # what would be sent right now
```

- **How it runs:** `.github/workflows/notify.yml` runs after every "Collect prices" or "Publish page" run,
  and by hand from the Actions tab ("Notify phones" → Run workflow → `run` or `test`). It records what it
  sent in `notifications/sent.csv` (item keys and dates only), so nothing repeats.
- **Where things are kept:** the private key in `.env` and the `VAPID_PRIVATE_KEY` secret; the phone list in
  `data/push/devices.json` (never in git) and the `PUSH_SUBSCRIPTIONS` secret; the public key in
  `site/push.json`. `specials notify keys` made them on 16 Oct 2026. Making new keys means every phone has
  to turn notifications on again.
- **Limits:** notifications cover every store we have prices for. The store switches only change what
  that phone's app shows. A phone that turns the switch off cancels its subscription. The workflow then
  reports it, and `notify remove` takes it off the list.

## Quick start (on the Mac)

```bash
cd ~/Claude/family-specials
./scripts/mac-update.sh                # pull, run the Mac's stores, rebuild the page data, push
uv run specials serve                  # the family page locally at http://127.0.0.1:8000
uv run specials search "milk"          # search from the command line (full local database)
uv run specials status                 # what was collected, and when
```

`uv` and `gh` live in `~/.local/bin`. If they aren't found, run `export PATH="$HOME/.local/bin:$PATH"`.

## The watchlist

`config/watchlist.yaml` holds the family watchlist: names and rules only, no receipt data. It was seeded on
16 Oct 2026 with the 36 Core and Regular items from `data/private/family_regular_items.csv`, each at its
suggested level. Each item has:

- **a level:** `exact` (one product at one store), `same_product` (the same product at any store: same
  barcode, otherwise same brand + size + a close name), or `similar` (a rule such as "beef mince, any
  brand, 500 g to 2 kg", store brands included);
- **a tier** (core items show first) and the unit to **compare per** (kg, L, item, can, bag, sheet,
  wipe, tea bag), plus an optional **target** unit price;
- **the store categories** to read regular prices from. These replace the old 10-item test basket in
  `tracked_categories.yaml`.

```bash
uv run specials watch                                  # the watchlist
uv run specials watch add woolworths 123456            # add a product: same product, any store
uv run specials watch add woolworths 123456 --similar  # ...and also watch similar items
uv run specials match                                  # re-run matching + write the accuracy report
uv run specials review                                 # matches waiting for you
uv run specials review reject <item> <store> <product id>   # never comes back
uv run specials review confirm <item> <store> <product id>
```

Matching runs after every data update, on GitHub and on the Mac. Your decisions are saved in
`watchlist/decisions.csv`; commit it, along with `config/watchlist.yaml`, so GitHub uses them too.
The accuracy report goes to `data/reports/` (private: it uses receipt names).

## How the data updates

| Where | What | When |
|---|---|---|
| GitHub Actions (`.github/workflows/collect.yml`) | Stores with `run_on: github` in `config/stores.yaml` | Wednesday morning (Woolworths, Coles, ALDI), Thursday (Chemist Warehouse), Saturday (ALDI), Monday (Costco), plus a daily catch-up. Times are Sydney time. |
| Your Mac (`./scripts/mac-update.sh`, on a schedule) | Stores with `run_on: mac` (ones that block GitHub's servers) | Checks at 7:30am and 6:30pm; collects only when due (Woolworths from Wednesday) |

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
| Coles (**paused for good**: the one trial on 16 Oct was challenged on half-price page 6) | Data embedded in its normal web pages | Kellyville #0883 (set with a cookie, no login) | Half-price pages only | Tracked categories | Product pages only (not fetched yet) |
| ALDI (from GitHub) | Public JSON API | North Kellyville G449 | Special Buys (each Wed/Sat drop), Super Savers, Lower Prices* | Tracked categories | None (mostly own brands) |
| Costco (from GitHub) | JSON API the site uses | Online, national | Hot Buys with a member saving and real end dates | Keyword searches | Product detail only (not fetched yet) |
| Chemist Warehouse (from GitHub) | Algolia search index (approved, limited to tracked categories) | Online, national | Clearance only (see below) | Tracked categories | Some, from supplier image links |

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

## Collection rules (built into the code)

- At most one full collection per store per specials cycle (`--due`), with 3–8 second gaps
  between requests and a request budget per run.
- robots.txt is checked before every request, including `*` wildcards. This caught a Coles rule
  that blocks the lighter data route, so Coles specials are read from the normal web pages.
- No logins, no CAPTCHA solving, no proxies. Any refusal, challenge page or unexpected response
  stops that store's run immediately, and the scheduler then waits at least a day before trying it again.
- Requests identify themselves as `FamilySpecialsFinder/0.1 (household use)`.

## The Mac schedule

Installed on 16 Oct 2026 as `~/Library/LaunchAgents/au.family-specials.collect.plist` (a copy of
`scheduling/au.family-specials.collect.plist`). It runs `scripts/mac-update.sh` at **7:30am and 6:30pm**,
and launchd catches up after the Mac wakes. Most runs are just **checks**:

- A store is only collected when its new specials are due this cycle: **Woolworths** (and Coles'
  small weekly read) from **Wednesday**. Once collected, later runs that week do nothing.
- Nothing collected means nothing committed or pushed.
- **Coles:** paused for good. Its one trial on 16 Oct was challenged on half-price page 6. The read is
  set to the half-price list plus watchlist categories only, but it won't run again unless you set a
  new `trial_since` in `config/stores.yaml` by hand.
- **Plugged in:** the update keeps the Mac awake until it finishes (`caffeinate -s`, mains power only).
  To have the Mac wake itself before the Wednesday update, see "Waking the Mac" below.
- Problems show a Mac notification and go in `data/logs/collect.log`.

```bash
launchctl kickstart gui/$(id -u)/au.family-specials.collect        # run it now
launchctl bootout gui/$(id -u)/au.family-specials.collect          # stop the schedule
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/au.family-specials.collect.plist   # start it again
```

### Waking the Mac on Wednesday mornings

A scheduled wake is a macOS system setting and needs your password, so you run it yourself in
Terminal:

```bash
sudo pmset repeat wakeorpoweron W 07:25:00
```

The Mac then wakes at 7:25am every Wednesday, ready for the 7:30 update. Notes:

- **Check it:** `pmset -g sched`. **Turn it off:** `sudo pmset repeat cancel`. This removes every
  repeating wake or sleep schedule, and you've set no others.
- macOS has no "only when plugged in" option for scheduled wakes, so on battery it wakes too. On
  battery the update doesn't hold the Mac awake, so it may go back to sleep. Anything missed then
  runs at the next wake.
- With the lid closed and no external display, macOS may go straight back to sleep. Leaving the lid
  open on the charger works best.

## Backups

What only lives on this Mac, the **price database** and **`data/private/`**, is backed up
to **iCloud Drive → `family-specials-backups`**. The code is on GitHub, so it isn't copied. `.env`
files, tokens and passwords are never copied.

- **When:** weekly, straight after the Wednesday update (the first scheduled run after Wednesday).
  To back up now: `uv run specials backup`.
- **How:** SQLite's own backup method makes a consistent copy of the live database. The copy must
  pass `PRAGMA integrity_check`, is compressed (xz), and is checked again after it lands in iCloud.
  The live database and the project's git folder are never put in iCloud.
- **Keeps:** the newest 8 weekly copies; older ones are deleted. Each backup is a dated folder,
  e.g. `2026-10-16_1012/`, holding `specials.db.xz`, `private/` and `manifest.json` (sizes,
  checksums, row counts).
- **If it fails** (no iCloud, not enough space, a failed check): a Mac notification, a
  `BACKUP FAILED` line in `data/logs/collect.log`, and nothing half-written is left behind.
- **Space:** it checks iCloud has room for the copy plus a 50 MB margin before writing, so it can
  never fill your iCloud.

### How to restore

1. Stop the schedule: `launchctl bootout gui/$(id -u)/au.family-specials.collect`
2. Restore the newest backup into the project's `data/` folder (or pick one with `--from`):

   ```bash
   cd ~/Claude/family-specials
   uv run specials restore --to data
   uv run specials restore --from ~/Library/Mobile\ Documents/com~apple~CloudDocs/family-specials-backups/2026-10-16_1012 --to data
   ```

   This unpacks `specials.db` and `private/`, checks the database is sound, and keeps any
   existing files beside it as `*.before-restore-<time>`. Nothing is overwritten.
3. Check it: `uv run specials status`.
4. Start the schedule again (see above).

To practise without touching anything, restore into a temporary folder:
`uv run specials restore --to /tmp/restore-test`.

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

`.env` (never committed, readable only by you; see `.env.example`) holds:

- Chemist Warehouse's public search key, which its website uses. On GitHub it's the repository secret
  `CW_ALGOLIA_SEARCH_KEY`.
- `VAPID_PRIVATE_KEY`, the key that signs phone notifications. On GitHub it's the secret of the same name.

The list of phones that get notifications is the `PUSH_SUBSCRIPTIONS` secret (copied from
`data/push/devices.json` by `specials notify add` and `remove`).

## Development

```bash
uv run pytest            # parser, robots.txt, store normalisers, history round trip, unit prices
```

Code is in `src/family_specials/`: one adapter per store in `collectors/` behind a shared
interface (`fetch_specials()` returns raw items, `normalise(raw_item)` returns a normalised item).
