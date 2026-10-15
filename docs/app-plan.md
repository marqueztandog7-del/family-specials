# The app: tabs, list, signals, alerts and savings (spec of 16 Oct 2026)

Built for the routine in [weekly-routine.md](weekly-routine.md). **Not started yet: waiting for approval of the
Part 5 matching accuracy report.** Stores, in priority order: Woolworths, Coles, Chemist Warehouse, Costco, ALDI
(Tong Li dropped 16 Oct 2026; Coles paused for good).

## Bottom tab bar (five tabs)
Phone-first, large easy-to-tap targets, plain grey, black and white.
1. **This Week** (opens here): every watchlist item currently on special, best unit price first, core items first, each with its buy-now signal and an "Add to list" button.
2. **Watchlist:** all watched items. Tapping one opens its detail: current price at each store, a simple price history chart, and its buy-now signal. Search to add new items lives here.
3. **List:** the shopping list.
4. **Alerts:** notifications for watched items.
5. **Savings:** the savings tracker.

**Settings gear** in the top-right corner of every tab (not a tab of its own). For now: which stores to compare, each store's last update, a short "how our prices work" note (shelf prices only, Coles paused), and clearing the list and savings on this phone. Designed to grow into Account and Settings when family accounts, alerts and receipts arrive.

## Shopping list
- Add from This Week, Watchlist or search. Change quantity, remove, tick off.
- Group by store, with a total per store and the total saving.
- **Where to shop:** compare buying everything at each single store against splitting across stores, and show the difference in dollars. Only compare stores with current data. Say clearly that Coles is paused.
- Works offline once opened (poor reception in store).
- Share the list as a text message, using the phone's share button.
- Saved on each phone for now; designed to move to a shared family account later.

## Price history and buy-now signals (only when the data supports it)
- "Half price" or "Multibuy deal": from the store's own promo.
- "Lowest in N weeks": only with at least 4 weeks of history. Otherwise "Not enough history yet".
- "Below your target": when a target unit price is set and met.
- "Was price looks inflated": when the was price is higher than any normal price we've recorded.
- "Usually cheaper on special": at normal price now, but on special in the last 12 weeks.
- Never predict when the next special will be.

## Alerts
- In-app Alerts tab: each time a watched item goes on special, add an alert (item, store, price, saving, end date); mark unread ones.
- Real push notifications: research what iPhone and Android need for a home-screen web app (including any server or service to send them), propose the simplest free option, and **wait for OK** before building.
- Keep the weekly digest from Part 6.

## Savings tracker
- When a list item is ticked off as bought on special, record the saving: normal shelf price minus special price, times quantity. Shelf prices only (pricing rules).
- Show savings this week, this month and since we started, plus the top items we saved on.
- Label it an estimate. Saved on each phone for now; designed to move to a shared family account later.

## Build order (stop after each so it can be checked on a phone)
(a) Tab bar, This Week and Watchlist with price history and signals → (b) List → (c) Savings → (d) Alerts.
Keep the front end Capacitor-ready, update the README and decisions log, and never show a price, saving or signal the data doesn't support.
