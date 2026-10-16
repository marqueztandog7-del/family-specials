// The screens, built to the Pantry Standard designs in docs/design. Reads and saves data only through data.js,
// and talks to the push service only through push.js, so a native (Capacitor) build or a shared family account
// can swap those without touching this file. Every price, saving and signal shown comes from the data; where
// there isn't enough yet, the screen says so.
import * as data from "./data.js";
import * as push from "./push.js";
import * as account from "./account.js";

const $ = (s, el = document) => el.querySelector(s);
const view = $("#view");
const APP_VERSION = "v4";

const TABS = { "this-week": "This Week", watchlist: "Watchlist", home: "Home", list: "List", savings: "Savings" };
// Screens on top of a tab. Alerts and Settings hide the tab bar (as in the designs); item detail keeps it.
const SUB_SCREENS = {
  watch: { tab: "watchlist", up: "#/watchlist", title: "Item Detail", tabs: true, brand: true },
  alerts: { tab: "home", up: "#/home", title: "Alerts", tabs: false },
  settings: { tab: null, up: "#/home", title: "Settings", tabs: false },
  welcome: { tab: null, up: "#/welcome", title: "Family Specials", tabs: false, bare: true },
  join: { tab: "home", up: "#/home", title: "Join a family", tabs: false },
  family: { tab: "home", up: "#/home", title: "Family", tabs: false },
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
  accountsOn: false, user: null, family: null, authMode: "create",
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

const STORE_NAMES = { woolworths: "Woolworths", coles: "Coles", chemistwarehouse: "Chemist Warehouse", costco: "Costco", aldi: "ALDI" };
const storeName = (chain) => state.watch?.stores.find((s) => s.chain === chain)?.name || STORE_NAMES[chain] || chain;

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

// ------------------------------------------------------------------ list prices (today's where we have them)

const sydDate = (iso) => new Date(iso).toLocaleDateString("en-CA", SYD);           // YYYY-MM-DD in Sydney

/** A list item's price now: from today's data when we have it, else as it was when added (a special that has
 *  ended no longer counts as one). */
function linePrice(x) {
  const o = state.offersById.get(x.offerId);
  if (o) return { price: o.price_cents, per: o.price_per, mb: o.multibuy, special: o.special, was: o.was_cents };
  const ended = x.valid_to && new Date(x.valid_to) < new Date();
  return { price: x.price_cents ?? null, per: x.price_per, mb: ended ? null : x.multibuy, special: !!x.special && !ended,
    was: ended ? null : x.was_cents };
}

/** Price for the quantity (multibuys applied). Null for per-kg items and items without a price. */
function lineTotal(x) {
  const p = linePrice(x);
  if (p.price == null || p.per === "kg") return null;
  return p.mb && x.qty >= p.mb.qty ? Math.floor(x.qty / p.mb.qty) * p.mb.cents + (x.qty % p.mb.qty) * p.price : x.qty * p.price;
}

/** The saving on a list item from the store's own prices: was price minus price, or the multibuy saving. */
function lineSaving(x) {
  const p = linePrice(x);
  if (!p.special || p.price == null || p.per === "kg") return 0;
  if (p.was && p.was > p.price) return (p.was - p.price) * x.qty;
  if (p.mb && x.qty >= p.mb.qty) return Math.floor(x.qty / p.mb.qty) * (p.mb.qty * p.price - p.mb.cents);
  return 0;
}

function listTotal(items) {
  let cents = 0, perKg = 0, unpriced = 0;
  for (const x of items) {
    const t = lineTotal(x);
    if (t != null) cents += t;
    else if (linePrice(x).per === "kg") perKg += 1;
    else unpriced += 1;
  }
  return { cents, perKg, unpriced };
}

// ------------------------------------------------------------------ Home (docs/design/home)

function dayPart() {
  const h = Number(new Date().toLocaleString("en-AU", { hour: "numeric", hour12: false, ...SYD }));
  return h < 12 ? "Morning" : h < 17 ? "Afternoon" : "Evening";
}

function savingPill(o) {
  const pct = o.was_cents ? percentOff(o) : null;
  if (pct) return `<span class="pill terra caps">Save ${pct}%</span>`;
  const save = savingText(o);
  return save ? `<span class="pill sage">${esc(save)}</span>` : `<span class="pill sage">${esc(o.promo || "On special")}</span>`;
}

function renderHome() {
  const chains = comparedChains();
  const rows = specialRows(chains);
  const list = data.getList();
  const onListItems = new Set(list.items.map((x) => x.watchKey).filter(Boolean));
  const unread = data.unreadAlertCount();
  const upd = updatedAt(chains);

  // Weekly savings radar: the potential this week, and how much of it is on the list already.
  const pot = potential(rows);
  const listed = list.items.reduce((a, x) => a + lineSaving(x), 0);
  const share = pot.cents ? Math.min(100, Math.round((listed / pot.cents) * 100)) : 0;
  const weekEnd = state.watch.cycle_started ? (() => { const d = new Date(state.watch.cycle_started + "T12:00:00"); d.setDate(d.getDate() + 6); return d.toISOString(); })() : null;
  const radar = `<a class="radar tap" href="#/this-week">
      <div class="row"><span class="pill white caps"><span class="dot sm"></span>Weekly savings radar</span>
        ${weekEnd ? `<span class="pill caps" style="background:var(--panel)">Week ends ${esc(weekday(weekEnd))}</span>` : ""}</div>
      ${rows.length && pot.counted ? `<h3>Save up to <span class="num-lg">${money(pot.cents)}</span> this week</h3>`
        : `<h3>${rows.length ? `${plural(rows.length, "watched item")} on special` : "Nothing on special this week"}</h3>`}
      <p class="body-sm t2" style="margin-top:2px">${rows.length ? `${plural(rows.length, "item")} from your watchlist ${rows.length === 1 ? "is" : "are"} on special`
        : "None of your watched items are on special at the stores you compare."}</p>
      ${pot.counted ? `<div class="unlock">
        <div class="row"><span class="body-sm t2" style="font-weight:500">Savings on your list</span>
          <span class="num-sm terracotta" style="font-weight:700">${share}% of maximum</span></div>
        <div class="progress"><span style="width:${share}%"></span></div>
        <p class="body-sm t3" style="margin-top:6px">${listed ? `<span class="mono">${money(listed)}</span> of <span class="mono">${money(pot.cents)}</span>` : "Add specials to your list to lock them in"} ·
          estimate from each store's was price${pot.uncounted ? `; ${pot.uncounted} with no was price not counted` : ""}</p>
      </div>` : ""}
    </a>`;

  // New on special this week: only specials we can confirm are new (we read the product the week before).
  const fresh = rows.map((r) => {
    const offer = r.specials.find((o) => o.new_this_cycle === true);
    return offer ? { ...r, offer } : null;
  }).filter(Boolean).sort((a, b) => (savingCents(b.offer) ?? 0) - (savingCents(a.offer) ?? 0)).slice(0, 5);
  const unsure = rows.filter((r) => !r.specials.some((o) => o.new_this_cycle === true)
    && r.specials.some((o) => o.new_this_cycle == null)).length;
  const freshCards = fresh.map(({ item, offer }) => `<div class="item-card">
      <div class="row" style="justify-content:flex-start;gap:12px;min-width:0;flex:1">${thumb(offer, "", href(item.key))}
        <div class="grow"><div class="tagline" style="margin:0 0 4px">${storeTag(offer.chain, offer.store)}${savingPill(offer)}</div>
          <a class="title-sm truncate" style="display:block;text-decoration:none" href="${href(item.key)}">${esc(item.name)}</a>
          <div class="priceline" style="margin-top:2px;gap:6px"><span class="num-md terracotta">${money(offer.price_cents)}</span>
            ${offer.was_cents ? `<span class="was">${money(offer.was_cents)}</span>` : ""}</div></div></div>
      ${addRound(item, offer, "sm")}</div>`).join("");

  // Recently added to the list.
  const recent = [...list.items].sort((a, b) => (b.addedAt || "").localeCompare(a.addedAt || "")).slice(0, 5);
  const t = listTotal(list.items);
  const recentCard = list.items.length ? `<section class="card white">
      <div class="list-rows">${recent.map((x) => {
        const total = lineTotal(x);
        const p = linePrice(x);
        const sub = [x.from ? `Added from ${x.from}` : "", x.store ? (p.special ? `on special at ${x.store}` : x.store) : ""].filter(Boolean).join(" · ");
        return `<div class="row"><div class="grow"><div class="row" style="justify-content:flex-start;gap:8px"><span class="qty">${x.qty}x</span>
            <p class="truncate" style="font-weight:500">${esc(x.product || x.name)}</p></div>
            ${sub ? `<p class="body-sm t3 truncate" style="margin-left:34px">${esc(sub.charAt(0).toUpperCase() + sub.slice(1))}</p>` : ""}</div>
          <span class="num-md" style="flex:none">${total != null ? money(total) : p.price != null ? `${money(p.price)}<small class="per">/kg</small>` : ""}</span></div>`;
      }).join("")}</div>
      <a class="btn secondary block" href="#/list" style="margin-top:12px">Review entire list${icon("chevron_right")}</a>
    </section>` : `<section class="card white"><div class="row"><div><p class="title-sm">Nothing on your list yet</p>
      <p class="body-sm t2" style="margin-top:2px">Tap ${icon("add", "terracotta")} on a special to start it.</p></div>
      <a class="round-btn" href="#/list" aria-label="Open the list">${icon("checklist")}</a></div></section>`;

  // Recommended: watched items (from our receipts) on special now, not on the list, not already shown above.
  const shown = new Set(fresh.map((r) => r.item.key));
  const recs = rows.filter((r) => !shown.has(r.item.key) && !onListItems.has(r.item.key)).slice(0, 5);
  const recCards = recs.map(({ item, best }) => {
    const kg = best.price_per === "kg" ? "/kg" : "";
    const usual = best.usual_cents && best.usual_cents > best.price_cents;
    const unit = best.unit_cents != null ? unitMoney(best.unit_cents, item.compare_per) : "";
    return `<div class="rec-card">
      <span class="tag-sq ${usual ? "terra" : "sage"}">${usual ? `<span class="dot sm"></span>On special, usually ${money(best.usual_cents)}${kg}` : esc(TIER_REASON[item.tier] || "On your watchlist")}</span>
      <a class="title-sm" style="text-decoration:none" href="${href(item.key)}">${esc(item.name)}</a>
      <div class="priceline" style="margin-top:2px;gap:6px"><span class="num-md terracotta">${money(best.price_cents)}${kg ? '<small class="per">/kg</small>' : ""}</span>
        ${best.was_cents ? `<span class="was">${money(best.was_cents)}</span>` : ""}</div>
      <div class="rec-foot"><span class="num-sm t2">${esc(best.store)}${unit ? ` · ${esc(unit)}` : ""}</span>${addRound(item, best, "sm")}</div>
    </div>`;
  }).join("");

  const pantry = pantryHTML();

  view.innerHTML = `
    <div class="greet">
      <div><span class="caps">${dayPart()} pantry run</span><h2 class="headline-lg" style="margin-top:2px">Hi ${esc(state.family?.me?.nickname || "there")} 🥖</h2>
        <p class="body-sm t3">${upd ? `Prices updated ${esc(dateTime(upd))}` : "Prices not updated yet"}</p></div>
      <a class="round-btn" href="#/alerts" aria-label="${unread ? `Alerts, ${unread} unread` : "Alerts"}">${icon("notifications")}${unread ? `<b class="badge">${unread > 99 ? "99+" : unread}</b>` : ""}</a>
    </div>
    ${radar}
    <div class="section-head"><div class="title"><h2 class="title-md">New on special</h2><span class="pill terra caps">This week</span></div><a href="#/this-week">See all →</a></div>
    <div class="stack-sm" style="margin-top:12px">${freshCards || `<div class="item-card"><p class="body-sm t2">Nothing we can confirm is new this week yet.</p></div>`}
      ${unsure ? `<p class="body-sm t3" style="padding:0 4px">${plural(unsure, "more item")} on special that we can't call new yet: it's the first week we've
        read ${unsure === 1 ? "it" : "them"}. This fills in after next Wednesday's update. <a class="link" href="#/this-week">See them</a></p>` : ""}</div>
    <div class="section-head"><h2 class="title-md">Recently added to your list</h2>
      ${list.items.length ? `<span class="pill mono" style="background:var(--panel);letter-spacing:0">${plural(list.items.length, "item")} · ${money(t.cents)}</span>` : ""}</div>
    <div style="margin-top:12px">${recentCard}</div>
    <div class="section-head"><div class="title"><h2 class="title-md">Recommended to add</h2><span class="pill caps" style="background:var(--panel)">From your watchlist</span></div></div>
    <div class="stack-sm" style="margin-top:12px">${recCards || `<div class="rec-card"><p class="body-sm t2">Nothing else to suggest right now.</p></div>`}
      <p class="body-sm t3" style="padding:0 4px">Suggestions only come from your watchlist, which was built from your receipts. Items you're due to buy
        again will show here once the List has a few weeks of ticks.</p></div>
    <div class="section-head"><div class="title"><h2 class="title-md">Shared Pantry</h2><span class="pill caps" style="background:var(--panel)">Household</span></div></div>
    <div style="margin-top:12px">${pantry}</div>`;
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

// ------------------------------------------------------------------ List (docs/design/shopping_list)

function listGroups(items) {
  const order = state.watch ? state.watch.stores.map((s) => s.chain) : [];
  const groups = new Map();
  for (const x of items) {
    const k = x.chain || "own";
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(x);
  }
  return [...groups].sort(([a], [b]) => (a === "own") - (b === "own") || order.indexOf(a) - order.indexOf(b));
}

function renderList() {
  const list = data.getList();
  const items = list.items;
  const ticked = items.filter((x) => x.ticked).length;
  const t = listTotal(items);
  const saving = items.reduce((a, x) => a + lineSaving(x), 0);
  const groups = listGroups(items);
  const stores = groups.filter(([k]) => k !== "own");
  const quickAdd = `<form class="quick-add" id="quick-add">${icon("add_circle")}
      <input id="own-item" type="text" placeholder="Add another item or staple…" autocomplete="off" enterkeyhint="done" aria-label="Add your own item">
      <button type="submit" class="btn">Add</button></form>`;

  const head = `<div class="list-head">
      <div><h2 class="headline-lg">Shopping List</h2><p class="t2" style="margin-top:2px">${plural(items.length, "item")} · ${ticked} ticked off</p></div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:8px">
        ${items.length ? `<button type="button" class="btn secondary small" data-action="share-list" style="border-radius:999px">${icon("ios_share")}Share</button>` : ""}
        ${list.updatedAt && items.length ? `<span class="pill sage">Updated ${esc(ago(list.updatedAt))}</span>` : ""}</div>
    </div>`;
  if (!items.length) {
    view.innerHTML = head + `<div class="empty">${icon("checklist")}<b>Your list is empty</b>Add specials from
      <a class="link" href="#/this-week">This Week</a> or the <a class="link" href="#/watchlist">Watchlist</a>, or type your own below.</div>` + quickAdd;
    return;
  }

  const cart = stores.length ? `<section class="cart">
      <div class="row" style="align-items:flex-start"><div><span class="caps t3">Your cart</span>
        <p class="title-md" style="font-size:19px;line-height:26px;margin-top:4px">${stores.length === 1 ? `Everything at ${esc(storeName(stores[0][0]))}` : `Split across ${stores.length} stores`}</p></div>
        <span class="price" style="font-size:26px;line-height:30px">${money(t.cents)}</span></div>
      ${saving ? `<span class="pill sage" style="margin-top:10px"><span class="dot"></span>You save on specials <span class="mono">${money(saving)}</span></span>` : ""}
      ${t.perKg || t.unpriced ? `<p class="body-sm t3" style="margin-top:8px">${[t.perKg ? `plus ${plural(t.perKg, "item")} priced per kg` : "", t.unpriced ? `${t.unpriced} without a price` : ""].filter(Boolean).join(", ")}, not in the total</p>` : ""}
      <div class="cart-note">${icon("storefront")}<span>Comparing your whole list at each store, to find the cheapest way to shop, comes in the next List update.
        Totals use today's shelf prices.</span></div>
    </section>` : "";

  const groupCards = groups.map(([chain, rows]) => {
    const own = chain === "own";
    const total = rows.reduce((a, x) => a + (lineTotal(x) ?? 0), 0);
    return `<section class="store-group">
      <div class="head"><div class="row" style="justify-content:flex-start;gap:10px">
          ${own ? `<span class="store-tile" style="background:var(--panel)">${icon("shopping_basket")}</span><span class="title-md">Your own items</span>`
            : `<span class="store-tile c-${chain}">${STORE_LETTER[chain] || storeName(chain)[0]}</span><span class="title-md">${esc(storeName(chain))}</span>`}</div>
        ${own ? "" : `<span class="num-md" style="font-size:16px">${money(total)}</span>`}</div>
      ${rows.map((x) => {
        const p = linePrice(x);
        const line = lineTotal(x);
        return `<div class="tick-row${x.ticked ? " done" : ""}">
          <label class="tick"><input type="checkbox" data-tick="${esc(x.id)}" ${x.ticked ? "checked" : ""} aria-label="Ticked off ${esc(x.product || x.name)}"><span>${icon("check")}</span></label>
          <div class="grow"><p class="name">${esc(x.product || x.name)}</p>
            <div class="sub">${p.price != null ? `<span class="num-sm t2">${x.qty} × ${money(p.price)}${p.per === "kg" ? "/kg" : ""}</span>` : x.qty > 1 ? `<span class="num-sm t2">× ${x.qty}</span>` : ""}
              ${p.special ? `<span class="pill sage" style="padding:1px 6px">On special</span>` : ""}
              ${x.product && x.watchKey && x.product !== x.name ? `<span class="body-sm t3 truncate">for ${esc(x.name)}</span>` : ""}</div></div>
          ${line != null ? `<span class="line-total">${money(line)}</span>` : ""}
          <button type="button" class="x-btn" data-action="remove" data-id="${esc(x.id)}" aria-label="Remove ${esc(x.product || x.name)}">${icon("close")}</button>
        </div>`;
      }).join("")}
    </section>`;
  }).join("");

  view.innerHTML = head + cart + groupCards + quickAdd +
    (ticked ? `<div style="text-align:center"><button type="button" class="link" data-action="remove-ticked">Remove ${plural(ticked, "ticked item")}</button></div>` : "") +
    `<p class="note">${icon("savings", "t3")} Ticking off a special records its saving in Savings. Your list is saved on this phone for now.</p>`;
}

function tickItem(id, on) {
  const item = data.setTicked(id, on);
  if (!item) return;
  const sid = `${item.id}|${item.addedAt}`;
  if (on) {
    const s = lineSaving(item);
    if (s > 0) {
      data.recordSaving({ id: sid, watchKey: item.watchKey, name: item.name, product: item.product, chain: item.chain,
        store: item.store, qty: item.qty, saving_cents: s, at: item.tickedAt });
      toast(`Saved ${money(s)} on special`, "savings");
    }
  } else {
    data.removeSaving(sid);
  }
  const y = window.scrollY;
  render().then(() => window.scrollTo(0, y));
}

function listText() {
  const items = data.getList().items;
  const lines = ["Shopping list"];
  for (const [chain, rows] of listGroups(items)) {
    lines.push("", chain === "own" ? "Our own items" : storeName(chain));
    for (const x of rows) {
      const line = lineTotal(x);
      lines.push(`${x.ticked ? "☑" : "☐"} ${x.product || x.name}${x.qty > 1 ? ` × ${x.qty}` : ""}${line != null ? ` — ${money(line)}` : ""}${linePrice(x).special ? " (special)" : ""}`);
    }
  }
  const t = listTotal(items);
  lines.push("", `Total ${money(t.cents)}${t.perKg ? ` plus ${t.perKg} priced per kg` : ""} (shelf prices today)`);
  return lines.join("\n");
}

async function shareList() {
  const text = listText();
  if (navigator.share) {
    try {
      await navigator.share({ title: "Shopping list", text });
      return;
    } catch (e) {
      if (e.name === "AbortError") return;
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    toast("List copied. Paste it into a message.", "check");
  } catch {
    toast("Couldn't share from this browser.");
  }
}

// ------------------------------------------------------------------ Savings (docs/design/savings)

function renderSavings() {
  const { entries } = data.getSavings();
  const head = `<div style="padding-top:12px"><h2 class="headline-lg">Savings</h2><p class="t2">Estimated from shelf prices</p></div>`;
  if (!entries.length) {
    view.innerHTML = head + `<section class="saved-card">
        <div class="row" style="align-items:flex-start"><span class="pill sage"><span class="dot"></span>All-time tracked</span><span class="digest-icon">${icon("savings")}</span></div>
        <p class="big">${money(0)}</p><p class="t2">No savings tracked yet.</p>
        <div class="cart-note" style="background:var(--panel)">${icon("verified")}<span>Tick off specials on your List as you buy them, and we'll estimate
          what you saved: the store's was price minus the special price.</span></div>
        <a class="btn block" href="#/list" style="margin-top:14px">${icon("checklist")}Open your list</a>
      </section>`;
    return;
  }
  const total = entries.reduce((a, e) => a + e.saving_cents, 0);
  const byDay = new Map();
  for (const e of entries) byDay.set(sydDate(e.at), (byDay.get(sydDate(e.at)) || 0) + e.saving_cents);
  const days = [...byDay.keys()].sort();
  const lastDay = days[days.length - 1];
  const today = sydDate(new Date().toISOString());
  const weekStart = state.watch?.cycle_started || today;
  const thisWeek = entries.filter((e) => sydDate(e.at) >= weekStart).reduce((a, e) => a + e.saving_cents, 0);
  const thisMonth = entries.filter((e) => sydDate(e.at).slice(0, 7) === today.slice(0, 7)).reduce((a, e) => a + e.saving_cents, 0);

  // Monthly bars: from the first month we tracked to this month (at most the last 6).
  const months = [];
  const first = new Date(days[0].slice(0, 7) + "-15T12:00:00");
  for (const d = new Date(first); sydDate(d.toISOString()).slice(0, 7) <= today.slice(0, 7); d.setMonth(d.getMonth() + 1)) {
    months.push(sydDate(d.toISOString()).slice(0, 7));
  }
  const shown = months.slice(-6);
  const byMonth = new Map(shown.map((m) => [m, 0]));
  for (const e of entries) { const m = sydDate(e.at).slice(0, 7); if (byMonth.has(m)) byMonth.set(m, byMonth.get(m) + e.saving_cents); }
  const max = Math.max(...byMonth.values(), 1);
  const top = [...byMonth].reduce((a, b) => (b[1] > a[1] ? b : a))[0];
  const bars = shown.map((m) => {
    const v = byMonth.get(m);
    const label = new Date(m + "-15T12:00:00").toLocaleDateString("en-AU", { month: "short" });
    return `<div class="bar${m === top && v ? " top" : ""}">${m === top && v && shown.length > 1 ? `<span class="pill terra mono" style="font-size:10px">Top month</span>` : ""}
      <span class="amt">${money(v)}</span><span class="fill" style="height:${Math.max(3, Math.round((v / max) * 100))}px"></span><span class="mon">${label}</span></div>`;
  }).join("");

  // Top items saved on.
  const byItem = new Map();
  for (const e of entries) {
    const k = e.watchKey || e.name;
    const cur = byItem.get(k) || { name: e.name, chain: e.chain, store: e.store, cents: 0, times: 0 };
    cur.cents += e.saving_cents;
    cur.times += 1;
    byItem.set(k, cur);
  }
  const topItems = [...byItem.values()].sort((a, b) => b.cents - a.cents).slice(0, 5);

  view.innerHTML = head + `
    <section class="saved-card">
      <div class="row" style="align-items:flex-start"><span class="pill sage"><span class="dot"></span>All-time tracked</span><span class="digest-icon">${icon("savings")}</span></div>
      <p class="big">${money(total)}</p>
      <p class="t2">saved since we started, across ${plural(days.length, "shop")}</p>
    </section>
    <div class="kpis">
      <div class="kpi"><div class="row"><span class="caps t3">This week</span>${icon("calendar_today")}</div><p class="val">${money(thisWeek)}</p><p class="body-sm t2">since Wed ${esc(localDate(weekStart))}</p></div>
      <div class="kpi"><div class="row"><span class="caps t3">This month</span>${icon("bar_chart")}</div><p class="val">${money(thisMonth)}</p><p class="body-sm t2">${esc(new Date().toLocaleDateString("en-AU", { month: "long", ...SYD }))}</p></div>
      <div class="kpi"><div class="row"><span class="caps t3">Last shop</span>${icon("receipt")}</div><p class="val">${money(byDay.get(lastDay))}</p><p class="body-sm t2">${esc(localDate(lastDay))}</p></div>
      <div class="kpi"><div class="row"><span class="caps t3">Average / shop</span>${icon("insights")}</div><p class="val">${money(Math.round(total / days.length))}</p><p class="body-sm t2">${plural(days.length, "shop")}</p></div>
    </div>
    <section class="card white"><div class="row"><div class="row" style="justify-content:flex-start;gap:8px">${icon("bar_chart", "terracotta")}<h3 class="title-md">Monthly savings</h3></div>
      <span class="pill mono" style="background:var(--panel)">${esc(today.slice(0, 4))}</span></div>
      <div class="bars">${bars}</div></section>
    <div class="row" style="padding:0 4px;margin-top:8px"><div class="row" style="gap:8px">${icon("workspace_premium", "sage")}<h3 class="title-md">Top items saved on</h3></div>
      <span class="body-sm t3">${plural(byItem.size, "product")}</span></div>
    <div class="stack-sm" style="margin-top:10px">${topItems.map((x, i) => `<div class="watch-row">
      <span class="rank${i === 0 ? " first" : ""}">${i + 1}</span>
      <div class="grow"><p class="title-md truncate">${esc(x.name)}</p><div class="tagline">${x.chain ? storeTag(x.chain, x.store) : ""}<span class="body-sm t2">${plural(x.times, "time")}</span></div></div>
      <div style="text-align:right;flex:none"><span class="plus">+${money(x.cents)}</span><br><span class="body-sm t3">saved</span></div></div>`).join("")}</div>
    <p class="note">An estimate: the store's was price minus the special price, for specials you ticked off. Shelf prices only, so member
      discounts and rewards aren't included. Saved on this phone for now.</p>`;
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
  view.innerHTML = accountSettingsHTML() + `
    <div class="section-head" style="margin-top:${state.user ? 24 : 8}px"><h2 class="headline-sm">Prices</h2><span class="caps t3">Stores</span></div>
    <section class="setting-card" style="margin-top:10px">
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

// ------------------------------------------------------------------ Accounts and families (through account.js)

const initials = (name) => ((name || "?").trim().split(/\s+/).map((w) => w[0]).join("").slice(0, 2) || "?").toUpperCase();

async function refreshFamily() {
  if (!state.user) { state.family = null; return null; }
  try {
    state.family = await account.myFamily();
  } catch {
    state.family = account.cachedFamily();          // offline: what we knew last time
  }
  return state.family;
}

/** The gear becomes the person's profile (their initial) once they're signed in. */
function updateHeader() {
  const gear = $("#gear");
  if (state.user) {
    const who = state.family?.me?.nickname || state.user.email || "?";
    gear.innerHTML = `<span class="avatar sm">${esc(initials(who))}</span>`;
    gear.setAttribute("aria-label", "Settings and account");
  } else {
    gear.innerHTML = icon("settings");
    gear.setAttribute("aria-label", "Settings");
  }
}

function renderWelcome() {
  const code = account.pendingCode();
  const mode = state.authMode;
  view.innerHTML = `
    <div class="auth">
      <div class="auth-brand"><span class="logo lg">${icon("shopping_basket", "fill")}</span>
        <h2 class="headline-lg">Family Specials</h2>
        <p class="t2">Specials on the things your family buys, at every store you use.</p></div>
      ${code ? `<div class="invite-banner">${icon("group_add")}<div><p class="title-sm">You've been invited to a family</p>
        <p class="body-sm t2">Create an account or sign in first. Then you'll join with code <b class="mono">${esc(code)}</b>.</p></div></div>` : ""}
      <section class="card white">
        <div class="seg" role="tablist" aria-label="Create an account or sign in">
          <button type="button" role="tab" data-action="auth-mode" data-mode="create" aria-selected="${mode === "create"}">Create account</button>
          <button type="button" role="tab" data-action="auth-mode" data-mode="signin" aria-selected="${mode === "signin"}">Sign in</button>
        </div>
        <form id="auth-form" novalidate>
          <label class="field">Email<input id="auth-email" type="email" autocomplete="email" inputmode="email" autocapitalize="off" spellcheck="false" required></label>
          <label class="field">Password<input id="auth-password" type="password" autocomplete="${mode === "create" ? "new-password" : "current-password"}" required></label>
          ${mode === "create" ? `<p class="body-sm t3" style="margin-top:6px">At least 8 characters.</p>` : ""}
          <p class="form-error" id="auth-error" role="alert" hidden></p>
          <button type="submit" class="btn block" style="margin-top:16px">${mode === "create" ? "Create account" : "Sign in"}</button>
        </form>
      </section>
      <p class="note">We only keep your email and a scrambled password. Your list and savings on this phone are kept.</p>
    </div>`;
}

async function submitAuth(form) {
  const email = $("#auth-email").value.trim();
  const password = $("#auth-password").value;
  const err = $("#auth-error");
  const btn = form.querySelector('button[type="submit"]');
  const label = btn.textContent;
  const fail = (msg) => { err.textContent = msg; err.hidden = false; btn.disabled = false; btn.textContent = label; };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail("That doesn't look like an email address.");
  if (state.authMode === "create" && password.length < 8) return fail("Use a password of at least 8 characters.");
  if (!password) return fail("Enter your password.");
  btn.disabled = true;
  btn.textContent = "One moment…";
  try {
    state.user = state.authMode === "signin" ? await account.signIn(email, password) : await account.signUp(email, password);
  } catch (e) {
    return fail(e.message);
  }
  await refreshFamily();
  updateHeader();
  toast(state.authMode === "signin" ? "Signed in" : "Account created", "check");
  const code = account.pendingCode();
  location.replace(code && !state.family ? `#/join?code=${encodeURIComponent(code)}` : "#/home");
}

function renderJoin(_arg, params) {
  const code = account.cleanCode(params.get("code") || account.pendingCode());
  if (code) account.setPendingCode(code);
  if (!state.user) { location.replace("#/welcome"); return; }
  if (state.family) {
    account.clearPendingCode();
    view.innerHTML = `<div class="empty">${icon("group")}<b>You're in ${esc(state.family.name)}</b>
      One person belongs to one family for now.<br><a class="btn secondary small" href="#/home" style="margin-top:14px">Back to Home</a></div>`;
    return;
  }
  view.innerHTML = `<div class="empty">${icon("group_add")}<b>Joining a family comes next</b>
    ${code ? `Your code <b class="mono">${esc(code)}</b> is saved on this phone, ready for the next update.` : "You'll type the 6-character code here in the next update."}
    <br><a class="btn secondary small" href="#/home" style="margin-top:14px">Back to Home</a></div>`;
}

function renderFamily(arg) {
  if (!state.user) { location.replace("#/welcome"); return; }
  if (arg === "new") return renderFamilyNew();
  return renderFamilyInvite();
}

function renderFamilyNew() {
  if (state.family) { location.replace("#/family/invite"); return; }
  setTitle("Start a family");
  view.innerHTML = `
    <div style="padding-top:12px"><span class="caps terracotta">Shared Pantry</span>
      <h2 class="headline-lg" style="margin-top:2px">Start a family account</h2>
      <p class="t2" style="margin-top:4px">You'll be the owner. Next you'll get a link and a code to invite the others.</p></div>
    <section class="card white">
      <form id="family-form" novalidate>
        <label class="field">Family name<input id="family-name" type="text" maxlength="60" autocomplete="off" placeholder="What your family calls itself" required></label>
        <label class="field">Your nickname in the family<input id="family-nickname" type="text" maxlength="30" autocomplete="nickname" placeholder="e.g. Mum or Dad" required></label>
        <p class="form-error" id="family-error" role="alert" hidden></p>
        <button type="submit" class="btn block" style="margin-top:16px">${icon("group_add")}Start family</button>
      </form>
    </section>
    <p class="note">Only your family can see its name, nicknames, list and savings.</p>`;
}

async function submitFamily(form) {
  const name = $("#family-name").value.trim();
  const nickname = $("#family-nickname").value.trim();
  const err = $("#family-error");
  const btn = form.querySelector('button[type="submit"]');
  const fail = (msg) => { err.textContent = msg; err.hidden = false; btn.disabled = false; };
  if (!name) return fail("Give the family a name.");
  if (!nickname) return fail("Add your nickname.");
  btn.disabled = true;
  try {
    state.family = await account.createFamily(name, nickname);
  } catch (e) {
    return fail(e.message);
  }
  updateHeader();
  location.replace("#/family/invite");
}

function renderFamilyInvite() {
  const f = state.family;
  if (!f) { location.replace("#/family/new"); return; }
  setTitle("Invite family");
  if (!f.is_owner || !f.invite) {
    view.innerHTML = `<div class="empty">${icon("group")}<b>${esc(f.name)}</b>Only the family's owner can invite people. Ask them for the link or code.
      <br><a class="btn secondary small" href="#/home" style="margin-top:14px">Back to Home</a></div>`;
    return;
  }
  const link = account.inviteLink(f.invite.code);
  const code = f.invite.code;
  view.innerHTML = `
    <div style="padding-top:12px"><span class="caps terracotta">Invite to</span>
      <h2 class="headline-lg" style="margin-top:2px">${esc(f.name)}</h2>
      <p class="t2" style="margin-top:4px">Send the link, or read out the code. The app doesn't send anything itself: copy or share them into
        Messages, WhatsApp or email.</p></div>
    <section class="card white">
      <div class="row"><span class="caps t3">Invite link</span>${icon("open_in_new", "t3")}</div>
      <p class="link-box mono">${esc(link)}</p>
      <div class="actions" style="margin-top:12px">
        <button type="button" class="btn small" data-action="copy" data-what="link">${icon("content_copy")}<span>Copy</span></button>
        <button type="button" class="btn outline small" data-action="share" data-what="link">${icon("ios_share")}<span>Share</span></button></div>
    </section>
    <section class="card white">
      <div class="row"><span class="caps t3">Join code</span><span class="pill" style="background:var(--panel)">${icon("schedule")}Expires ${esc(day(f.invite.expires_at))}</span></div>
      <div class="code-boxes" aria-label="Join code ${esc(code.split("").join(" "))}">${code.split("").map((ch) => `<span>${esc(ch)}</span>`).join("")}</div>
      <div class="actions" style="margin-top:12px">
        <button type="button" class="btn small" data-action="copy" data-what="code">${icon("content_copy")}<span>Copy</span></button>
        <button type="button" class="btn outline small" data-action="share" data-what="code">${icon("ios_share")}<span>Share</span></button></div>
    </section>
    <a class="btn secondary block" href="#/home">Done</a>
    <p class="note">Codes are 6 letters and numbers with no look-alikes (no 0/O or 1/I/L), and last 7 days.
      Whoever joins creates an account or signs in first.</p>`;
}

function inviteText(what) {
  const f = state.family;
  const link = account.inviteLink(f.invite.code);
  return what === "link" ? { title: `Join ${f.name}`, text: `Join ${f.name} on Family Specials: ${link}` }
    : { title: "Family join code", text: `Our Family Specials join code is ${f.invite.code}` };
}

async function copyInvite(btn, what) {
  const value = what === "link" ? account.inviteLink(state.family.invite.code) : state.family.invite.code;
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    toast("Couldn't copy. Try Share instead.");
    return;
  }
  toast("Copied", "check");
  const label = btn.querySelector("span:last-child");
  label.textContent = "Copied";
  setTimeout(() => { label.textContent = "Copy"; }, 1600);
}

