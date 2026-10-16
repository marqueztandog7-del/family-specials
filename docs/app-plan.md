# The app: tabs, list, signals, alerts and savings (spec of 16 Oct 2026)

Built for the routine in [weekly-routine.md](weekly-routine.md). Started 16 Oct 2026 after the Part 5 accuracy
report was approved. Stores, in priority order: Woolworths, Coles, Chemist Warehouse, Costco, ALDI (Tong Li
dropped 16 Oct 2026; Coles paused for good).

**Layout change (16 Oct 2026, replaces the first five-tab plan):** Alerts left the tab bar for a bell on Home,
and Home was added in the middle.

## Bottom tab bar (five tabs)
**This Week · Watchlist · Home · List · Savings.** Phone-first, large easy-to-tap targets, plain grey, black
and white.
1. **This Week:** every watchlist item currently on special, best unit price first, core items first, each with
   its buy-now signal and an "Add to list" button.
2. **Watchlist:** all watched items. Tapping one opens its detail: current price at each store, a simple price
   history chart, and its buy-now signal. Search to add new items lives here.
3. **Home** (the middle tab, and where the app opens): stands out with a bolder label and a larger, filled
   icon. See "Home dashboard" below.
4. **List:** the shopping list.
5. **Savings:** the savings tracker.

**Bell** (Home only, top-right, next to the gear): the number of unread alerts. Opens the Alerts screen.

**Settings gear** in the top-right corner of every screen (not a tab). For now: notifications, which stores
to compare, each store's last update, a short "how our prices work" note (shelf prices only, Coles paused),
and clearing the list and savings on this phone. Designed to grow into Account and Settings when family
accounts, alerts and receipts arrive.

## Home dashboard (top to bottom)
1. **Potential savings:** how much we could save this week buying every watchlist item on special, and how
   many items. Opens This Week.
2. **New on special this week:** the top 3 to 5 items that went on special this cycle, biggest saving first,
   each with "Add to list". "See all" opens This Week.
3. **Recently added to the list:** the last 3 to 5 items, with the list total. Opens List.
4. **Recommended to add:** items we buy regularly that are due or on special now and aren't on the list, each
   with a short reason ("You buy this often · On special, usually $15.50"). Only from our own history.
5. **Family:** "Just you for now" and a disabled "Invite family" button marked "Coming soon". Fills in when
   family accounts arrive.

Every number on Home comes from real data; if there isn't enough yet, it says so rather than estimating.

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
- In-app Alerts screen (behind the bell on Home): each time a watched item goes on special, add an alert (item, store, price, saving, end date); mark unread ones.
- Phone notifications (asked for 16 Oct 2026): every new alert also arrives as a notification, at most one per item per specials cycle, plus the weekly digest. Each phone opts in with "Allow notifications" in Settings. Built with free Web Push sent from GitHub Actions (README, "Phone notifications").

## Savings tracker
- When a list item is ticked off as bought on special, record the saving: normal shelf price minus special price, times quantity. Shelf prices only (pricing rules).
- Show savings this week, this month and since we started, plus the top items we saved on.
- Label it an estimate. Saved on each phone for now; designed to move to a shared family account later.

## Build order (stop after each so it can be checked on a phone)
(a) Tab bar, Home, This Week and Watchlist with price history and signals, plus the bell, Alerts and phone
notifications (asked for during (a)) → (b) List → (c) Savings.
Keep the front end Capacitor-ready, update the README and decisions log, and never show a price, saving or signal the data doesn't support.
