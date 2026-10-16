// The screens, built to the Pantry Standard designs in docs/design. Reads and saves data only through data.js,
// and talks to the push service only through push.js, so a native (Capacitor) build or a shared family account
// can swap those without touching this file. Every price, saving and signal shown comes from the data; where
// there isn't enough yet, the screen says so.
import * as data from "./data.js";
import * as push from "./push.js";

const $ = (s, el = document) => el.querySelector(s);
const view = $("#view");
const APP_VERSION = "v3";

const TABS = { "this-week": "This Week", watchlist: "Watchlist", home: "Home", list: "List", savings: "Savings" };
// Screens on top of a tab. Alerts and Settings hide the tab bar (as in the designs); item detail keeps it.
const SUB_SCREENS = {
  watch: { tab: "watchlist", up: "#/watchlist", title: "Item Detail", tabs: true, brand: true },
  alerts: { tab: "home", up: "#/home", title: "Alerts", tabs: false },
  settings: { tab: null, up: "#/home", title: "Settings", tabs: false },
};
const TIER_ORDER = { core: 0, regular: 1, occasional: 2 };
const TIER_LABEL = { core: "Core", regular: "Regular", occasional: "Occasional" };
const TIER_SECTION = {
  core: ["Core Essentials", "The things we buy most often", ""],
  regular: ["Regular Pantry & Household", "Things we buy regularly", "sage"],
  occasional: ["Occasional", "Things we buy now and then", "sage"],
};
// Tiers come from our receipts (core: bought in 4+ of the shops, regular: 3, occasional: 2), so these stay modest.
const TIER_REASON = { core: "You buy this often", regular: "You buy this regularly", occasional: "You buy this now and then" };
const NOTE_TEXT = { paused: "Paused, so no prices", "not found": "No match yet", "no current price": "Matched, no current price" };
const BASIS_TEXT = { online: "Online price", "online, incl. delivery": "Online price incl. delivery" };
const FROM_TEXT = { github: "automatic", mac: "from our Mac", paused: "paused" };
const STORE_LETTER = { woolworths: "W", coles: "C", costco: "C", aldi: "A", chemistwarehouse: "+" };
// Chart lines: the cheapest store in terracotta, others in warm grey with dashes.
const DASHES = ["", "6 4", "2 4", "8 3 2 3", "4 2"];

const state = {
  watch: null, status: null, loadedAt: 0, offerToItem: new Map(), offersById: new Map(),
  query: "", searchSeq: 0, productsLoaded: false, filter: "all", dealsOnly: false,
  refs: new Map(), expanded: new Set(), scroll: new Map(), stack: [], pushOn: null,
};

