# Family Specials Finder

A cost-of-living app for our family: once a week it collects every store's specials and full product range,
keeps a price history, matches it against our private watchlist, and shows it on a page you can install on your
phone like an app.

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
  - **Top-right on every tab:** the **Alerts bell** (with the unread count), then the **account icon** in the
    corner (your initials; a photo later). Tapping the account icon opens a small menu: **Profile** (your name,
    nickname in the family, email, family and role, sign out, delete account) and **Settings**. The menu closes
    on an outside tap, Escape or a choice, and works with screen readers and the keyboard. Your name is optional and
    only you see it; the family sees your nickname.
  - **Home** (built to `docs/design/home`): the weekly savings radar (potential savings, and how much of it is on
    your list), new on special this week, recently added to your list, recommended to add, and Shared Pantry (your
    family's members, or start or join a family).
  - **This Week:** three subtabs, each with its count. **All specials** is every special at Woolworths, ALDI, Costco
    and Chemist Warehouse (watched or not): Core Essentials first, then Regulars, then other watched items, then
    everything else, biggest saving first, with a search box. **Core Essentials** and **Regulars** show only the
    specials matching those watchlist groups. Every card shows its store; watched ones carry the bookmark marker. A
    special stays for as long as the store says (its own end date where it gives one).
  - **Watchlist:** every watched item. Tap one for its price at each store, a price history chart and its
    signals. Search covers **every product in every store's full range** (store, name, size, price, unit price,
    special or not), then "Add to list" or "Watch". There's no way to choose a group yet, so a product added from
    search is watched with no group ("Added by the family").
  - **List:** grouped by store with store totals, tick items off as you shop, add your own items, share the
    list as a message. "You save on specials" comes from each store's was price. Comparing the whole list at each
    store (where to shop) comes next.
  - **Savings:** ticking off a special records its saving (the store's was price minus the special price, times the
    quantity). Shows all-time, this week, this month, last shop, average per shop, monthly bars and top items.
    An estimate, saved on this phone until accounts arrive.
  - **Alerts and Settings** open over the tabs (no tab bar), as in the designs. Item detail keeps the tab bar.
  - **Settings** (from the account menu): your family, prices, notifications, which stores to compare and when
    each last updated, how our prices work, and clearing this phone's list and savings.
- **Every number comes from real data, or the app says there isn't enough yet.** Savings use each store's
  own was price (or multibuy). "New this week" needs a read of the product the week before. "Usually $X"
  needs that normal price in 2 different weeks. "Lowest in N weeks" needs 4 weeks of history.
  Recommendations only come from the watchlist (built from our receipts).
- **What's public, and what isn't.** The page's public data file (`site/data/specials.json`) holds **store specials
  only**, every store's, whatever we watch. **The watchlist and its Core Essentials and Regulars are private**
  (19 Oct 2026): they're about what our family buys, so they live in `data/private/` on the Mac and in the family's
  own row in Supabase, which only its members can read. Search engines are asked not to list the page.
- **How it looks.** Built to the Pantry Standard Stitch designs in `docs/design`: warm limestone surfaces,
  terracotta buttons, sage savings badges, store colour tags, Plus Jakarta Sans for text and JetBrains Mono for every
  price. The fonts and icons come from Google Fonts and are kept on the phone after the first visit.
- **How it's built.** It's a static web app in `site/`:
  - `index.html`, `styles.css` and `js/app.js` are the screens.
  - **`js/data.js` is the only file that reads or saves data:** `site/data/specials.json` (every store's specials)
    and `status.json` from the page, and through `js/account.js` the family's private watchlist (with offers,
    history and signals) and search over every store's range, plus the list, settings and alerts kept on this
    phone. **`js/push.js`** is the only file that talks to the phone's
    push service. A future App Store / Google Play build (Capacitor) can wrap `site/` as it is and only
    swap those two files.
  - `sw.js` keeps the app and the last prices available offline and shows notifications.
    `manifest.webmanifest` and `icons/` make it installable (`scripts/make_icons.py` redraws the icons).