async function shareInvite(what) {
  const msg = inviteText(what);
  if (navigator.share) {
    try {
      await navigator.share(msg);
      return;
    } catch (e) {
      if (e.name === "AbortError") return;
    }
  }
  try {
    await navigator.clipboard.writeText(msg.text);
    toast("Copied. Paste it into a message.", "check");
  } catch {
    toast("Couldn't share from this browser.");
  }
}

/** Home's Shared Pantry: the family's members, or how to start or join one. */
function pantryHTML() {
  if (!state.accountsOn || !state.user) {
    const hh = data.getHousehold();
    const me = hh.members[0];
    return `<section class="card white">
      <div class="member"><div class="row" style="justify-content:flex-start;gap:12px"><span class="avatar">${esc(me.name[0])}<span class="online"></span></span>
        <div><p class="title-sm">${esc(me.name)}</p><p class="body-sm t2">On this phone</p></div></div>
        <span class="pill" style="background:var(--panel);color:var(--text-3);font-weight:400;letter-spacing:0">Just you for now</span></div>
      <p class="title-sm">Household Sync</p>
      <p class="body-sm t2" style="margin-top:2px">Share the watchlist, shopping list and savings with your family, with ticks syncing between phones.</p>
    </section>`;
  }
  const f = state.family;
  if (!f) {
    return `<section class="card white">
      <p class="title-sm">Shop together</p>
      <p class="body-sm t2" style="margin-top:2px">Share one watchlist, shopping list and savings tracker with your family.</p>
      <div class="stack-sm" style="margin-top:14px">
        <a class="btn block" href="#/family/new">${icon("group_add")}Start a family account</a>
        <a class="btn secondary block" href="#/join">${icon("person_add")}Join with a code</a></div>
    </section>`;
  }
  return `<section class="card white">
    <div class="row" style="margin-bottom:12px"><p class="title-md">${esc(f.name)}</p><span class="pill caps" style="background:var(--panel)">${plural(f.members.length, "member")}</span></div>
    <div class="list-rows">${f.members.map((m) => `<div class="row"><div class="row" style="justify-content:flex-start;gap:12px">
        <span class="avatar">${esc(initials(m.nickname))}${m.is_me ? '<span class="online"></span>' : ""}</span>
        <div><p class="title-sm">${esc(m.nickname)}${m.is_me ? ' <span class="t3" style="font-weight:400">(you)</span>' : ""}</p>
          <p class="body-sm t2">${m.role === "owner" ? "Owner" : "Member"}</p></div></div>
        ${m.role === "owner" ? `<span class="pill terra caps">Owner</span>` : ""}</div>`).join("")}</div>
    ${f.is_owner ? `<a class="btn secondary block" href="#/family/invite" style="margin-top:14px">${icon("group_add")}Invite family</a>` : ""}
  </section>`;
}

