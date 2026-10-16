# Next: designs, accounts, family sharing and notifications (spec of 16 Oct 2026)

> **Status:** (a) designs applied, done 16 Oct 2026. (b) the backend proposal is next; nothing is built until you OK it.

Do this after the Part 5 accuracy report is approved. It builds on the tab layout and Home dashboard plan already agreed.

## 1. Use my Stitch designs
My designs for all screens are in docs/design, exported from Stitch using my Pantry Standard design system. The Home page design was added separately, so check for it there too. Use them as the visual reference for every screen: layout, spacing, type and components. Replace the sample numbers with live data, and never show a price, saving or signal the data doesn't support. If a design conflicts with something we've agreed (e.g. Coles being paused), follow what we agreed and tell me.

## 2. Accounts
- Anyone using the app creates an account (email and password, or sign in with Apple or Google if that's simple and free). Show a short sign-in / create-account screen the first time the app opens.
- After signing in, people can use the app on their own straight away.
- Add Account to Settings (the settings icon becomes their profile): name, email, sign out, delete account.

## 3. Family accounts and invites
- From Home or Settings, a signed-in person can create a family (they name it, e.g. "Tandog Family") and becomes its owner.
- The owner invites others two ways: a share link (sent by text or any app) and a short join code (e.g. 6 characters) that can be typed in.
- Someone with a link or code must create an account or sign in first, then joins the family.
- The owner can see members, remove members, and make a new code or link (old ones stop working). Codes and links should expire after a sensible time.
- Once in a family, everyone shares the watchlist, the shopping list (with ticks syncing between phones) and the savings tracker. The Family section on Home shows real members, replacing the "Just you for now" placeholder.
- One person belongs to one family for now.

## 4. Notifications
- Every new alert goes to the Alerts screen (the bell on Home) and, if the person has allowed notifications, also arrives as a phone notification.
- In Settings, an "Allow notifications" switch on each phone. On iPhone this only works once the app is added to the home screen, so show a short "Add to Home Screen first" guide if it isn't.
- Notify per family: when a family watchlist item goes on special, everyone in the family who allowed notifications gets it. Send at most one per item per specials cycle, plus the weekly digest.

## 5. The backend (propose first, wait for my OK)
Accounts, families, shared lists and notifications need a small backend, which GitHub Pages can't provide on its own. Before building:
- Propose the simplest option with a free tier that handles sign-in, the shared data and sending notifications, and works with our GitHub Pages app and GitHub Actions.
- Tell me what it costs now, what would make it cost money later, and where our data would be stored.
- Wait for my OK.
Security: keep all keys and secrets out of the public repo (use GitHub secrets). Each family can only see its own data. Store as little personal information as possible. Move the existing on-phone list and savings into the person's account on first sign-in, so nothing is lost.

## How to build it
Stop after each stage so I can test on my phone: (a) the designs applied to the existing screens; (b) the backend proposal; (c) accounts; (d) families and invites; (e) notifications. Keep the front end Capacitor-ready, and update the README, CLAUDE.md and decisions log as you go.