## Accounts and families (Supabase)

The app's sign-in and family sharing run on **Supabase** (free plan, Sydney region, OK'd 16 Oct 2026). GitHub Pages
still serves the app, and GitHub Actions still does prices and notifications.

- **Signing in:** email and password (at least 8 characters), with no confirmation email. The first time the app
  opens it shows a sign-in / create-account screen.
- **Forgot password:** "Forgot password?" under the password box → your email → "Send reset link". The app always
  answers "If that email has an account, we've sent a link…" (it never says whether an account exists). The email's
  link opens the app on **Set a new password** (new and confirm, at least 8 characters, Show/Hide); it works in any
  browser, including the Mail and Gmail apps' own, because it carries a one-time token rather than relying on the
  browser that asked. Success signs you in and opens Home with "Your password has been updated". A used or expired
  link says "This link has expired. Request a new one."
  - **Who sends it:** Supabase's built-in sender only reaches the project's own team, 2 emails an hour, and on the
    free plan its wording can't be changed. So reset emails come from a Gmail account made for the app (free, with an
    app password), set up with `uv run specials backend email`, which also sets the short "Reset your Family
    Specials password" email. The app password is kept in Supabase, `.env` and the `SMTP_PASSWORD` secret only.
- **Starting a family:** a signed-in person starts a family (on Home under Shared Pantry, or in Profile) and becomes
  its owner. The app makes two separate things:
  - an **invite link** (Copy, Share), which carries only a random token and never the code;
  - a **6-character join code** (Copy; 2–9 and A–Z without 0, O, 1, I or L). It's stored only as a bcrypt hash,
    shown once when it's made, and lasts 7 days.

  The owner sends the link, then the code in a separate message. "Make a new code" (Profile > Family > Invite)
  makes a new link and code, and the old ones stop working straight away.
- **Joining:** the link opens "[Inviter] invited you to join [Family]" on any phone (even one that's never opened
  the app, and in WhatsApp's or Messages' in-app browser). Next comes an account (email, password, confirm password)
  or signing in, then the code typed by hand and a nickname.
  - **The rules:** wrong codes are counted (5 per person per 15 minutes, and 20 per invite per hour), and an expired
    or replaced invite is refused, each with a clear message. The link alone can never join.
  - **Afterwards:** a welcome screen suggests opening the app in Safari (or Chrome) and adding it to the Home Screen.
  - **Elsewhere:** Profile > Join a family takes a pasted link and the code.
  - **Old links:** links from the first version (with the code in them) show "This invite link no longer works".
- **Sharing:** the family shares one watchlist, one shopping list and one savings tracker, live on every member's
  phone (Supabase Realtime).
  - **Who added it:** list items show who added them ("added by Mum").
  - **Conflicts:** changes merge field by field, and the latest change wins. Removals are kept as "removed", so a
    later change brings an item back.
  - **Offline:** ticks and changes wait on the phone and sync when it's back online.
  - **Joining with things on your phone:** what was already on that phone's list and savings moves into the family
    once, with no duplicates.
  - **The watchlist:** in a family, anyone can stop watching an item (Watchlist > item > Stop watching; "Stopped
    watching" lists them to restore) or add a product from search (Watch).
- **Owner and members (Profile):** the owner can rename the family, remove members, and make a new code and link.
  Anyone can change their nickname or leave. An owner leaving with others in the family hands it to one of them
  first, and the last one out takes the family with them.
- **Privacy:** every table has row-level security, so people only ever see their own family. Changes go through
  server functions that check who's asking. Supabase keeps the email and a scrambled password; our tables keep
  only the family name and nicknames.
- **How the app finds the backend:** `site/app-config.json` (the project address and its public key, which is
  designed to be visible and protected by row-level security). The publish workflows write it from GitHub secrets,
  and `specials serve` writes it locally from `.env`. It's never committed. Without it, the app runs as before,
  with everything on the phone.
- **Code:** `site/js/account.js` is the only file that talks to Supabase. `supabase/migrations/` holds the
  database changes, applied once each, in order.

```bash
uv run specials backend connect     # first time: asks you to paste your Supabase access token (hidden)
uv run specials backend migrate     # apply new database changes
uv run specials backend status      # what's applied, and how many accounts and families (counts only)
uv run specials backend test        # the database self-test: pretend people, rolled back, saves nothing
uv run specials backend email       # reset emails from the app's Gmail account (asks for its app password, hidden)
```

- **Every store's range, for search:** `store_products` (store data only, about 40,000–60,000 products), sent by the
  Mac after each weekly refresh. Signed-in people can search it (`search_products`: every word must start a word in
  the product; close spellings too); nobody can change it from the app.
- **The family's watchlist:** `family_watchlist`, one private row per family (items, groups, matched products,
  signals), built on the Mac from `data/private/`. Only that family's members can read it.