// ------------------------------------------------------------------ formatting

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (c) => (c == null ? "no price" : "$" + (c / 100).toFixed(2));
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const icon = (name, cls = "") => `<span class="material-symbols-outlined ${cls}" aria-hidden="true">${name}</span>`;
const SYD = { timeZone: "Australia/Sydney" };
const day = (iso) => new Date(iso).toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short", ...SYD });
const weekday = (iso) => new Date(iso).toLocaleDateString("en-AU", { weekday: "short", ...SYD });
const dateTime = (iso) => new Date(iso).toLocaleString("en-AU", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", ...SYD });
const localDate = (ymd, year = false) => new Date(ymd + "T12:00:00").toLocaleDateString("en-AU", { day: "numeric", month: "short", ...(year ? { year: "numeric" } : {}) });
const href = (key) => `#/watch/${encodeURIComponent(key)}`;

/** "6.8¢" below a dollar, otherwise "$13.33". */
function amount(cents) {
  if (cents < 1) return cents.toFixed(2) + "¢";
  if (cents < 100) return cents.toFixed(1) + "¢";
  return money(cents);
}

/** "$13.33 / kg", "6.8¢ / tea bag", "$2.50 each". */
function unitMoney(cents, per) {
  if (cents == null) return "";
  return per === "item" ? `${amount(cents)} each` : `${amount(cents)} / ${per}`;
}

/** Big-number form: the amount, then a small "/kg". */
function unitBig(cents, per) {
  return `${amount(cents)}<small>${per === "item" ? " each" : "/" + esc(per)}</small>`;
}

const perPhrase = (per) => (per === "item" ? "per item" : `per ${per}`);

function listWords(names) {
  return names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function ago(iso) {
  const mins = Math.round((Date.now() - new Date(iso)) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (mins < 24 * 60) return `${Math.round(mins / 60)}h ago`;
  if (mins < 48 * 60) return "Yesterday";
  return day(iso);
}

// ------------------------------------------------------------------ offers and stores

/** The lowest unit price an offer gives (the multibuy price if there is one). */
function bestUnit(o) {
  const u = [o.multibuy_unit_cents, o.unit_cents].filter((x) => x != null);
  return u.length ? Math.min(...u) : null;
}

function byBestUnit(a, b) {
  const x = bestUnit(a), y = bestUnit(b);
  if (x == null || y == null) return (x == null) - (y == null) || (a.price_cents ?? 1e9) - (b.price_cents ?? 1e9);
  return x - y || b.special - a.special;
}

/** Stores that are paused for good (Coles) never count, whatever the settings say. */
function pausedChains() {
  return new Set((state.status?.stores || []).filter((s) => s.updates_from === "paused").map((s) => s.chain));
}

function comparedChains() {
  const off = new Set(data.getSettings().excludedChains);
  const paused = pausedChains();
  return new Set(state.watch.stores.map((s) => s.chain).filter((c) => !off.has(c) && !paused.has(c)));
}

const storeName = (chain) => state.watch.stores.find((s) => s.chain === chain)?.name || chain;

function offersIn(item, chains) {
  return item.offers.filter((o) => chains.has(o.chain)).sort(byBestUnit);
}

/** Only a saving the store's own prices show: was price minus price, or the multibuy price per item. */
function savingText(o) {
  if (o.was_cents && o.price_cents != null && o.was_cents > o.price_cents) {
    return `Save ${money(o.was_cents - o.price_cents)}${o.price_per === "kg" ? "/kg" : ""}`;
  }
  if (o.multibuy && o.price_cents != null && o.price_cents > o.multibuy.each_cents) {
    return `Save ${money(o.price_cents - o.multibuy.each_cents)} each on ${o.multibuy.qty}`;
  }
  return "";
}

/** Dollars saved buying one (or the multibuy number), from the store's own prices. Null when unknown. */
function savingCents(o) {
  if (o.price_cents == null || o.price_per === "kg") return null;
  if (o.was_cents && o.was_cents > o.price_cents) return o.was_cents - o.price_cents;
  if (o.multibuy && o.price_cents > o.multibuy.each_cents) return Math.round((o.price_cents - o.multibuy.each_cents) * o.multibuy.qty);
  return null;
}

function percentOff(o) {
  if (o.was_cents && o.price_cents != null && o.was_cents > o.price_cents) return Math.round(((o.was_cents - o.price_cents) / o.was_cents) * 100);
  if (o.multibuy && o.price_cents) return Math.round(((o.price_cents - o.multibuy.each_cents) / o.price_cents) * 100) || null;
  return null;
}

/** Every watch item with a special at the compared stores; `best` is its lowest unit price special. */
function specialRows(chains) {
  const rows = [];
  for (const item of state.watch.items) {
    const offers = offersIn(item, chains);
    const specials = offers.filter((o) => o.special);
    if (specials.length) rows.push({ item, offers, specials, best: specials[0] });
  }
  return rows.sort((a, b) => (TIER_ORDER[a.item.tier] ?? 9) - (TIER_ORDER[b.item.tier] ?? 9)
    || (percentOff(b.best) ?? 0) - (percentOff(a.best) ?? 0) || a.item.name.localeCompare(b.item.name));
}

function potential(rows) {
  let cents = 0, counted = 0;
  for (const r of rows) {
    const s = savingCents(r.best);
    if (s != null) { cents += s; counted += 1; }
  }
  return { cents, counted, uncounted: rows.length - counted };
}

const lowestSignal = (o) => (o.signals || []).find((s) => s.text.startsWith("Lowest in"));

function updatedAt(chains) {
  const times = (state.status?.stores || []).filter((s) => chains.has(s.chain) && s.last_updated).map((s) => s.last_updated).sort();
  return times[times.length - 1] || null;
}

function cycleText() {
  const start = state.watch.cycle_started;
  if (!start) return "";
  const end = new Date(start + "T12:00:00");
  end.setDate(end.getDate() + 6);
  return `${localDate(start)} – ${end.toLocaleDateString("en-AU", { day: "numeric", month: "short" })}`;
}

// ------------------------------------------------------------------ building blocks

function thumb(o, cls = "", link = null) {
  const inner = o?.image ? `<img loading="lazy" src="${esc(o.image)}" alt="">` : icon("shopping_basket");
  return link ? `<a class="thumb ${cls}" href="${link}" tabindex="-1" aria-hidden="true">${inner}</a>`
    : `<span class="thumb ${cls}">${inner}</span>`;
}

const storeTag = (chain, name) => `<span class="store-tag c-${esc(chain)}">${esc(name || storeName(chain))}</span>`;

function priceLine(o, deal = o.special) {
  const pct = percentOff(o);
  return `<div class="priceline">
    <span class="price${deal ? " deal" : ""}">${money(o.price_cents)}${o.price_per === "kg" ? "<small>/kg</small>" : ""}</span>
    ${o.was_cents ? `<span class="was">${money(o.was_cents)}</span>` : ""}
    ${pct && o.was_cents ? `<span class="pct">-${pct}%</span>` : ""}
    ${o.rrp_cents && !o.was_cents ? `<span class="unit">RRP ${money(o.rrp_cents)}</span>` : ""}</div>`;
}

/** The one signal at the top of a deal card: lowest in N weeks, the store's promo, or the saving. */
function headPill(o) {
  const lowest = lowestSignal(o);
  if (lowest) return `<span class="pill amber">${icon("history")}${esc(lowest.text)}</span>`;
  const promo = (o.signals || []).find((s) => s.kind === "promo");
  if (promo) return `<span class="pill sage">${icon("percent")}${esc(promo.text.replace("Multibuy deal: ", ""))}</span>`;
  const save = savingText(o);
  if (save) return `<span class="pill sage"><span class="dot"></span>${esc(save)}</span>`;
  return `<span class="pill sage"><span class="dot"></span>${esc(o.promo || "On special")}</span>`;
}

/** The other signals, smaller, under the card. Only what the data supports. */
function morePills(o, { skipLowest = true, history = true } = {}) {
  const out = [];
  if (o.new_this_cycle === true) out.push(`<span class="pill terra">${icon("local_fire_department")}New this week</span>`);
  for (const s of o.signals || []) {
    if (s.kind === "target") out.push(`<span class="pill sage">${icon("verified")}${esc(s.text)}</span>`);
    if (s.kind === "warning") out.push(`<span class="pill warn">${icon("warning")}${esc(s.text)}</span>`);
    if (s.kind === "history" && history && !(skipLowest && s.text.startsWith("Lowest in"))) out.push(`<span class="pill muted">${icon("history")}${esc(s.text)}</span>`);
  }
  if (!o.special && o.promo) out.push(`<span class="pill outline">${esc(o.promo)}</span>`);
  if (o.in_stock === false) out.push(`<span class="pill muted">Out of stock online</span>`);
  if (BASIS_TEXT[o.basis]) out.push(`<span class="pill outline">${BASIS_TEXT[o.basis]}</span>`);
  return out.length ? `<div class="pills">${out.join("")}</div>` : "";
}

function endsText(o) {
  if (o.valid_from && new Date(o.valid_from) > new Date()) return `From ${weekday(o.valid_from)}`;
  if (!o.valid_to) return "";
  return o.valid_to_assumed ? `Usually ends ${weekday(o.valid_to)}` : `Ends ${day(o.valid_to)}`;
}

function multibuyLine(o, unit) {
  if (!o.multibuy) return "";
  return `<p class="body-sm t2" style="margin-top:4px"><b class="mono">${o.multibuy.qty} for ${money(o.multibuy.cents)}</b>
    = ${money(o.multibuy.each_cents)} each${unit ? ` · <span class="mono">${unit}</span>` : ""}</p>`;
}

function ref(item, offer) {
  const id = String(state.refs.size + 1);
  state.refs.set(id, { item, offer });
  return id;
}

const onList = (offer) => data.getList().items.some((x) => x.id === offer.id);

function addRound(item, o, cls = "") {
  const added = onList(o);
  return `<button type="button" class="add ${cls}${added ? " added" : ""}" data-action="add" data-ref="${ref(item, o)}"
    aria-label="Add ${esc(item ? item.name : o.name)} to list">${icon(added ? "check" : "add")}</button>`;
}

function errorHTML(e) {
  return `<div class="empty">${icon("error")}<b>Couldn't load prices</b><p>${esc(e.message)}</p>
    <p style="margin:6px 0 14px">Check your connection and try again.</p>
    <button type="button" class="btn secondary small" data-action="retry">${icon("sync")}Try again</button></div>`;
}

/** The list total at today's prices where we have them (else the price when added). Per-kg items can't be totalled. */
function listTotal(items) {
  let cents = 0, perKg = 0, unpriced = 0;
  for (const x of items) {
    const now = state.offersById.get(x.offerId);
    const price = now ? now.price_cents : x.price_cents;
    const mb = now ? now.multibuy : x.multibuy;
    if (price == null) { unpriced += 1; continue; }
    if ((now ? now.price_per : x.price_per) === "kg") { perKg += 1; continue; }
    cents += mb && x.qty >= mb.qty ? Math.floor(x.qty / mb.qty) * mb.cents + (x.qty % mb.qty) * price : x.qty * price;
  }
  return { cents, perKg, unpriced };
}

/** Savings on the list as it stands: each listed product that's on special now, at its quantity. */
function listSaving(items) {
  let cents = 0;
  for (const x of items) {
    const o = state.offersById.get(x.offerId);
    if (!o || !o.special || o.price_cents == null || o.price_per === "kg") continue;
    if (o.was_cents && o.was_cents > o.price_cents) cents += (o.was_cents - o.price_cents) * x.qty;
    else if (o.multibuy && x.qty >= o.multibuy.qty) cents += Math.floor(x.qty / o.multibuy.qty) * (o.multibuy.qty * o.price_cents - o.multibuy.cents);
  }
  return cents;
}

// ------------------------------------------------------------------ Home

function greeting() {
  const h = Number(new Date().toLocaleString("en-AU", { hour: "numeric", hour12: false, ...SYD }));
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

function renderHome() {
  const chains = comparedChains();
  const rows = specialRows(chains);
  const list = data.getList();
  const onListItems = new Set(list.items.map((x) => x.watchKey).filter(Boolean));
  const upd = updatedAt(chains);

  // 1. Potential savings, and how much of it is already on the list.
  const pot = potential(rows);
  const listed = { cents: listSaving(list.items) };
  const share = pot.cents ? Math.min(100, Math.round((listed.cents / pot.cents) * 100)) : 0;
  const savings = rows.length ? `<a class="digest tap" href="#/this-week">
      <div class="row" style="align-items:flex-start">
        <div class="grow">
          <span class="pill terra caps">${icon("local_fire_department")}Potential savings</span>
          <h2>${pot.counted ? `Save up to <span class="num-lg">${money(pot.cents)}</span> this week`
            : `${plural(rows.length, "watched item")} on special this week`}</h2>
          <p class="body-sm t2">${plural(rows.length, "item")} from your watchlist ${rows.length === 1 ? "is" : "are"} on special${pot.counted && pot.uncounted ? ` (${pot.uncounted} with no was price, not counted)` : ""}.</p>
        </div>
        <span class="digest-icon">${icon("savings")}</span>
      </div>
      ${pot.counted ? `<div class="progress" aria-hidden="true"><span style="width:${share}%"></span></div>
        <div class="row" style="margin-top:6px"><span class="body-sm t2">${listed.cents ? `<b class="mono" style="color:var(--text)">${money(listed.cents)}</b> in savings on your list` : "Add specials to your list to lock them in"}</span>
          <span class="num-sm t3">${share}%</span></div>` : ""}
      <p class="body-sm t3" style="margin-top:10px">Estimate from each store's was price, buying one of each (or the multibuy number).</p>
    </a>` : `<a class="digest tap" href="#/watchlist">
      <span class="pill terra caps">${icon("local_fire_department")}Potential savings</span>
      <h2>Nothing on your watchlist is on special</h2>
      <p class="body-sm t2">at the stores you compare right now. Specials refresh each Wednesday.</p></a>`;

  // 2. New on special this week: only specials we can confirm are new (we read the product the week before).
  const fresh = rows.map((r) => {
    const offer = r.specials.find((o) => o.new_this_cycle === true);
    return offer ? { ...r, offer } : null;
  }).filter(Boolean).sort((a, b) => (savingCents(b.offer) ?? 0) - (savingCents(a.offer) ?? 0)).slice(0, 5);
  const unsure = rows.filter((r) => !r.specials.some((o) => o.new_this_cycle === true)
    && r.specials.some((o) => o.new_this_cycle == null)).length;
  const freshCard = `<section class="card rows">
    ${fresh.map(({ item, offer, best }) => {
      const better = bestUnit(best) != null && bestUnit(offer) != null && bestUnit(best) < bestUnit(offer);
      return `<div class="mini">${thumb(offer, "sm", href(item.key))}
        <div class="grow">
          <a class="deal-name truncate" href="${href(item.key)}">${esc(item.name)}</a>
          <div class="tagline">${storeTag(offer.chain, offer.store)}
            <span class="num-md" style="color:var(--terracotta)">${money(offer.price_cents)}</span>
            ${offer.was_cents ? `<span class="was">${money(offer.was_cents)}</span>` : ""}</div>
          ${savingText(offer) ? `<div class="pills" style="margin-top:6px"><span class="pill sage"><span class="dot"></span>${esc(savingText(offer))}</span></div>` : ""}
          ${better ? `<p class="body-sm t3" style="margin-top:4px">Better value on another special: <span class="mono">${unitMoney(bestUnit(best), item.compare_per)}</span></p>` : ""}
        </div>${addRound(item, offer, "sm")}</div>`;
    }).join("") || `<div class="mini"><p class="body-sm t2">Nothing we can confirm is new this week yet.</p></div>`}
    ${unsure ? `<div class="mini"><p class="body-sm t3">${icon("history", "t3")} ${plural(unsure, "more item")} on special we can't call new yet:
      it's the first week we've read ${unsure === 1 ? "it" : "them"}. This fills in after next Wednesday's update.</p></div>` : ""}
  </section>`;

  // 3. Recently added to the list.
  const recent = [...list.items].sort((a, b) => (b.addedAt || "").localeCompare(a.addedAt || "")).slice(0, 5);
  const t = listTotal(list.items);
  const listCard = list.items.length ? `<a class="card tap rows" href="#/list">
      ${recent.map((x) => `<div class="mini">
        <div class="grow"><p class="title-sm truncate">${esc(x.name)}</p>
          <div class="tagline">${x.chain ? storeTag(x.chain, x.store) : ""}${x.qty > 1 ? `<span class="pill muted mono">× ${x.qty}</span>` : ""}</div></div>
        <span class="num-md">${money(x.price_cents)}${x.price_per === "kg" ? '<small class="per">/kg</small>' : ""}</span></div>`).join("")}
      <div class="mini"><div class="grow"><p class="title-sm">List total</p>
          <p class="body-sm t3">${plural(list.items.length, "item")}${t.perKg ? `, plus ${t.perKg} priced per kg` : ""}${t.unpriced ? `, ${t.unpriced} with no price` : ""} · estimate at today's prices</p></div>
        <span class="price">${money(t.cents)}</span></div>
    </a>` : `<section class="card"><div class="row"><div class="grow"><p class="title-sm">Nothing on your list yet</p>
      <p class="body-sm t2" style="margin-top:2px">Tap ${icon("add", "terracotta")} on a special to start it.</p></div>
      <span class="digest-icon" style="width:40px;height:40px">${icon("checklist")}</span></div></section>`;

  // 4. Recommended: watched items (from our receipts) on special now, not on the list, not already shown above.
  const shown = new Set(fresh.map((r) => r.item.key));
  const recs = rows.filter((r) => !shown.has(r.item.key) && !onListItems.has(r.item.key)).slice(0, 5);
  const recCard = `<section class="card rows">
    ${recs.map(({ item, best }) => {
      const kg = best.price_per === "kg" ? "/kg" : "";
      const why = best.usual_cents && best.usual_cents > best.price_cents ? `On special, usually ${money(best.usual_cents)}${kg}`
        : best.was_cents ? `On special, was ${money(best.was_cents)}${kg}`
        : best.multibuy ? `Multibuy: ${best.multibuy.qty} for ${money(best.multibuy.cents)}` : "On special";
      return `<div class="mini">${thumb(best, "sm", href(item.key))}
        <div class="grow">
          <a class="deal-name truncate" href="${href(item.key)}">${esc(item.name)}</a>
          <p class="body-sm t2" style="margin-top:2px">${esc(TIER_REASON[item.tier] || "On your watchlist")} · ${esc(why)}</p>
          <div class="tagline">${storeTag(best.chain, best.store)}<span class="num-md" style="color:var(--terracotta)">${money(best.price_cents)}${kg ? '<small class="per">/kg</small>' : ""}</span></div>
        </div>${addRound(item, best, "sm")}</div>`;
    }).join("") || `<div class="mini"><p class="body-sm t2">Nothing else to suggest right now.</p></div>`}
    <div class="mini"><p class="body-sm t3">Suggestions only come from your watchlist, which was built from your receipts. Items
      you're due to buy again will show here once the List records what you buy.</p></div>
  </section>`;

  // 5. Family (fills in when family accounts arrive).
  const hh = data.getHousehold();
  const familyCard = `<section class="card">
    <div class="row" style="justify-content:flex-start;gap:12px">
      ${hh.members.map((m) => `<span class="digest-icon" style="width:40px;height:40px;border-radius:50%;background:var(--terracotta);color:#fff;font-weight:700">${esc(m.name[0])}</span>`).join("")}
      <div class="grow"><p class="title-sm">${hh.members.length === 1 ? "Just you for now" : esc(listWords(hh.members.map((m) => m.name)))}</p>
        <p class="body-sm t2">Share one list with the family when accounts arrive.</p></div></div>
    <div class="row" style="margin-top:14px">
      <button type="button" class="btn outline small" disabled>${icon("person_add")}Invite family</button>
      ${hh.canInvite ? "" : `<span class="pill muted caps">Coming soon</span>`}</div>
  </section>`;

  view.innerHTML = `
    <div class="context">
      <div><div class="live caps"><span class="dot"></span>Week of ${esc(cycleText())}</div>
        <h2 class="headline-lg" style="margin-top:4px">${greeting()}</h2>
        <p class="body-sm t2">${upd ? `Prices updated ${esc(dateTime(upd))}` : "Prices not updated yet"}</p></div>
    </div>
    ${savings}
    <div class="section-head"><h2 class="headline-sm">New on special this week</h2><a href="#/this-week">See all</a></div>
    ${freshCard}
    <div class="section-head"><h2 class="headline-sm">Recently added to the list</h2>${list.items.length ? `<a href="#/list">Open list</a>` : ""}</div>
    ${listCard}
    <div class="section-head"><h2 class="headline-sm">Recommended to add</h2></div>
    ${recCard}
    <div class="section-head"><h2 class="headline-sm">Family</h2></div>
    ${familyCard}`;
}

// ------------------------------------------------------------------ This Week

function dealCard({ item, offers, specials, best }) {
  const bu = bestUnit(best);
  const normal = offers.find((o) => !o.special && bestUnit(o) != null);
  const cheaper = bu != null && normal && bestUnit(normal) < bu
    ? `<p class="hint">Cheaper without a special: <b>${unitMoney(bestUnit(normal), item.compare_per)}</b> at ${esc(normal.store)} (${esc(normal.name)})</p>` : "";
  const more = specials.length - 1;
  const unit = best.unit_cents != null ? unitMoney(best.unit_cents, item.compare_per) : `can't compare ${perPhrase(item.compare_per)}`;
  return `<article class="card deal">
    <div class="row">${headPill(best)}<span class="caps t3">${esc(endsText(best) || TIER_LABEL[item.tier] || "")}</span></div>
    <div class="deal-body">
      ${thumb(best, "", href(item.key))}
      <div class="grow">
        <a class="deal-name clamp2" href="${href(item.key)}">${esc(item.name)}</a>
        <p class="product truncate">${esc(best.name)}</p>
        <div class="tagline">${storeTag(best.chain, best.store)}<span class="unit">${esc(unit)}</span></div>
        ${priceLine(best)}
        ${multibuyLine(best, unitMoney(best.multibuy_unit_cents, item.compare_per))}
      </div>
      ${addRound(item, best)}
    </div>
    ${morePills(best)}
    ${cheaper}
    <a class="deal-foot" href="${href(item.key)}"><span>${more ? `+${plural(more, "more special")} · ` : ""}All stores and price history</span>${icon("chevron_right")}</a>
  </article>`;
}

function renderThisWeek() {
  const chains = comparedChains();
  const all = specialRows(chains);
  const paused = [...pausedChains()];
  const pot = potential(all);
  const upd = updatedAt(chains);
  const filters = [
    ["all", "All Specials", all],
    ["new", "New this week", all.filter((r) => r.specials.some((o) => o.new_this_cycle === true))],
    ["lowest", "Lowest in weeks", all.filter((r) => r.specials.some(lowestSignal))],
    ["core", "Core Essentials", all.filter((r) => r.item.tier === "core")],
    ["regular", "Regulars", all.filter((r) => r.item.tier === "regular")],
  ].filter(([k, , rows]) => k === "all" || rows.length);
  if (!filters.some(([k]) => k === state.filter)) state.filter = "all";
  const rows = filters.find(([k]) => k === state.filter)[2];

  // Store counts for the digest: where each item's best special is.
  const byStore = new Map();
  for (const r of all) byStore.set(r.best.chain, (byStore.get(r.best.chain) || 0) + 1);

  view.innerHTML = `
    <div class="context">
      <div><div class="live caps"><span class="dot"></span>Weekly specials cycle</div>
        <p class="body-sm t2" style="margin-top:2px">${upd ? `Updated ${esc(dateTime(upd))}` : "Not updated yet"} · Week of ${esc(cycleText())}</p></div>
    </div>
    <a class="digest tap" href="#/watchlist">
      <div class="row" style="align-items:flex-start">
        <div class="grow">
          <span class="pill terra caps">${icon("local_fire_department")}Pantry digest</span>
          <h2>${all.length ? `${plural(all.length, "item")} on special${pot.counted ? `, save up to <span class="num-lg">${money(pot.cents)}</span>` : ""}`
            : "Nothing on special this week"}</h2>
          <p class="body-sm t2">Matched against the ${plural(state.watch.items.length, "thing")} on your watchlist.</p>
        </div>
        <span class="digest-icon">${icon("savings")}</span>
      </div>
      <div class="digest-foot">
        ${[...byStore].map(([c, n]) => `<span class="store-count c-${c}"><span class="dot"></span>${n} ${esc(storeName(c))}</span>`).join("")}
        ${paused.map((c) => `<span class="store-count c-${c}">${icon("pause_circle")}${esc(storeName(c))} paused</span>`).join("")}
      </div>
    </a>
    ${all.length ? `<div class="filters" role="toolbar" aria-label="Filter specials">
      ${filters.map(([k, label, r]) => `<button type="button" class="filter" data-action="filter" data-filter="${k}"
        aria-pressed="${state.filter === k}">${k === "lowest" ? '<span class="dot"></span>' : ""}${esc(label)}<span class="count">${r.length}</span></button>`).join("")}
    </div>` : ""}
    <div class="stack">${rows.map(dealCard).join("") || `<div class="empty">${icon("local_offer")}<b>None of your watched items are on special</b>
      at the stores you compare. <a class="link" href="#/watchlist">See the watchlist</a></div>`}</div>`;
}

// ------------------------------------------------------------------ Watchlist and search

function renderWatchlist() {
  const chains = comparedChains();
  const rows = specialRows(chains);
  const pot = potential(rows);
  const groups = new Map();
  for (const item of state.watch.items) {
    if (state.dealsOnly && !offersIn(item, chains).some((o) => o.special)) continue;
    if (!groups.has(item.tier)) groups.set(item.tier, []);
    groups.get(item.tier).push(item);
  }
  const sections = [...groups].sort(([a], [b]) => (TIER_ORDER[a] ?? 9) - (TIER_ORDER[b] ?? 9)).map(([tier, items]) => {
    const [title, sub, dot] = TIER_SECTION[tier] || [tier, "", ""];
    return `<section>
      <div class="section-head" style="margin-top:8px"><div><div class="title"><span class="dot ${dot}"></span><h3 class="headline-sm">${esc(title)}</h3></div>
        <p class="body-sm t2">${esc(sub)}</p></div><span class="caps t3" style="margin-top:4px">${plural(items.length, "item")}</span></div>
      <div class="stack-sm" style="margin-top:10px">${items.map((i) => watchRow(i, chains)).join("")}</div></section>`;
  }).join("");

  view.innerHTML = `
    <div class="row" style="padding-top:8px">
      <div class="row" style="justify-content:flex-start"><h2 class="headline-lg">Watchlist</h2>
        <span class="pill muted caps">${plural(state.watch.items.length, "item")}</span></div>
      <button type="button" class="chip-btn" data-action="deals-only" aria-pressed="${state.dealsOnly}">${icon("local_offer")}Deals only</button>
    </div>
    <form class="search" role="search" id="search-form">${icon("search")}
      <input id="q" type="search" placeholder="Search specials or add an item" enterkeyhint="search" autocomplete="off"
        autocorrect="off" spellcheck="false" aria-label="Search products" value="${esc(state.query)}">
    </form>
    <div id="results" class="stack" hidden></div>
    <div id="watched" class="stack">
      ${rows.length ? `<a class="callout tap" href="#/this-week">
        <div class="row" style="justify-content:flex-start;gap:12px"><span class="callout-icon">${icon("trending_down")}</span>
          <div><p class="title-sm">${plural(rows.length, "special")} on your watchlist this week</p>
            ${pot.counted ? `<p class="body-sm">Potential basket saving: <b class="mono">${money(pot.cents)}</b></p>` : ""}</div></div>
        ${icon("notifications_active", "t2")}</a>` : ""}
      ${sections || `<div class="empty">${icon("local_offer")}<b>Nothing on special right now</b>Turn off "Deals only" to see everything.</div>`}
      <p class="note">New items are added to the watchlist on our Mac for now. Search for a product and tap
        "Suggest to watch" to send a request.</p>
    </div>`;
  let timer;
  $("#q").addEventListener("input", (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => { state.query = e.target.value; renderResults(); }, 200);
  });
  $("#search-form").addEventListener("submit", (e) => { e.preventDefault(); $("#q").blur(); });
  if (state.query.trim()) renderResults();
}

function watchRow(item, chains) {
  const offers = offersIn(item, chains);
  const special = offers.find((o) => o.special);
  const shown = special || offers[0];
  const bu = shown && bestUnit(shown);
  return `<a class="watch-row tap" href="${href(item.key)}">
    <span class="tile${special ? " special" : ""}">${shown?.image ? `<img loading="lazy" src="${esc(shown.image)}" alt="">` : icon("shopping_basket")}</span>
    <div class="grow">
      <div class="line"><p class="title-sm truncate">${esc(item.name)}${special ? ' <span class="dot sm" style="vertical-align:middle"></span>' : ""}</p>
        ${shown ? `<span class="num-md" style="flex:none;${special ? "color:var(--terracotta)" : ""}">${bu != null ? unitBig(bu, item.compare_per) : money(shown.price_cents)}</span>` : ""}</div>
      <div class="line"><p class="body-sm t2 truncate">${shown ? `Matched: ${esc(shown.name)}` : "No match yet at the stores you compare"}</p>
        ${special ? `<span class="pill sage" style="flex:none"><span class="dot"></span>On special</span>`
          : shown ? `<span class="pill muted" style="flex:none">Normal price</span>` : ""}</div>
    </div></a>`;
}

async function renderResults() {
  const box = $("#results"), watched = $("#watched");
  if (!box) return;
  const q = state.query.trim();
  box.hidden = !q;
  watched.hidden = !!q;
  if (!q) return;
  const seq = ++state.searchSeq;
  if (!state.productsLoaded) box.innerHTML = `<p class="note">Loading all products…</p>`;
  try {
    const limit = 40;
    const results = await data.searchProducts(q, { chains: [...comparedChains()], limit });
    state.productsLoaded = true;
    if (seq !== state.searchSeq) return;
    box.innerHTML = `<p class="body-sm t2">${results.length >= limit ? `Top ${limit}` : results.length} ${results.length === 1 ? "product" : "products"}.
        Searches the store categories your watched items are in.</p>` +
      (results.map(productHTML).join("") || `<div class="empty">${icon("search")}<b>Nothing found</b>Try a shorter word.</div>`);
  } catch (e) {
    if (seq === state.searchSeq) box.innerHTML = errorHTML(e);
  }
}

function productHTML(p) {
  const item = state.offerToItem.get(p.id);
  const r = ref(null, p);
  const unit = p.unit ? unitMoney(p.unit.cents, p.unit.per) : "";
  return `<article class="card deal">
    ${p.special ? `<div class="row">${headPill(p)}<span class="caps t3">${esc(endsText(p))}</span></div>` : ""}
    <div class="deal-body">
      ${thumb(p)}
      <div class="grow">
        <a class="deal-name clamp2" href="${esc(p.url || "#")}" target="_blank" rel="noopener">${esc(p.name)}</a>
        <div class="tagline">${storeTag(p.chain, p.store)}${unit ? `<span class="unit">${esc(unit)}</span>` : ""}</div>
        ${priceLine(p)}
        ${multibuyLine(p, p.multibuy?.unit ? unitMoney(p.multibuy.unit.cents, p.multibuy.unit.per) : "")}
      </div>
    </div>
    ${morePills(p)}
    <div class="actions">
      <button type="button" class="btn small${onList(p) ? " added" : ""}" data-action="add" data-ref="${r}">${icon(onList(p) ? "check" : "add")}${onList(p) ? "On your list" : "Add to list"}</button>
      ${item ? `<a class="btn outline small" href="${href(item.key)}">${icon("bookmark")}Watched</a>`
        : `<button type="button" class="btn outline small" data-action="suggest" data-ref="${r}">${icon("bookmark_add")}Suggest to watch</button>`}
    </div></article>`;
}

async function suggest(p) {
  const [chain, ...rest] = p.id.split(":");
  const text = `Can we watch this? ${p.name} (${p.store}, ${money(p.price_cents)})\n${p.url || ""}\n\n` +
    `On the Mac: uv run specials watch add ${chain} ${rest.join(":")}`;
  if (navigator.share) {
    try {
      await navigator.share({ title: "Watch this?", text });
      return;
    } catch (e) {
      if (e.name === "AbortError") return;
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied. Paste it into a message.");
  } catch {
    toast("Couldn't share from this browser.");
  }
}

// ------------------------------------------------------------------ one watch item

function renderDetail(key) {
  const item = state.watch.items.find((i) => i.key === key);
  if (!item) {
    view.innerHTML = `<div class="empty">${icon("bookmark")}<b>Not on the watchlist any more</b><a class="link" href="#/watchlist">Back to the watchlist</a></div>`;
    return;
  }
  const chains = comparedChains();
  const offers = offersIn(item, chains);
  const special = offers.find((o) => o.special);
  const best = special || offers.find((o) => bestUnit(o) != null) || offers[0];
  const settingsOff = new Set(data.getSettings().excludedChains);
  const paused = pausedChains();
  const prev = state.stack[state.stack.length - 2];
  const backLabel = prev && TABS[prev.replace("#/", "")] ? TABS[prev.replace("#/", "")] : "Watchlist";
  const upd = updatedAt(chains);

  // The current best deal.
  const dealCardHTML = best ? `<section class="card stack-sm">
      <div class="row">
        ${best.special ? `<span class="pill sage caps">${icon("local_offer", "fill")}On special</span>` : `<span class="pill muted caps">Normal price</span>`}
        ${endsText(best) ? `<span class="pill" style="background:var(--panel)">${icon("schedule", "terracotta")}${esc(endsText(best))}</span>` : ""}
      </div>
      <div class="priceline" style="margin-top:2px">
        <span class="price${best.special ? " deal" : ""}" style="font-size:26px;line-height:30px">${money(best.price_cents)}${best.price_per === "kg" ? "<small>/kg</small>" : ""}</span>
        ${best.was_cents ? `<span class="was" style="font-size:13px">${money(best.was_cents)}</span>` : ""}
        ${savingText(best) ? `<span class="pill terra" style="margin-left:auto">${esc(savingText(best))}</span>` : ""}
      </div>
      ${multibuyLine(best, unitMoney(best.multibuy_unit_cents, item.compare_per))}
      <div class="tagline">
        ${best.unit_cents != null ? `<span class="num-sm" style="background:var(--panel);padding:3px 8px;border-radius:4px;color:var(--text)">${esc(unitMoney(best.unit_cents, item.compare_per))}</span><span class="t3">•</span>` : ""}
        ${storeTag(best.chain, best.store)}<span class="body-sm t2 truncate" style="min-width:0;flex:1">${esc(best.name)}</span>
      </div>
      ${morePills(best, { history: false })}
    </section>` : "";

  // The buy-now signal, only from what the data supports.
  const sig = best ? best.signals || [] : [];
  const lowest = best && lowestSignal(best);
  const target = sig.find((s) => s.kind === "target");
  const usually = sig.find((s) => s.text === "Usually cheaper on special");
  const started = state.watch.history_started;
  const signal = lowest || target
    ? `<section class="signal"><span class="signal-icon">${icon("thumb_up")}</span><div>
        <p class="title-sm">${esc((lowest || target).text)} ${icon("verified")}</p>
        <p>${lowest ? `The lowest price we've recorded for this product at ${esc(best.store)}.` : `It's at or below your target of <b>${unitMoney(item.target_cents, item.compare_per)}</b>.`}</p></div></section>`
    : `<section class="signal neutral"><span class="signal-icon">${icon(usually ? "schedule" : "history")}</span><div>
        <p class="title-sm">${usually ? "Usually cheaper on special" : "Not enough history yet"}</p>
        <p>${usually ? "It's been on special in the last 12 weeks. We never guess when the next special will be."
          : `We started recording prices on ${started ? esc(localDate(started, true)) : "5 Oct 2026"}. "Lowest in N weeks" needs ${state.watch.min_history_weeks} weeks of history. We never guess when the next special will be.`}</p></div></section>`;

  // Stores, in priority order.
  const storeRows = state.watch.stores.map(({ chain, name }) => {
    const tile = `<span class="store-tile c-${chain}">${STORE_LETTER[chain] || name[0]}</span>`;
    if (paused.has(chain)) {
      return `<div class="store-row dim"><div class="row" style="justify-content:flex-start;gap:12px">${tile}
        <div><div class="row" style="justify-content:flex-start;gap:6px"><span class="title-sm t2">${esc(name)}</span><span class="store-label c-${chain}">Paused</span></div>
        <span class="body-sm t3">Blocked our reads, so no prices</span></div></div>
        <span class="caps t3 row" style="gap:4px">${icon("pause_circle")}Paused</span></div>`;
    }
    if (settingsOff.has(chain)) {
      return `<div class="store-row dim"><div class="row" style="justify-content:flex-start;gap:12px">${tile}
        <div><span class="title-sm t2">${esc(name)}</span><br><span class="body-sm t3">Switched off in Settings</span></div></div></div>`;
    }
    const mine = offers.filter((o) => o.chain === chain);
    if (!mine.length) {
      return `<div class="store-row dim"><div class="row" style="justify-content:flex-start;gap:12px">${tile}
        <div><span class="title-sm t2">${esc(name)}</span><br><span class="body-sm t3">${esc(NOTE_TEXT[item.stores_note[chain]] || "No match yet")}</span></div></div>
        <span class="pill muted">No match yet</span></div>`;
    }
    const top = mine[0];
    const k = `${key}|${chain}`;
    const open = state.expanded.has(k);
    const save = savingText(top);
    return `<div class="stack-sm" style="gap:6px">
      <button type="button" class="store-row" data-action="more" data-key="${esc(k)}" aria-expanded="${open}">
        <span class="row" style="justify-content:flex-start;gap:12px;min-width:0">${tile}
          <span style="min-width:0"><span class="row" style="justify-content:flex-start;gap:6px"><span class="title-sm">${esc(name)}</span>
            ${top.special ? `<span class="store-label c-${chain}">Special</span>` : ""}</span>
          <span class="body-sm t3 truncate" style="display:block">${esc(top.name)}${mine.length > 1 ? ` · ${plural(mine.length, "product")}` : ""}</span></span></span>
        <span style="text-align:right;flex:none"><span class="num-md" style="display:block">${bestUnit(top) != null ? unitBig(bestUnit(top), item.compare_per) : money(top.price_cents)}</span>
          ${save ? `<span class="micro" style="color:var(--sage)">${esc(save)}</span>` : `<span class="micro t3">${money(top.price_cents)}</span>`}</span>
      </button>
      ${open ? `<div class="offers">${mine.map((o) => `<div class="offer-row">${thumb(o, "sm")}
          <div class="grow"><a class="body-sm clamp2" href="${esc(o.url || "#")}" target="_blank" rel="noopener" style="font-weight:600;text-decoration:none">${esc(o.name)}</a>
            <div class="tagline"><span class="num-md${o.special ? " terracotta" : ""}">${money(o.price_cents)}${o.price_per === "kg" ? '<small class="per">/kg</small>' : ""}</span>
              ${o.was_cents ? `<span class="was">${money(o.was_cents)}</span>` : ""}
              <span class="unit">${o.unit_cents != null ? esc(unitMoney(o.unit_cents, item.compare_per)) : ""}</span></div>
            ${o.special ? `<div class="pills" style="margin-top:4px">${headPill(o)}</div>` : ""}</div>
          ${addRound(item, o, "sm")}</div>`).join("")}</div>` : ""}
    </div>`;
  }).join("");

  view.innerHTML = `
    <div class="row" style="padding-top:4px">
      <button type="button" class="back-pill" data-action="back">${icon("arrow_back")}<span>${esc(backLabel)}</span></button>
      <span class="pill sage">${upd ? `<span class="dot"></span>Updated ${esc(day(upd))}` : "Not updated yet"}</span>
    </div>
    <section class="card">
      <div class="row" style="justify-content:flex-start;align-items:flex-start;gap:16px">
        <span class="thumb lg">${best?.image ? `<img src="${esc(best.image)}" alt="">` : icon("shopping_basket")}${best?.size ? `<span class="size">${esc(best.size)}</span>` : ""}</span>
        <div class="grow">
          <div class="row" style="justify-content:flex-start;gap:8px;margin-bottom:4px">
            <span class="store-tag">${esc(TIER_LABEL[item.tier] || "")}</span>
            <span class="micro t3">${item.level === "similar" ? "Similar items" : item.level === "exact" ? "Exact product" : "Same product"}</span></div>
          <h2 class="headline-md">${esc(item.name)}</h2>
          <p class="body-sm t2" style="margin-top:2px">${esc(item.rule)}</p>
          <p class="body-sm t3" style="margin-top:2px">Compared ${perPhrase(item.compare_per)}${item.target_cents ? ` · your target ${unitMoney(item.target_cents, item.compare_per)}` : ""}</p>
        </div>
      </div>
    </section>
    ${dealCardHTML}
    ${signal}
    <section class="card chart-card">${chartHTML(item, chains)}</section>
    <div class="row" style="padding:0 4px;margin-top:20px"><h3 class="title-sm">Prices by Store</h3><span class="body-sm t3">Tap a store for every product</span></div>
    <div class="stack-sm" style="margin-top:10px">${storeRows}</div>
    ${best ? `<button type="button" class="btn block" data-action="add" data-ref="${ref(item, best)}" style="margin-top:20px">
      ${icon(onList(best) ? "check" : "add")}${onList(best) ? "On your shopping list" : "Add to Shopping List"}</button>` : ""}
    <p class="note">Specials and their dates come from each store. Targets and watch rules are changed on our Mac for now.</p>`;
}

/** Weekly lowest unit price at each store. Filled (sage) points are weeks it was on special. */
function chartHTML(item, chains) {
  const h = item.history;
  const started = state.watch.history_started;
  const series = state.watch.stores.filter((s) => chains.has(s.chain) && (h.series[s.chain] || []).some((v) => v != null));
  const n = h.weeks.length;
  const range = n ? `${localDate(h.weeks[0])} – now · ${plural(n, "week")}` : "No weeks yet";
  const vals = series.flatMap((s) => h.series[s.chain]).filter((v) => v != null);
  // The average is for one store over the weeks (the cheapest now), and only once there are 2 weeks to average.
  const lastOf = (c) => { const v = h.series[c].filter((x) => x != null); return v[v.length - 1]; };
  const cheapest = [...series].sort((a, b) => lastOf(a.chain) - lastOf(b.chain))[0];
  const own = cheapest ? h.series[cheapest.chain].filter((v) => v != null) : [];
  const head = `<div class="row" style="align-items:flex-start"><div><h3 class="title-md">Price History</h3>
      <p class="body-sm t2">${esc(range)}</p></div>
      ${own.length > 1 ? `<span class="pill mono" style="background:var(--panel)">Avg ${esc(amount(own.reduce((a, b) => a + b, 0) / own.length))} · ${esc(cheapest.name)}</span>` : ""}</div>`;
  const foot = `<p class="body-sm t3" style="margin-top:10px">Lowest price ${perPhrase(item.compare_per)} each week.
    ${started ? `History started ${localDate(started, true)}.` : ""} "Lowest in N weeks" shows once we have ${state.watch.min_history_weeks} weeks.</p>`;
  if (!n || !series.length) return head + `<p class="body-sm t2" style="margin-top:12px">No price history yet at the stores you compare.</p>` + foot;

  // The cheapest store now goes first, in terracotta.
  const last = (c) => { const v = h.series[c].filter((x) => x != null); return v[v.length - 1]; };
  series.sort((a, b) => last(a.chain) - last(b.chain));
  const W = 340, H = 170, L = 8, R = 8, T = 22, B = 26;
  let lo = Math.min(...vals), hi = Math.max(...vals);
  const pad = hi - lo < hi * 0.05 ? hi * 0.1 : (hi - lo) * 0.2;
  lo = Math.max(0, lo - pad);
  hi += pad;
  const x = (i) => (n === 1 ? W / 2 : L + 18 + (i * (W - L - R - 36)) / (n - 1));
  const y = (v) => T + ((hi - v) * (H - T - B)) / (hi - lo);
  const f = (v) => v.toFixed(1);

  const grid = [0.25, 0.75].map((k) => `<line class="grid" x1="${L}" x2="${W - R}" y1="${f(T + (H - T - B) * k)}" y2="${f(T + (H - T - B) * k)}"/>`).join("");
  const xIdx = n === 1 ? [0] : n < 5 ? [...Array(n).keys()] : [0, Math.floor((n - 1) / 2), n - 1];
  // Labels at the ends are anchored inwards so they never run off the card.
  const anchor = (i) => (n === 1 ? "middle" : i === 0 ? "start" : i === n - 1 ? "end" : "middle");
  const xLabels = xIdx.map((i) => `<text class="axis-label" x="${f(x(i) + (n > 1 && i === 0 ? -6 : n > 1 && i === n - 1 ? 6 : 0))}" y="${H - 6}" text-anchor="${anchor(i)}"${i === n - 1 ? ' style="fill:var(--terracotta);font-weight:700"' : ""}>${i === n - 1 ? "This week" : esc(localDate(h.weeks[i]))}</text>`).join("");

  const lines = series.map(({ chain }, si) => {
    const pts = h.series[chain];
    const alt = si > 0 ? " alt" : "";
    let d = "", pen = false;
    const xy = [];
    pts.forEach((v, i) => {
      if (v == null) { pen = false; return; }
      d += `${pen ? "L" : "M"}${f(x(i))} ${f(y(v))}`;
      xy.push([x(i), y(v), v, i]);
      pen = true;
    });
    const area = si === 0 && xy.length > 1 ? `<path class="area" d="M${f(xy[0][0])} ${H - B} ${xy.map(([a, b]) => `L${f(a)} ${f(b)}`).join(" ")} L${f(xy[xy.length - 1][0])} ${H - B}Z"/>` : "";
    const marks = xy.map(([a, b, , i]) => `<circle class="pt${alt}${h.specials[chain]?.[i] ? " special" : ""}" cx="${f(a)}" cy="${f(b)}" r="4.5"/>`).join("");
    const labels = si === 0 ? xy.map(([a, b, v, i]) => `<text class="val${i === n - 1 ? " now" : ""}" x="${f(a + (n > 1 && i === 0 ? -6 : n > 1 && i === n - 1 ? 6 : 0))}" y="${f(b - 10)}" text-anchor="${anchor(i)}">${i === n - 1 && n > 1 ? "Now " : ""}${esc(amount(v))}</text>`).join("") : "";
    return `${area}<path class="series${alt}" d="${d}"${DASHES[si] ? ` stroke-dasharray="${DASHES[si]}"` : ""}/>${marks}${labels}`;
  }).join("");

  const legend = series.length > 1 || series.some(({ chain }) => (h.specials[chain] || []).some(Boolean))
    ? `<div class="legend" style="margin-top:8px">${series.map(({ chain, name }, si) => `<span><svg viewBox="0 0 24 10" aria-hidden="true"><line x1="0" y1="5" x2="24" y2="5" stroke="${si ? "#706962" : "#C25E3E"}" stroke-width="2"${DASHES[si] ? ` stroke-dasharray="${DASHES[si]}"` : ""}/></svg>${esc(name)}</span>`).join("")}
      <span><svg viewBox="0 0 24 10" aria-hidden="true"><circle cx="12" cy="5" r="4" fill="#486B50"/></svg>On special that week</span></div>` : "";
  const label = `Price history ${perPhrase(item.compare_per)}: ` + series.map(({ chain, name }) => `${name} ${unitMoney(last(chain), item.compare_per)} latest`).join(", ");
  return head + `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">
      <defs><linearGradient id="area" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#C25E3E" stop-opacity=".16"/><stop offset="1" stop-color="#C25E3E" stop-opacity="0"/></linearGradient></defs>
      ${grid}${lines}${xLabels}</svg>${legend}${foot}`;
}

// ------------------------------------------------------------------ List and Savings (built next, to their designs)

function renderList() {
  const list = data.getList();
  if (!list.items.length) {
    view.innerHTML = `<div class="empty">${icon("checklist")}<b>Your list is empty</b>Add specials from
      <a class="link" href="#/this-week">This Week</a> or the <a class="link" href="#/watchlist">Watchlist</a>.</div>`;
    return;
  }
  const t = listTotal(list.items);
  view.innerHTML = `
    <div class="row" style="padding-top:8px"><h2 class="headline-lg">Shopping List</h2>
      <span class="pill muted caps">${plural(list.items.length, "item")}</span></div>
    <div class="stack-sm">${list.items.map((x) => `<article class="watch-row">
      <div class="grow"><p class="title-sm">${esc(x.name)}</p>
        ${x.product && x.product !== x.name ? `<p class="body-sm t2 truncate">${esc(x.product)}</p>` : ""}
        <div class="tagline">${x.chain ? storeTag(x.chain, x.store) : ""}${x.special ? `<span class="pill sage"><span class="dot"></span>On special when added</span>` : ""}</div></div>
      <div style="text-align:right;flex:none"><span class="num-md">${x.qty > 1 ? `${x.qty} × ` : ""}${money(x.price_cents)}${x.price_per === "kg" ? '<small class="per">/kg</small>' : ""}</span><br>
        <button type="button" class="link" data-action="remove" data-id="${esc(x.id)}">Remove</button></div></article>`).join("")}</div>
    <section class="card row"><div><p class="title-sm">Estimated total</p><p class="body-sm t3">At today's prices${t.perKg ? `, plus ${t.perKg} priced per kg` : ""}</p></div>
      <span class="price">${money(t.cents)}</span></section>
    <p class="note">Coming next: ticking items off in the shop, totals for each store, where to shop, and sharing the list.</p>`;
}

function renderSavings() {
  view.innerHTML = `<div class="empty">${icon("savings")}<b>Savings are coming soon</b>
    When you tick off a special you bought, we'll estimate what you saved: the normal shelf price minus the special price.</div>`;
}

// ------------------------------------------------------------------ Alerts (behind the bell on Home)

/** One alert per watched item and store each time it goes on special (a new special run or a new price). */
function syncAlerts() {
  const candidates = [];
  for (const item of state.watch.items) {
    const byChain = new Map();
    for (const o of offersIn(item, comparedChains())) if (o.special && !byChain.has(o.chain)) byChain.set(o.chain, o);
    for (const [chain, o] of byChain) {
      const since = (o.special_since || o.seen_at || "").slice(0, 10);
      candidates.push({
        id: `${item.key}|${chain}|${since}|${Math.round(bestUnit(o) ?? o.price_cents)}`,
        watchKey: item.key, name: item.name, chain, store: o.store, product: o.name, offerId: o.id, image: o.image,
        price_cents: o.price_cents, price_per: o.price_per, was_cents: o.was_cents,
        promo: o.signals?.find((s) => s.kind === "promo")?.text || o.promo || "Special",
        lowest: lowestSignal(o)?.text || null, saving: savingText(o), pct: percentOff(o),
        valid_to: o.valid_to, valid_to_assumed: o.valid_to_assumed,
      });
    }
  }
  data.recordAlerts(candidates);
  updateBell();
}

function updateBell() {
  const n = data.unreadAlertCount();
  const b = $("#alert-count");
  b.hidden = !n;
  b.textContent = n > 99 ? "99+" : String(n);
  $("#bell").setAttribute("aria-label", n ? `Alerts, ${n} unread` : "Alerts");
}

function alertCard(a) {
  const current = state.offersById.get(a.offerId);
  const image = a.image || current?.image;
  const ends = a.valid_to ? (a.valid_to_assumed ? `usually ends ${weekday(a.valid_to)}` : `ends ${day(a.valid_to)}`) : "";
  return `<article class="card alert">
    <a class="alert-main" href="${href(a.watchKey)}" data-action="open-alert" data-id="${esc(a.id)}">
      <span class="thumb">${image ? `<img loading="lazy" src="${esc(image)}" alt="">` : icon("local_offer")}${a.read ? "" : '<span class="unread-dot"></span>'}</span>
      <div class="grow">
        <div class="row">${storeTag(a.chain, a.store)}<span class="ago">${esc(ago(a.createdAt))}</span></div>
        <p class="title-md" style="margin-top:6px">${esc(a.name)}</p>
        <p class="body-sm t2">Special at ${esc(a.store)} · ${esc(a.lowest || a.promo)}</p>
        <div class="priceline"><span class="price deal">${money(a.price_cents)}${a.price_per === "kg" ? "<small>/kg</small>" : ""}</span>
          ${a.was_cents ? `<span class="was">${money(a.was_cents)}</span>` : ""}
          ${ends ? `<span class="pill sage" style="margin-left:auto">${icon("schedule")}${esc(ends)}</span>` : ""}</div>
      </div></a>
    <div class="alert-foot${a.saving ? "" : " plain"}">
      <span class="row" style="gap:6px;justify-content:flex-start">${a.saving ? `${icon("trending_down")}${esc(a.saving)}${a.pct ? ` (${a.pct}% off)` : ""}` : esc(a.product)}</span>
      ${current ? `<button type="button" class="iconbtn" data-action="add" data-ref="${ref(state.offerToItem.get(a.offerId), current)}" aria-label="Add to list">${icon(onList(current) ? "check" : "bookmark_add")}</button>`
        : `<span class="body-sm t3" style="padding:12px 8px">Special has ended</span>`}
    </div></article>`;
}

function renderAlerts() {
  const { alerts } = data.getAlerts();
  const unread = alerts.filter((a) => !a.read);
  const read = alerts.filter((a) => a.read);
  const paused = [...pausedChains()];
  const upd = updatedAt(comparedChains());
  view.innerHTML = `
    <div class="row" style="padding-top:8px">
      <div class="row" style="justify-content:flex-start"><h2 class="headline-lg">Price drops</h2>
        ${unread.length ? `<span class="pill terra caps">${unread.length} new</span>` : ""}</div>
      ${unread.length ? `<button type="button" class="link" data-action="mark-read">Mark all read</button>` : ""}
    </div>
    ${alerts.length ? "" : `<div class="empty">${icon("notifications")}<b>No alerts yet</b>When a watched item goes on special, it shows up here.</div>`}
    ${unread.length ? `<div class="row"><span class="caps t3">New</span>${upd ? `<span class="live body-sm"><span class="dot sm"></span>Updated ${esc(day(upd))}</span>` : ""}</div>
      <div class="stack">${unread.map(alertCard).join("")}</div>` : ""}
    ${read.length ? `<div class="caps t3" style="margin-top:20px">Earlier</div><div class="stack">${read.slice(0, 40).map(alertCard).join("")}</div>` : ""}
    ${paused.map((c) => `<section class="info-card" style="margin-top:20px"><span class="info-icon">${icon("pause_circle")}</span>
      <div><div class="row" style="justify-content:flex-start;gap:8px"><p class="title-md">${esc(storeName(c))} is paused</p><span class="pill muted caps">Info</span></div>
      <p class="body-sm t2" style="margin-top:4px">${esc(storeName(c))} blocked our reads on 16 Oct 2026, so its prices won't show. We don't try to get around that.</p></div></section>`).join("")}
    <section class="card row" id="notify-nudge" hidden>
      <div class="row" style="justify-content:flex-start;gap:12px"><span class="info-icon terra">${icon("notifications_off")}</span>
        <div><p class="title-sm">Phone notifications are off</p><p class="body-sm t2">Get told when watched items go on special</p></div></div>
      <a class="btn secondary small" href="#/settings">Settings</a></section>
    <p class="note">Alerts are made on this phone when the app finds a new special on your watchlist, at the stores you compare.</p>`;
  push.currentSubscription().then((sub) => {
    const nudge = $("#notify-nudge");
    if (nudge) nudge.hidden = !!sub;
  }).catch(() => {});
}

// ------------------------------------------------------------------ Settings (grows into Account and Settings)

function renderSettings() {
  const off = new Set(data.getSettings().excludedChains);
  const stores = state.status?.stores || [];
  const status = new Map(stores.map((s) => [s.chain, s]));
  const active = stores.filter((s) => s.updates_from !== "paused").length;
  const rows = state.watch.stores.map(({ chain, name }) => {
    const s = status.get(chain) || {};
    const paused = s.updates_from === "paused";
    const failed = !paused && s.last_attempt && s.last_attempt.status !== "ok";
    const badge = paused ? `<span class="status" style="color:var(--text-3);border-color:var(--border-clay);background:var(--muted-bg)">Paused</span>`
      : failed ? `<span class="status" style="color:var(--error-text);border-color:var(--error-bg);background:var(--error-bg)"><span class="dot"></span>Last try failed</span>`
      : `<span class="status c-${chain}"><span class="dot"></span>Active</span>`;
    return `<label class="setting-card${paused ? " off" : ""}">
      <span class="store-tile c-${chain}" style="width:40px;height:40px">${STORE_LETTER[chain] || name[0]}</span>
      <div class="grow"><div class="row" style="justify-content:flex-start;gap:8px;flex-wrap:wrap"><span class="title-md">${esc(name)}</span>${badge}</div>
        <p class="num-sm t2" style="margin-top:3px">${paused ? "Prices currently unavailable"
          : s.last_updated ? `Last updated: ${esc(dateTime(s.last_updated))}` : "Not updated yet"}</p>
        ${!paused && s.store ? `<p class="body-sm t3">${esc(s.store)} · ${esc(FROM_TEXT[s.updates_from] || "")}</p>` : ""}</div>
      <span class="switch"><input type="checkbox" data-chain="${esc(chain)}" aria-label="Compare ${esc(name)}"
        ${paused ? "disabled" : off.has(chain) ? "" : "checked"}><span></span></span></label>`;
  }).join("");
  const n = data.getList().items.length;
  const alerts = data.getAlerts().alerts.length;
  view.innerHTML = `
    <section class="setting-card" style="margin-top:8px">
      <span class="setting-icon sage">${icon("sync")}</span>
      <div class="grow"><p class="title-md">Price updates</p><p class="num-sm t2" style="margin-top:2px">${active} of ${stores.length || 5} stores updating</p></div>
      <span class="pill" style="background:var(--panel)">Weekly</span>
    </section>
    <div class="section-head"><h2 class="headline-sm">Notifications</h2><span class="caps t3">This phone</span></div>
    <section class="card" id="notify-card"><p class="body-sm t2">Checking this phone…</p></section>
    <div class="section-head"><h2 class="headline-sm">Stores to compare</h2><span class="caps t3">Preferences</span></div>
    <div class="stack-sm" id="stores" style="margin-top:10px">${rows}</div>
    <section class="prices-note">
      <div class="row" style="justify-content:flex-start;align-items:flex-start;gap:12px">
        <span class="info-icon terra" style="border-radius:10px">${icon("info")}</span>
        <div><p class="title-md">How our prices work</p>
          <ul>
            <li>Prices are shelf prices and specials only. Member discounts, rewards, delivery and bag fees aren't included.</li>
            <li>Multibuys ("2 for $7") count as specials, shown per item and per unit.</li>
            <li>Items are compared on unit price: per kg, per litre, per can, per sheet and so on. Meat sold by weight is per kg.</li>
            <li>Woolworths prices come from its default online store, so your local shop can differ slightly.</li>
            <li>Costco prices are online prices that include delivery, so the warehouse is usually cheaper.</li>
            <li>Chemist Warehouse "off RRP" prices aren't counted as specials.</li>
            <li>Coles is paused: it blocked our reads, so there are no Coles prices.</li>
            <li>End dates come from the store. Woolworths doesn't publish them, so we show its usual weekly end (Tuesday) and say so.</li>
            <li>"Lowest in N weeks" needs ${state.watch.min_history_weeks} weeks of price history. We never predict the next special.</li>
          </ul></div></div>
      <div class="prices-foot"><span class="caps t2">From each store's website</span><span class="num-sm terracotta">Sydney time</span></div>
    </section>
    <div class="section-head"><h2 class="headline-sm">On this phone</h2><span class="caps t3">Storage</span></div>
    <section class="card stack" style="margin-top:10px">
      <div class="row"><div class="row" style="justify-content:flex-start;gap:12px"><span class="setting-icon">${icon("smartphone")}</span>
        <div><p class="title-md">Saved on this phone</p><p class="num-sm t2" style="margin-top:2px">${plural(n, "list item")} · ${plural(alerts, "alert")}</p></div></div>
        <span class="pill mono outline">${APP_VERSION}</span></div>
      <button type="button" class="btn danger block" data-action="clear-all" ${n || alerts ? "" : "disabled"}>${icon("delete_sweep")}Clear list and savings</button>
    </section>
    <div class="section-head"><h2 class="headline-sm">Coming later</h2><span class="caps t3">Roadmap</span></div>
    <div class="stack-sm roadmap" style="margin-top:10px">
      <div class="setting-card"><span class="setting-icon">${icon("group")}</span><div class="grow"><p class="title-md">Family members and shared list</p>
        <p class="body-sm t2">Everyone's list and savings in one place</p></div><span class="pill muted caps">Soon</span></div>
      <div class="setting-card"><span class="setting-icon">${icon("receipt_long")}</span><div class="grow"><p class="title-md">Receipts and purchase history</p>
        <p class="body-sm t2">Track what we actually paid</p></div><span class="pill muted caps">Soon</span></div>
    </div>
    <div class="footer">Prices built ${state.status ? esc(dateTime(state.status.generated_at)) : "(unknown)"}<br>
      <span class="num-sm">Pantry Standard · app ${APP_VERSION}</span></div>`;
  $("#stores").addEventListener("change", (e) => {
    const box = e.target.closest("input[data-chain]");
    if (!box) return;
    const excluded = [...view.querySelectorAll("input[data-chain]:not(:checked):not(:disabled)")].map((x) => x.dataset.chain);
    data.setSettings({ excludedChains: excluded });
    toast(box.checked ? `Comparing ${storeName(box.dataset.chain)}` : `${storeName(box.dataset.chain)} switched off`);
  });
  $("#notify-card").addEventListener("change", (e) => {
    if (e.target.id === "notify-switch") toggleNotifications(e.target);
  });
  renderNotifyCard();
}

async function renderNotifyCard() {
  const card = $("#notify-card");
  if (!card) return;
  const sup = push.support();
  const config = await data.getPushConfig().catch(() => null);
  const sub = sup.ok ? await push.currentSubscription().catch(() => null) : null;
  if (!$("#notify-card")) return;                       // left Settings while checking
  state.pushKey = config?.vapid_public_key;
  state.pushSub = sub;
  const why = !config ? "Notifications aren't set up yet."
    : { "ios-home-screen": "On iPhone, add this app to your Home Screen first (tap Share, then Add to Home Screen) and open it from there.",
        blocked: "Notifications are blocked for this app. Allow them in your phone's Settings, then come back here.",
        unsupported: "This browser can't get notifications." }[sup.reason] || "";
  const name = data.getSettings().phoneName || push.defaultPhoneName();
  card.innerHTML = `
    <label class="setting">
      <span class="row" style="justify-content:flex-start;gap:12px"><span class="setting-icon${sub ? " sage" : ""}">${icon(sub ? "notifications_active" : "notifications")}</span>
        <span><span class="title-md">Allow notifications</span><br><span class="body-sm t2">${sub ? "On for this phone" : esc(why || "Off for this phone")}</span></span></span>
      <span class="switch"><input type="checkbox" id="notify-switch" aria-label="Allow notifications on this phone"
        ${sub ? "checked" : ""} ${!sub && (!config || !sup.ok) ? "disabled" : ""}><span></span></span></label>
    ${sub ? `<div class="setting-block">
        <p class="body-sm t2"><b style="color:var(--text)">One more step:</b> copy this phone's code and add it on the Mac with
          <code>uv run specials notify add</code>. Nothing arrives until then.</p>
        <label class="field">This phone's name
          <input id="phone-name" type="text" value="${esc(name)}" maxlength="40" autocomplete="off"></label>
        <div class="actions" style="margin-top:12px">
          <button type="button" class="btn small" data-action="copy-code">${icon("content_copy")}Copy code</button>
          <button type="button" class="btn outline small" data-action="share-code">${icon("ios_share")}Share code</button></div>
      </div>` : ""}
    <p class="body-sm t3" style="margin-top:12px">A notification when a watched item goes on special (at most one per item each week),
      plus a weekly summary. Covers every store we have prices for. Each phone turns this on for itself.</p>`;
}

async function toggleNotifications(box) {
  if (box.checked) {
    try {
      state.pushSub = await push.enable(state.pushKey);    // asks permission straight from the tap
      toast("Notifications on. Now copy the code.");
    } catch (e) {
      box.checked = false;
      toast(e.message === "blocked" ? "Blocked. Allow notifications in your phone's Settings." : "Notifications not turned on");
    }
  } else {
    await push.disable().catch(() => {});
    toast("Notifications off for this phone");
  }
  renderNotifyCard();
}

// ------------------------------------------------------------------ actions

let toastTimer;
function toast(msg, ic = "") {
  const t = $("#toast");
  t.innerHTML = (ic ? icon(ic) : "") + esc(msg);
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2400);
}

function updateBadge() {
  const n = data.getList().items.length;
  const b = $("#list-count");
  b.hidden = !n;
  b.textContent = n > 99 ? "99+" : String(n);
}

function listEntry(item, o) {
  return {
    offerId: o.id, watchKey: item?.key ?? null, name: item ? item.name : o.name, product: o.name,
    chain: o.chain, store: o.store, url: o.url, image: o.image, price_cents: o.price_cents, price_per: o.price_per,
    was_cents: o.was_cents, special: o.special, multibuy: o.multibuy, valid_to: o.valid_to,
    unit_cents: item ? o.unit_cents : o.unit?.cents ?? null, unit_per: item ? item.compare_per : o.unit?.per ?? null,
  };
}

view.addEventListener("click", (e) => {
  const b = e.target.closest("[data-action]");
  if (!b) return;
  const action = b.dataset.action;
  if (action === "add") {
    const { item, offer } = state.refs.get(b.dataset.ref);
    const list = data.addToList(listEntry(item, offer));
    const qty = list.items.find((x) => x.id === offer.id)?.qty || 1;
    updateBadge();
    // Flip every add button for this product to the "added" state, as in the designs.
    for (const btn of view.querySelectorAll('[data-action="add"]')) {
      const r = state.refs.get(btn.dataset.ref);
      if (r?.offer.id !== offer.id) continue;
      btn.classList.add("added");
      const ic = btn.querySelector(".material-symbols-outlined");
      if (ic) ic.textContent = "check";
      if (btn.classList.contains("btn")) btn.lastChild.textContent = btn.classList.contains("block") ? "On your shopping list" : "On your list";
    }
    toast(qty > 1 ? `On your list (${qty})` : "Added to list", "check");
  } else if (action === "suggest") {
    suggest(state.refs.get(b.dataset.ref).offer);
  } else if (action === "more") {
    const k = b.dataset.key;
    state.expanded.has(k) ? state.expanded.delete(k) : state.expanded.add(k);
    const y = window.scrollY;
    render().then(() => window.scrollTo(0, y));
  } else if (action === "filter") {
    state.filter = b.dataset.filter;
    render();
  } else if (action === "deals-only") {
    state.dealsOnly = !state.dealsOnly;
    render();
  } else if (action === "back") {
    goBack();
  } else if (action === "remove") {
    data.removeFromList(b.dataset.id);
    updateBadge();
    render();
  } else if (action === "mark-read") {
    data.markAlertsRead();
    updateBell();
    render();
  } else if (action === "open-alert") {
    data.markAlertRead(b.dataset.id);
    updateBell();
  } else if (action === "clear-all") {
    if (confirm("Clear the shopping list, savings and alerts on this phone?")) {
      data.clearList(); data.clearSavings(); data.clearAlerts();
      updateBadge(); updateBell(); render(); toast("Cleared on this phone");
    }
  } else if (action === "copy-code" || action === "share-code") {
    if (!state.pushSub) return;
    const name = ($("#phone-name")?.value || "").trim() || push.defaultPhoneName();
    data.setSettings({ phoneName: name });
    const code = push.codeFor(state.pushSub, name);
    if (action === "share-code" && navigator.share) {
      navigator.share({ title: "Notification code", text: code }).catch(() => {});
    } else {
      navigator.clipboard.writeText(code).then(() => toast("Code copied", "check"), () => toast("Couldn't copy. Try Share code."));
    }
  } else if (action === "retry") {
    load(true).then(render).catch((err) => { view.innerHTML = errorHTML(err); });
  }
});

// ------------------------------------------------------------------ loading and routing

async function load(force = false) {
  if (force) data.refresh();
  const [watch, status] = await Promise.all([data.getWatchlist(), data.getStatus().catch(() => null)]);
  state.watch = watch;
  state.status = status;
  state.loadedAt = Date.now();
  state.offerToItem = new Map(watch.items.flatMap((i) => i.offers.map((o) => [o.id, i])));
  state.offersById = new Map(watch.items.flatMap((i) => i.offers.map((o) => [o.id, o])));
  syncAlerts();
}

function route() {
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  return { name: parts[0] || "home", arg: parts[1] };
}

const ROUTES = {
  home: renderHome, "this-week": renderThisWeek, watchlist: renderWatchlist, watch: renderDetail,
  list: renderList, savings: renderSavings, alerts: renderAlerts, settings: renderSettings,
};
const NEEDS_DATA = new Set(["home", "this-week", "watchlist", "watch", "alerts", "settings"]);

function setTitle(text) {
  $("#title").textContent = text;
  document.title = `${text} · Family Specials`;
}

async function render() {
  const r = route();
  if (!ROUTES[r.name]) { location.replace("#/home"); return; }
  const sub = SUB_SCREENS[r.name];
  const tab = sub ? sub.tab : r.name;
  document.querySelectorAll(".tabbar a").forEach((a) => {
    if (a.dataset.tab === tab) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  const stacked = sub && !sub.brand;                    // Alerts and Settings: back arrow, no logo, no tab bar
  $("#back").hidden = !stacked;
  $("#logo").hidden = !!stacked;
  $("#topbar").classList.toggle("sub", !!stacked);
  document.body.classList.toggle("no-tabs", !!(sub && !sub.tabs));
  $("#bell").hidden = r.name !== "home";               // the bell lives on Home only
  $("#gear").hidden = r.name === "settings";           // the gear is on every other screen
  setTitle(TABS[r.name] || sub?.title || "Family Specials");
  state.refs.clear();
  if (NEEDS_DATA.has(r.name) && !state.watch) {
    view.innerHTML = `<p class="note" style="padding-top:40px">Loading prices…</p>`;
    try {
      await load();
    } catch (e) {
      view.innerHTML = errorHTML(e);
      return;
    }
    if (route().name !== r.name) return;   // moved on while loading
  }
  ROUTES[r.name](r.arg);
}

function goBack() {
  if (state.stack.length > 1) history.back();
  else location.replace(SUB_SCREENS[route().name]?.up || "#/home");
}

window.addEventListener("hashchange", async () => {
  const prev = state.stack[state.stack.length - 1];
  if (prev) state.scroll.set(prev, window.scrollY);
  if (state.stack[state.stack.length - 2] === location.hash) state.stack.pop();
  else state.stack.push(location.hash);
  await render();
  window.scrollTo(0, state.scroll.get(location.hash) || 0);
});

$("#back").addEventListener("click", goBack);

// Tapping the tab you're already on scrolls back to the top.
document.querySelector(".tabbar").addEventListener("click", (e) => {
  const a = e.target.closest("a[data-tab]");
  if (a && a.getAttribute("href") === location.hash) window.scrollTo({ top: 0, behavior: "smooth" });
});

// Fresh prices when the app comes back to the front (after 5 minutes away).
document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState !== "visible" || !state.watch || Date.now() - state.loadedAt < 5 * 60e3) return;
  try {
    await load(true);
    state.productsLoaded = false;
    const y = window.scrollY;
    await render();
    window.scrollTo(0, y);
  } catch { /* keep showing what we have */ }
});

if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
  // Tapping a notification while the app is open: go to the screen it's about.
  navigator.serviceWorker.addEventListener("message", (e) => {
    if (e.data?.type === "open") location.hash = new URL(e.data.url).hash || "#/home";
  });
}

if (!location.hash) history.replaceState(null, "", "#/home");
state.stack.push(location.hash);
updateBadge();
render();