/** Settings: the account and the family, at the top. */
function accountSettingsHTML() {
  if (!state.accountsOn || !state.user) return "";
  const f = state.family;
  const who = f?.me?.nickname || state.user.email;
  return `
    <div class="section-head" style="margin-top:8px"><h2 class="headline-sm">Account</h2><span class="caps t3">Profile</span></div>
    <section class="card white" style="margin-top:10px">
      <div class="row" style="justify-content:flex-start;gap:12px"><span class="avatar">${esc(initials(who))}</span>
        <div class="grow"><p class="title-md truncate">${esc(f?.me?.nickname || "Signed in")}</p><p class="body-sm t2 truncate">${esc(state.user.email)}</p></div></div>
      <div class="actions" style="margin-top:14px">
        <button type="button" class="btn secondary small" data-action="sign-out">${icon("logout")}Sign out</button>
        <button type="button" class="btn danger small" data-action="delete-account">${icon("delete_sweep")}Delete account</button></div>
    </section>
    <div class="section-head"><h2 class="headline-sm">Family</h2><span class="caps t3">Shared Pantry</span></div>
    <section class="card white" style="margin-top:10px">
      ${f ? `<div class="row"><div><p class="title-md">${esc(f.name)}</p><p class="body-sm t2">You're ${f.is_owner ? "the owner" : "a member"} · ${plural(f.members.length, "member")}</p></div>
          ${f.is_owner ? `<a class="btn secondary small" href="#/family/invite">${icon("group_add")}Invite</a>` : ""}</div>`
        : `<p class="body-sm t2">Share one watchlist, shopping list and savings tracker with your family.</p>
          <div class="actions" style="margin-top:12px"><a class="btn small" href="#/family/new">${icon("group_add")}Start a family</a>
            <a class="btn secondary small" href="#/join">${icon("person_add")}Join with a code</a></div>`}
    </section>`;
}

