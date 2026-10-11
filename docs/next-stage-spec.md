# Next stage: GitHub, a family app link, automatic updates, and the watchlist

Phase 1 is done. Read CLAUDE.md, the README, the Phase 1 report and store-recon.md first, then save this spec to docs/next-stage-spec.md.

I'm working on this on my own. Work through the parts in order and stop where it says.

## Product vision (make sure CLAUDE.md says this)
A cost-of-living app, built for our family first and possibly the public later. Users add the things they buy (by searching, scanning a receipt or importing purchase history) to a watchlist. The app matches each watched item to the same product and to close alternatives at every store we use, and tells them when any of those go on special.

Stores, in priority order: Woolworths, Coles, Chemist Warehouse, Costco, ALDI, Tong Li.

## Part 1: Put the project on GitHub (stop before the first push)
- Initialise git if needed and commit what we have.
- Create a new public GitHub repo on my account called family-specials. Walk me through anything I need to do myself, like making an account or signing in.
- The repo is public, so .gitignore must keep out: the database, raw collector responses, everything in data/private (our receipt files), .env and any secrets. Keep a small set of saved store responses as test fixtures.
- Before the first push, show me the full list of files that will go up and wait for my OK.

## Part 2: A family link that installs like an app
- Publish the search page on GitHub Pages. If it needs a server, turn it into a static page that searches a data file in the browser, and tell me what changed.
- Make it installable from the browser on iPhone and Android: a web app manifest, a plain app icon, and the meta tags Add to Home Screen needs.
- Build the front end as a self-contained web app that reads the data through one clear layer, so it can later be wrapped with Capacitor for the App Store and Google Play without a rewrite. Don't add anything that only works on a desktop browser.
- Design for phones first. Keep it plain: greys, black and white, no colour accents.

## Part 3: Automatic updates (stop and report)
- Add a scheduled GitHub Actions workflow on Sydney time: Woolworths and Coles every Wednesday morning, ALDI on Wednesday and Saturday, and Chemist Warehouse and Costco weekly. Each run collects, rebuilds the data file and commits it, which updates the Pages link.
- First do one small test run from GitHub for each store (a page or two, not a full run) and tell me which work. If a store blocks or challenges GitHub's servers, don't try to get around it. Mark that store to run from my Mac instead.
- Add one command for my Mac that pulls the latest changes, runs the collectors GitHub can't, rebuilds the data file and pushes it.
- Keep price history in a compact file in the repo so it builds up week by week.
- Show on the page when each store was last updated.
- Make sure I get an email if a run fails.

Stop here. Give me the Pages link, the repo link, and which stores update from GitHub and which from my Mac.

## Pricing rules (apply everywhere)
- Compare stores on shelf prices and specials only. Leave out member discounts (such as Everyday Extra), staff discounts, rewards dollars, delivery fees and bag fees.
- Multibuy deals (e.g. "2 for $8") are specials. Show the effective price per item and per unit.
- Not specials: Chemist Warehouse "$X Off RRP" and Woolworths "Everyday Low Price". Store them as normal prices.
- Sponsored or ad items never count as matches and never rank higher.
- Compare on a normalised unit price: per kg, per L, per 100 g or per each, or a count such as per sheet, per bag, per can or per tea bag where a rule says so. Weighed items, like chicken thigh trays, compare per kg.

## Our data (in data/private, never pushed)
From 10 of our Woolworths receipts (6 May to 27 Sep 2026):
- family_regular_items.csv: 65 items we bought in 2 or more shops, with a tier (core, regular, occasional), a suggested watch level and a rule. We've filled in keep_on_watchlist, brand_matters and family_notes. Seed the watchlist with the rows marked keep, and follow brand_matters where it disagrees with the suggested level. If those columns are empty, ask me before seeding.
- woolworths_receipt_items.csv: every receipt line hand-matched to a product and watch item, at shelf price. In-store and online receipts name the same product differently (e.g. "WW RSPCA Chicken Thigh Fillets Bulk" and "Woolworths rspca approved chicken thigh fillets skinless tray 1.3kg - 1.7kg"). Treat this mapping as ground truth for tests.
- woolworths_receipt_summary.csv: item totals per receipt at shelf price.

The published page may show watchlist item names and rules only. No receipt details, dates, prices we paid or spend go on GitHub or the page.

Online receipts don't mark which items were on special. In-store receipts do (a ^ next to the item). So never treat a price from an online order as the normal price.

## Part 4: Watch items
Three levels of specificity:
1. Exact: one product at one store.
2. Same product, any store: matched by barcode (GTIN) where available, otherwise by brand, normalised name and size, with a confidence score.
3. Similar: a rule like "beef mince, any brand, 500 g to 2 kg" or "canola oil 4 L, any brand", including store-brand equivalents (Woolworths, Coles and ALDI own brands).

The family page is read-only for now, so adding watch items and reviewing matches happen on my Mac and get committed. Adding from search defaults to level 2, with a toggle to also watch similar items. Each watch item can have an optional target unit price. Keep the tier from the seed file so core items show first.

## Part 5: Matching (stop and report)
- First match each seed item to its current Woolworths product (stockcode and barcode). Then use the barcode to find it at Coles, and brand, name and size for everything else.
- Coles barcodes are only on product pages. Fetch each one once per new product and cache it, as the recon says.
- ALDI is mostly own brand with no barcodes, so ALDI matches will mostly be "similar".
- Every match stores its reason ("same barcode", "same brand and size", "similar: beef mince 500 g to 2 kg") and a confidence score.
- Low-confidence matches go to a review list where I can confirm or reject them. A rejected match never comes back for that watch item.
- Re-run matching after every data update.

Stop here and give me an accuracy report: for each watch item and store, show matched, similar only or not found, plus the results of the receipt-name test. Show me the misses.

## Part 6: On special this week
- A view on the family page of every watch item with at least one current special, grouped by watch item, sorted by best unit price, core items first.
- Show store, price, was price, unit price, promo type and end date. Once history allows, show how good the special is (e.g. "lowest in 8 weeks") and flag was prices that look inflated.
- Mark what's new since the last cycle, so we're only told about each special once.
- A weekly digest after the Wednesday Woolworths and Coles refresh. It should also pick up ALDI Special Buys, the Chemist Warehouse catalogue and Costco savings whenever they change. Propose the simplest free way to get it to my phone and wait for my OK before setting it up.

## Household
One shared family watchlist for now, but structure the data so households and users can be added later without a rewrite.

## Out of scope for now
Receipt scanning, purchase history import, accounts, editing the watchlist from the family page, and the App Store and Google Play. Design for them, but don't build them.

## How I want you to work
- I'm not a full-time developer. Explain decisions briefly in plain English.
- Stop at each stop point so I can check.
- Keep the README, CLAUDE.md and a decisions log in docs up to date.
- Never fake matches or prices. If something can't be collected or matched reliably, say so.

Our shopping items are in data/private: family_regular_items.csv, woolworths_receipt_items.csv and woolworths_receipt_summary.csv. Use family_regular_items.csv for the test. I haven't filled in the keep and brand_matters columns yet, so for now use every row tiered Core or Regular (36 items) and follow the suggested watch level. Keep data/private out of git.
