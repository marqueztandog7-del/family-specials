# Family accounts: start a family, invite, join, and share live (spec of 16 Oct 2026)

> **Status:** the backend proposal comes first; nothing is built until it's OK'd. Examples are generalised in this
> public copy (no family or personal names).

Build this on the backend you proposed. If we haven't agreed one yet, propose it first and wait for my OK.

## 1. Start a family
- A signed-in person can tap "Start a family account" (on Home and in Settings) and give it a name. They become the owner.
- Straight away the app creates:
  - an invite link that opens our app's sign-in page with the family already attached
  - a unique 6-character join code of letters and numbers (leave out look-alikes such as 0/O and 1/I/L so it's easy to read out)
- Show both on one screen, each with a "Copy" button that copies it to the phone's clipboard and a short "Copied" confirmation, plus a "Share" button that opens the phone's share sheet. Nothing is sent by the app itself; the owner pastes it into whatever app they already use.

## 2. Join a family
- Tapping the invite link opens our sign-in page. A new person creates an account with email and password (existing users just sign in).
- Once their account is set up, show a "Join a family" screen with:
  - a text box for the 6-character code (pre-filled if they came from the invite link, but still shown so they can check it)
  - a text box for their nickname in the family (e.g. "Mum")
- On success, take them to the family Home dashboard. Show a clear message for a wrong or expired code.
- Anyone can also reach "Join a family" later from Settings and type a code in by hand.

## 3. Shared Pantry on Home
- Add a "Shared Pantry" section on Home showing each family member's nickname (with initials), plus the owner marked as owner.
- Replace the old "Just you for now" placeholder. Someone not in a family sees "Start a family account" and "Join with a code" there instead.

## 4. Everything shared, live
- The family shares one watchlist, one shopping list and one savings tracker.
- Any add, edit, tick or removal by one member shows up on every other member's phone within a few seconds, without reloading. Show who added an item to the list (by nickname).
- If two people change the same item at once, keep the latest change and never lose an item.
- If someone is offline in a store, let them keep ticking items off and sync when they're back online.

## 5. Owner controls and safety
- The owner can see members, change the family name, remove a member, and make a new code and link (the old ones stop working). Codes expire after 7 days unless renewed.
- Limit wrong code attempts so codes can't be guessed.
- Members can leave the family from Settings. One person belongs to one family for now.
- Each family can only ever see its own data. Never put emails, nicknames, codes, links or any family data in the public repo, and keep keys in GitHub secrets.

## 6. Alerts bell on every page
- Move the Alerts bell next to the settings icon in the top-right corner of every screen, not just Home, with the unread count. Tapping it opens Alerts.
- Alerts are family-wide: a watchlist item on special alerts everyone in the family, and phone notifications follow each person's own "Allow notifications" setting.

## How to build it
Stop after each so I can test on two phones: (a) start a family, copy link and code; (b) join with link and code plus nickname; (c) Shared Pantry on Home and live syncing of the list and watchlist; (d) owner controls; (e) the bell on every page. Use the Stitch designs for the look, keep the front end Capacitor-ready, and update the README, CLAUDE.md and decisions log.