async function signOutNow() {
  await account.signOut().catch(() => {});
  state.user = null;
  state.family = null;
  account.forgetFamily();
  updateHeader();
  toast("Signed out");
  location.replace("#/welcome");
}

async function deleteAccountNow() {
  const f = state.family;
  const others = f ? f.members.filter((m) => !m.is_me).length : 0;
  const what = f && f.is_owner ? (others ? ` ${f.name} will be handed to the longest-standing member.` : ` ${f.name} will be deleted too.`) : "";
  if (!confirm(`Delete your account for good? This removes your email and your place in the family.${what} Your list on this phone stays.`)) return;
  try {
    await account.deleteAccount();
  } catch (e) {
    toast(e.message);
    return;
  }
  state.user = null;
  state.family = null;
  account.forgetFamily();
  updateHeader();
  toast("Account deleted");
  location.replace("#/welcome");
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

const FROM_NAME = { home: "Home", "this-week": "This Week", watchlist: "Watchlist", watch: "the item page", alerts: "Alerts" };

function listEntry(item, o, from) {
  return {
    offerId: o.id, from, watchKey: item?.key ?? null, name: item ? item.name : o.name, product: o.name,
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
    const list = data.addToList(listEntry(item, offer, FROM_NAME[route().name]));
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
    const y = window.scrollY;
    render().then(() => window.scrollTo(0, y));
  } else if (action === "remove-ticked") {
    data.removeTicked();
    updateBadge();
    render();
  } else if (action === "share-list") {
    shareList();
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
  } else if (action === "auth-mode") {
    state.authMode = b.dataset.mode;
    renderWelcome();
    $("#auth-email")?.focus();
  } else if (action === "copy") {
    copyInvite(b, b.dataset.what);
  } else if (action === "share") {
    shareInvite(b.dataset.what);
  } else if (action === "sign-out") {
    signOutNow();
  } else if (action === "delete-account") {
    deleteAccountNow();
  } else if (action === "retry") {
    load(true).then(render).catch((err) => { view.innerHTML = errorHTML(err); });
  }
});