- **Testing the screens without Supabase:** `uv run python tests/fake_backend.py --port 8799` serves the app with a
  pretend backend on this Mac only (pretend accounts in memory; reset "emails" go to `data/logs/fake-emails.log`).

`connect` stores the access token, the project details and the secret key in `.env` (readable only by you). It
also sets the `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` and `SUPABASE_SECRET_KEY` GitHub secrets, sets up sign-in
and applies the migrations. Nothing secret is printed.

## Phone notifications

**Free.** Standard Web Push: phones get notifications through Apple's and Google's own push services
(free), sent from the Mac after the weekly refresh. No other service, account or app.

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

- **How it runs:** the Mac runs `specials notify run` after each refresh (since 19 Oct 2026: it needs the private
  watchlist, which never goes to GitHub). It records what it sent in `data/private/notify-sent.csv`, so nothing
  repeats.
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
./scripts/mac-update.sh                # pull, refresh what's due (every store, weekly), publish specials, push
uv run specials serve                  # the family page locally at http://127.0.0.1:8000
uv run specials search "milk"          # search from the command line (full local database)
uv run specials status                 # what was collected, and when
```

`uv` and `gh` live in `~/.local/bin`. If they aren't found, run `export PATH="$HOME/.local/bin:$PATH"`.

## The watchlist

`data/private/watchlist.yaml` (private, on the Mac only; moved out of the repo on 19 Oct 2026) holds the family
watchlist. It was seeded on 16 Oct 2026 with the 36 Core and Regular items from
`data/private/family_regular_items.csv`, each at its suggested level. Each item has:

- **a level:** `exact` (one product at one store), `same_product` (the same product at any store: same
  barcode, otherwise same brand + size + a close name), or `similar` (a rule such as "rolled oats, any
  brand, 500 g to 2 kg", store brands included);
- **a tier** (core items show first) and the unit to **compare per** (kg, L, item, can, bag, sheet,
  wipe, tea bag), plus an optional **target** unit price;
- **the store categories** it's found in (only used for reading categories by hand: the weekly refresh reads every
  store's full range).

```bash
uv run specials watch                                  # the watchlist
uv run specials watch add woolworths 123456            # add a product: same product, any store
uv run specials watch add woolworths 123456 --similar  # ...and also watch similar items
uv run specials match                                  # re-run matching + write the accuracy report
uv run specials review                                 # matches waiting for you
uv run specials review reject <item> <store> <product id>   # never comes back
uv run specials review confirm <item> <store> <product id>
```

Matching runs after every refresh, on the Mac, across every store's full range. Your decisions are saved in
`data/private/watch-decisions.csv` (private). The accuracy report goes to `data/reports/` (private: it uses receipt
names).

## How the data updates

**One weekly refresh, from the Mac, on Wednesday morning** (with Woolworths' new specials). `scripts/mac-update.sh`
runs at 7:30am and 6:30pm; a store is only read when it's due this week, so most runs are just checks. For each
store, even if nothing changed:

1. **Specials** (Woolworths' specials groups, ALDI's Special Buys and Super Savers, Costco's Hot Buys; Chemist
   Warehouse's come from its range and catalogue).
2. **The full range**, from category pages only, never search pages: Woolworths aisle by aisle (about 850 requests,
   about an hour), ALDI page by page (about 55), Costco page by page (about 120), Chemist Warehouse's own products
   by price band (about 45, marketplace sellers left out).
3. **The printed catalogue:** Costco's In-Warehouse Savings booklet (read as text) and Chemist Warehouse's
   catalogue (page images read with AI). See "Catalogues" below.

Then: **matching** across every store, the **public specials file** (`site/data/specials.json`), **every store's
range to Supabase** for search, **the family's private watchlist** to its row in Supabase, and **phone
notifications**. Only store data is committed and pushed (specials history and the public specials file), and the
push publishes the page. GitHub no longer collects anything: `.github/workflows/keepalive.yml` only checks in with
Supabase daily so it doesn't pause, and `pages.yml` publishes the page when the Mac pushes.

**A store that refuses us is paused** (`pause_on_block` in `config/stores.yaml`): nothing contacts it again, from
any schedule, until you run `uv run specials resume <store>`. The Mac shows a notification. Coles stays paused for
good.

### Update reports (private)

Every time the app's specials change (or a store is read), `specials update` writes a plain-English report to
`data/reports/updates/` (never committed: it names our Core Essentials and Regulars): specials and products per
store and what changed, This Week's subtab counts, each read this week (requests, products, time taken), and what
wasn't collected and why. `uv run specials report` writes one now; `--show` prints the newest. A scheduled task in
the Claude app ("Specials update report", 10:30am and 8:30pm) sends each new report on.

### Price history in the repo (`history/`)

Small CSV files that only ever grow, holding **specials only** (every store's, whatever we watch, since 19 Oct 2026):

- `history/observations/<store>-<year>.csv`: every special we've seen, one row per product per run.
- `history/products/<store>.csv`: those products' names, sizes and barcodes.
- `history/runs/<store>.csv`: every collection run (where, when, status).

Regular prices, the full ranges, member prices and raw store data stay in the local database (`data/specials.db`,
never committed, backed up weekly to iCloud). A full-range read records a product's price only when it changed
(or once a month), except for products matched to the watchlist, which get a price every week for their signals.

## Catalogues

- **Costco, In-Warehouse Savings booklet:** found through costco.com.au/warehouse-savings and hosted on Joomag
  (robots.txt allows it). Its viewer has a text version of every page, so each item's price, "after $X off", name,
  size, per-unit price and Costco item number are read exactly. The item number is Costco's own product code, so it
  matches the online product exactly. These are **warehouse shelf prices**, shown instead of the online price
  (which includes delivery) while the booklet runs. The "Online Only" page is left out.
- **Chemist Warehouse, printed catalogue:** page images only (Nexus Publications viewer). Each page is read once with
  AI (Anthropic's API, about US$0.50 a catalogue; the key is set with `uv run specials catalogue key`) and the answer
  is kept on the Mac. Each offer is matched to a product in Chemist Warehouse's range by name and size. **Our rule:**
  "$X off RRP" is everyday pricing, so a catalogue price counts as a special only when it's lower than the price we
  recorded at Chemist Warehouse before the catalogue started (shown as the was price), or when the catalogue says
  the saving is off its everyday price and prints the amount. Offers for a whole range ("½ price Maybelline range")
  aren't recorded.
- **Review:** anything that can't be read clearly, or matched to one product with confidence, waits on the review
  list (`data/catalogue-review.json`, Mac only), never in the prices: `uv run specials catalogue review` shows each
  one with its page and lets you confirm the product or reject it.

## Collecting by hand

```bash
uv run specials update --where mac               # what mac-update.sh runs, without the git steps
uv run specials update --force --chain aldi      # refresh one store now, even if it's not due
uv run specials collect                          # every store: specials, full range, catalogue (local DB only)
uv run specials collect --due                    # only stores not yet collected this cycle
uv run specials collect --chain aldi             # one store
uv run specials collect --chain coles --kind specials --max-pages 1   # quick test
```

Each store runs on its own: if one is blocked or breaks, the others still run. Every run is
logged (`collection_runs`), together with exactly which pages it read (`run_coverage`).

### What each store gives us

| Store | Source | Our store | Specials | Regular prices | Barcodes |
|---|---|---|---|---|---|
| Woolworths (it blocks GitHub) | JSON API the site uses | Woolworths' default store for anonymous visitors, which changes (#7008 on 5 Oct, #2631 on 12 Oct); pinning Kellyville North needs a login | Half Price, Lower Shelf Price*, Seasonal*, Buy More Save More, Online Only | Full range, aisle by aisle | In listings (almost all) |
| Coles (**paused for good**: the one trial on 16 Oct was challenged on half-price page 6) | Data embedded in its normal web pages | Kellyville #0883 (set with a cookie, no login) | Half-price pages only | Tracked categories | Product pages only (not fetched yet) |
| ALDI | Public JSON API | North Kellyville G449 | Special Buys (each Wed/Sat drop, published two weeks ahead), Super Savers, anything with a was price; Lower Prices* | Full range | None (mostly own brands) |
| Costco | JSON API the site uses, plus the In-Warehouse Savings booklet | Online, national; booklet = warehouse shelf prices | Online savings with real end dates; booklet savings | Full range (online) | Product detail only (not fetched yet) |
| Chemist Warehouse | Algolia search index (approved for the full range, 19 Oct 2026), plus its printed catalogue | Online, national | Clearance; catalogue prices below its earlier price (see Catalogues) | Full range (own products) | Some, from supplier image links |

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

### Tracked categories (by hand only)

The weekly refresh reads every store's full range, so tracked categories are only for reading a category by hand
(`specials collect --kind category`): the watchlist's own categories plus any extras in
`config/tracked_categories.yaml`. Find category ids with:

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

Installed on 16 Oct 2026 as `~/Library/LaunchAgents/au.family-specials.collect.plist`, a copy of
`scheduling/au.family-specials.collect.plist` with `__PROJECT_DIR__` replaced by the project folder (so the public file
doesn't carry the Mac's user name). To install it again, run this from the project folder:
`sed "s|__PROJECT_DIR__|$PWD|g" scheduling/au.family-specials.collect.plist > ~/Library/LaunchAgents/au.family-specials.collect.plist`. It runs `scripts/mac-update.sh` at **7:30am and 6:30pm**,
and launchd catches up after the Mac wakes. Most runs are just **checks**:

- Every store is read once a week, from **Wednesday** (specials, full range, catalogue). Once read, later runs
  that week do nothing.
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
- `ANTHROPIC_API_KEY`, for reading Chemist Warehouse's catalogue pages (also a GitHub secret).
- `SMTP_PASSWORD`, the reset-email Gmail account's app password (also a GitHub secret, and in Supabase).
- The Supabase access token, project details, secret key and our family's id (`SUPABASE_*`).
- `VAPID_PRIVATE_KEY`, the key that signs phone notifications. On GitHub it's the secret of the same name.

The list of phones that get notifications is the `PUSH_SUBSCRIPTIONS` secret (copied from
`data/push/devices.json` by `specials notify add` and `remove`).

## Development

```bash
uv run pytest            # parser, robots.txt, store normalisers, history round trip, unit prices
```

Code is in `src/family_specials/`: one adapter per store in `collectors/` behind a shared
interface (`fetch_specials()` returns raw items, `normalise(raw_item)` returns a normalised item).