// Ticking items off, and adding your own items to the list.
view.addEventListener("change", (e) => {
  const t = e.target.closest("input[data-tick]");
  if (t) tickItem(t.dataset.tick, t.checked);
});
view.addEventListener("submit", (e) => {
  if (e.target.id === "auth-form") { e.preventDefault(); submitAuth(e.target); return; }
  if (e.target.id === "family-form") { e.preventDefault(); submitFamily(e.target); return; }
  if (e.target.id !== "quick-add") return;
  e.preventDefault();
  const name = $("#own-item").value.trim();
  if (!name) return;
  data.addToList({ name, from: "List" });
  updateBadge();
  render().then(() => $("#own-item")?.focus());
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
  const [path, query = ""] = location.hash.replace(/^#\/?/, "").split("?");
  const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
  return { name: parts[0] || "home", arg: parts[1], params: new URLSearchParams(query) };
}

const ROUTES = {
  home: renderHome, "this-week": renderThisWeek, watchlist: renderWatchlist, watch: renderDetail,
  list: renderList, savings: renderSavings, alerts: renderAlerts, settings: renderSettings,
  welcome: renderWelcome, join: renderJoin, family: renderFamily,
};
const NEEDS_DATA = new Set(["home", "this-week", "watchlist", "watch", "alerts", "settings"]);
const LIKES_DATA = new Set(["list", "savings"]);   // use today's prices if they load, but work without them (offline)

function setTitle(text) {
  $("#title").textContent = text;
  document.title = text === "Family Specials" ? text : `${text} · Family Specials`;
}

async function render() {
  const r = route();
  if (!ROUTES[r.name]) { location.replace("#/home"); return; }
  // With accounts switched on, everyone signs in first (an invite link keeps its code for afterwards).
  if (state.accountsOn && !state.user && r.name !== "welcome") {
    if (r.name === "join" && r.params.get("code")) account.setPendingCode(account.cleanCode(r.params.get("code")));
    location.replace("#/welcome");
    return;
  }
  if (r.name === "welcome" && (!state.accountsOn || state.user)) { location.replace("#/home"); return; }
  const sub = SUB_SCREENS[r.name];
  const tab = sub ? sub.tab : r.name;
  document.querySelectorAll(".tabbar a").forEach((a) => {
    if (a.dataset.tab === tab) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  const stacked = sub && !sub.brand && !sub.bare;      // Alerts and Settings: back arrow, no logo, no tab bar
  $("#back").hidden = !stacked;
  $("#logo").hidden = !!stacked;
  $("#topbar").classList.toggle("sub", !!stacked);
  document.body.classList.toggle("no-tabs", !!(sub && !sub.tabs));
  $("#bell").hidden = true;                            // the bell lives in Home's greeting row (docs/design/home)
  $("#gear").hidden = r.name === "settings" || !!sub?.bare;   // the gear (or profile) is on every other screen
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
  } else if (LIKES_DATA.has(r.name) && !state.watch) {
    await load().catch(() => {});
    if (route().name !== r.name) return;
  }
  ROUTES[r.name](r.arg, r.params);
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

async function start() {
  state.accountsOn = await account.available();
  if (state.accountsOn) {
    state.user = await account.currentUser();
    state.family = account.cachedFamily();
    if (state.user) {
      refreshFamily().then(() => {
        updateHeader();
        if (["home", "settings", "family", "join"].includes(route().name)) render();
      });
    }
    account.onChange((u) => {
      if ((u?.id || null) === (state.user?.id || null)) return;
      state.user = u;
      state.family = null;
      updateHeader();
      if (!u) location.replace("#/welcome");
    });
  }
  if (!location.hash) history.replaceState(null, "", "#/home");
  state.stack.push(location.hash);
  updateBadge();
  updateHeader();
  render();
}

start();
