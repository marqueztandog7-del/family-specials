// The screens, built to the Pantry Standard designs in docs/design. Reads and saves data only through data.js,
// and talks to the push service only through push.js, so a native (Capacitor) build or a shared family account
// can swap those without touching this file. Every price, saving and signal shown comes from the data; where
// there isn't enough yet, the screen says so.
import * as data from "./data.js";
import * as push from "./push.js";
import * as account from "./account.js";
import * as sync from "./sync.js";

const $ = (s, el = document) => el.querySelector(s);
const view = $("#view");
const APP_VERSION = "v7";

const TABS = { "this-week": "This Week", watchlist: "Watchlist", home: "Home", list: "List", savings: "Savings" };
// Screens on top of a tab. Alerts and Settings hide the tab bar (as in the designs); item detail keeps it.
const SUB_SCREENS = {
  watch: { tab: "watchlist", up: "#/watchlist", title: "Item Detail", tabs: true, brand: true },
  alerts: { tab: "home", up: "#/home", title: "Alerts", tabs: false },
  settings: { tab: null, up: "#/home", title: "Settings", tabs: false },
  welcome: { tab: null, up: "#/welcome", title: "Family Specials", tabs: false, bare: true },
  join: { tab: "home", up: "#/profile", title: "Join a family", tabs: false },
  invite: { tab: null, up: "#/welcome", title: "Join a family", tabs: false, bare: true },
  joined: { tab: null, up: "#/home", title: "Welcome", tabs: false, bare: true },
  family: { tab: "home", up: "#/home", title: "Family", tabs: false },
  profile: { tab: null, up: "#/home", title: "Profile", tabs: false },
  forgot: { tab: null, up: "#/welcome", title: "Forgot password", tabs: false, bare: true },
  reset: { tab: null, up: "#/welcome", title: "Set a new password", tabs: false, bare: true },
};
const TIER_ORDER = { core: 0, regular: 1, occasional: 2, added: 3 };
const TIER_LABEL = { core: "Core", regular: "Regular", occasional: "Occasional", added: "Added" };
const TIER_SECTION = {
  core: ["Core Essentials", "The things we buy most often", ""],
  regular: ["Regular Pantry & Household", "Things we buy regularly", "sage"],
  occasional: ["Occasional", "Things we buy now and then", "sage"],
  added: ["Added by the family", "Products someone in the family chose to watch", "sage"],
};
// Tiers come from our receipts (core: bought in 4+ of the shops, regular: 3, occasional: 2), so these stay modest.
const TIER_REASON = { core: "You buy this often", regular: "You buy this regularly", occasional: "You buy this now and then",
  added: "Added to your watchlist" };
const NOTE_TEXT = { paused: "Paused, so no prices", "not found": "No match yet", "no current price": "Matched, no current price" };
const BASIS_TEXT = { online: "Online price", "online, incl. delivery": "Online price incl. delivery" };
const FROM_TEXT = { github: "automatic", mac: "from our Mac", paused: "paused" };
const STORE_LETTER = { woolworths: "W", coles: "C", costco: "C", aldi: "A", chemistwarehouse: "+" };
// Chart lines: the cheapest store in terracotta, others in warm grey with dashes.
const DASHES = ["", "6 4", "2 4", "8 3 2 3", "4 2"];

const state = {
  watch: null, status: null, loadedAt: 0, offerToItem: new Map(), offersById: new Map(),
  query: "", searchSeq: 0, productsLoaded: false, dealsOnly: false,
  refs: new Map(), expanded: new Set(), scroll: new Map(), stack: [], pushOn: null,
  accountsOn: false, user: null, family: null, profile: null, authMode: "create",
  invite: null, newInvite: null, leaving: false, productsById: null,
  specials: [], weekTab: "all", weekQuery: "", weekShown: 40, reset: null,
};

// ------------------------------------------------------------------ formatting

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (c) => (c == null ? "no price" : "$" + (c / 100).toFixed(2));
const plural = (n, word) => `${n.toLocaleString("en-AU")} ${word}${n === 1 ? "" : "s"}`;
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

/** The family's watchlist changes (empty when not in a family): items it stopped watching, products it added. */
function watchChanges() {
  const changes = data.getWatchChanges();
  return {
    stopped: new Set(changes.filter((c) => !c.watching && !c.watch_key.startsWith("product:")).map((c) => c.watch_key)),
    added: changes.filter((c) => c.watching && c.watch_key.startsWith("product:")),
    stoppedRows: changes.filter((c) => !c.watching),
  };
}

let productsLoading = null;
/** Today's prices for the products the family added (from the backend's store ranges). */
function ensureProducts() {
  const ids = watchChanges().added.map((c) => c.watch_key.slice("product:".length));
  const key = ids.slice().sort().join(",");
  if (state.productsKey === key) return;
  state.productsKey = key;
  productsLoading = data.getProductsById(ids).then((list) => {
    state.productsById = new Map(list.map((p) => [p.id, p]));
    scheduleRender();
  }).catch(() => { state.productsKey = null; });
}

/** A product the family added, shaped like a watch item (today's price once the products have loaded). */
function productItem(change) {
  const id = change.watch_key.slice("product:".length);
  const snap = change.data || {};
  ensureProducts();
  const p = state.productsById?.get(id);
  const offer = p ? { ...p, unit_cents: p.unit?.cents ?? null, multibuy_unit_cents: p.multibuy?.unit?.cents ?? null,
    signals: [], new_this_cycle: null, usual_cents: null } : null;
  return { key: change.watch_key, name: snap.name || p?.name || "Product", tier: "added", level: "exact",
    compare_per: p?.unit?.per || snap.unit_per || "item", target_cents: null,
    rule: `This product at ${p?.store || snap.store || "its store"}${change.added_by ? `, added by ${memberName(change.added_by)}` : ""}`,
    on_special: !!offer?.special, offers: offer ? [offer] : [], stores_note: {}, product: true,
    productChain: p?.chain || snap.chain, history: { weeks: [], series: {}, specials: {} }, addedBy: change.added_by };
}

/** What this family watches: the standard watchlist minus what it stopped watching, plus the products it added. */
function watchItems() {
  if (!state.watch) return [];
  const ch = watchChanges();
  return state.watch.items.filter((i) => !ch.stopped.has(i.key)).concat(ch.added.map(productItem));
}

/** Every watch item with a special at the compared stores; `best` is its lowest unit price special. */
function specialRows(chains) {
  const rows = [];
  for (const item of watchItems()) {
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
        const by = data.familyMode() && x.addedBy ? `Added by ${memberName(x.addedBy)}` : x.from ? `Added from ${x.from}` : "";
        const sub = [by, x.store ? (p.special ? `on special at ${x.store}` : x.store) : ""].filter(Boolean).join(" · ");
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

const WEEK_TABS = [["all", "All specials"], ["core", "Core Essentials"], ["regular", "Regulars"]];
const WEEK_PAGE = 40;
const GROUP_ORDER = { core: 0, regular: 1 };   // then other watchlist items (2), then everything else (3)
const MARKER = { core: "Core", regular: "Regular" };

/** Every special at the compared stores, each with the watch item it matches (if any), in This Week's order:
 *  Core first, then Regulars, then other watchlist items, then everything else; biggest saving first in each. */
function weekRows(chains) {
  const watched = new Map();   // special id -> { item, offer } (the item in the highest group wins)
  for (const item of watchItems()) {
    for (const o of item.offers) {
      if (!o.special || !chains.has(o.chain)) continue;
      const prev = watched.get(o.id);
      if (!prev || groupOf(item) < groupOf(prev.item)) watched.set(o.id, { item, offer: o });
    }
  }
  const rows = [];
  const seen = new Set();
  for (const s of state.specials) {
    if (!chains.has(s.chain)) continue;
    const hit = watched.get(s.id);
    rows.push({ special: s, offer: hit?.offer || s, item: hit?.item || null, saving: s.saving_cents ?? savingCents(s) ?? 0 });
    seen.add(s.id);
  }
  // A watched special that isn't in the public file (e.g. a product the family added, priced since): still shown.
  for (const [id, hit] of watched) {
    if (!seen.has(id)) rows.push({ special: hit.offer, offer: hit.offer, item: hit.item, saving: savingCents(hit.offer) ?? 0 });
  }
  return rows.sort((a, b) => groupOf(a.item) - groupOf(b.item) || b.saving - a.saving
    || (a.offer.name || "").localeCompare(b.offer.name || ""));
}

function groupOf(item) {
  if (!item) return 3;
  return GROUP_ORDER[item.tier] ?? 2;
}

function weekCard({ offer: o, item }) {
  const link = item ? href(item.key) : (o.url || null);
  const ext = !item && o.url ? ' target="_blank" rel="noopener"' : "";
  const unit = item ? (o.unit_cents != null ? unitMoney(o.unit_cents, item.compare_per) : "")
    : o.unit ? unitMoney(o.unit.cents, o.unit.per) : "";
  const marker = item ? `<span class="pill outline watched">${icon("bookmark")}${esc(MARKER[item.tier] || "On your watchlist")}</span>` : "";
  const mbUnit = item ? unitMoney(o.multibuy_unit_cents, item.compare_per) : o.multibuy?.unit ? unitMoney(o.multibuy.unit.cents, o.multibuy.unit.per) : "";
  return `<article class="card deal">
    <div class="row">${headPill(o)}<span class="caps t3">${esc(endsText(o))}</span></div>
    <div class="deal-body">
      ${thumb(o, "", link && item ? link : null)}
      <div class="grow">
        ${marker}
        ${link ? `<a class="deal-name clamp2" href="${esc(link)}"${ext}>${esc(o.name)}</a>` : `<p class="deal-name clamp2">${esc(o.name)}</p>`}
        <div class="tagline">${storeTag(o.chain, o.store)}${unit ? `<span class="unit">${esc(unit)}</span>` : ""}</div>
        ${priceLine(o)}
        ${multibuyLine(o, mbUnit)}
      </div>
      ${addRound(item, o)}
    </div>
    ${morePills(o)}
    ${item ? `<a class="deal-foot" href="${href(item.key)}"><span>${esc(item.product ? "On your watchlist" : `Matches ${item.name}`)} · all stores and price history</span>${icon("chevron_right")}</a>` : ""}
  </article>`;
}

function weekEmpty(tab) {
  const tiers = new Set(watchItems().map((i) => i.tier));
  if (tab === "all") return `<div class="empty">${icon("local_offer")}<b>No specials at the stores you compare right now</b>
    <a class="link" href="#/settings">Check which stores you compare</a></div>`;
  const name = tab === "core" ? "Core Essentials" : "Regulars";
  if (!tiers.has(tab)) {
    return `<div class="empty">${icon("bookmark")}<b>${data.familyMode() ? `Your watchlist has no ${name} yet` : `Your family's ${name} show here`}</b>
      ${data.familyMode() ? "" : `They're shared with your family's members. <a class="link" href="#/profile">Join or start a family</a>`}</div>`;
  }
  return `<div class="empty">${icon("local_offer")}<b>None of your ${name} are on special this week</b>
    <a class="link" href="#/this-week" data-action="week-tab" data-tab="all">See all specials</a></div>`;
}

function renderThisWeek() {
  const chains = comparedChains();
  const rows = weekRows(chains);
  const watchedRows = specialRows(chains);
  const paused = [...pausedChains()];
  const pot = potential(watchedRows);
  const upd = updatedAt(chains);
  const tabs = {
    all: rows,
    core: rows.filter((r) => r.item?.tier === "core"),
    regular: rows.filter((r) => r.item?.tier === "regular"),
  };
  if (!tabs[state.weekTab]) state.weekTab = "all";
  const q = state.weekQuery.trim();
  const shown = q ? tabs[state.weekTab].filter((r) => r.special._words ? data.matchesQuery(r.special, q)
    : (r.offer.name || "").toLowerCase().includes(q.toLowerCase())) : tabs[state.weekTab];
  const page = shown.slice(0, state.weekShown);

  // Store counts for the digest: every special at each compared store.
  const byStore = new Map();
  for (const r of rows) byStore.set(r.offer.chain, (byStore.get(r.offer.chain) || 0) + 1);

  view.innerHTML = `
    <div class="context">
      <div><div class="live caps"><span class="dot"></span>Weekly specials cycle</div>
        <p class="body-sm t2" style="margin-top:2px">${upd ? `Updated ${esc(dateTime(upd))}` : "Not updated yet"} · Week of ${esc(cycleText())}</p></div>
    </div>
    <a class="digest tap" href="#/watchlist">
      <div class="row" style="align-items:flex-start">
        <div class="grow">
          <span class="pill terra caps">${icon("local_fire_department")}Pantry digest</span>
          <h2>${watchedRows.length ? `${plural(watchedRows.length, "watched item")} on special${pot.counted ? `, save up to <span class="num-lg">${money(pot.cents)}</span>` : ""}`
            : "None of your watched items are on special"}</h2>
          <p class="body-sm t2">${plural(rows.length, "special")} this week at the stores you compare.</p>
        </div>
        <span class="digest-icon">${icon("savings")}</span>
      </div>
      <div class="digest-foot">
        ${[...byStore].map(([c, n]) => `<span class="store-count c-${c}"><span class="dot"></span>${n.toLocaleString("en-AU")} ${esc(storeName(c))}</span>`).join("")}
        ${paused.map((c) => `<span class="store-count c-${c}">${icon("pause_circle")}${esc(storeName(c))} paused</span>`).join("")}
      </div>
    </a>
    <div class="filters" role="tablist" aria-label="Specials">
      ${WEEK_TABS.map(([k, label]) => `<button type="button" class="filter" role="tab" data-action="week-tab" data-tab="${k}"
        aria-selected="${state.weekTab === k}" aria-pressed="${state.weekTab === k}">${esc(label)}<span class="count">${tabs[k].length.toLocaleString("en-AU")}</span></button>`).join("")}
    </div>
    <form class="search" role="search" id="week-search">${icon("search")}
      <input id="wq" type="search" placeholder="Search this week's specials" enterkeyhint="search" autocomplete="off"
        autocorrect="off" spellcheck="false" aria-label="Search this week's specials" value="${esc(state.weekQuery)}">
    </form>
    <div class="stack" id="week-list">${page.map(weekCard).join("") || (q ? `<div class="empty">${icon("search")}<b>No specials match "${esc(q)}"</b>Try a shorter word.</div>` : weekEmpty(state.weekTab))}</div>
    ${shown.length > page.length ? `<button type="button" class="btn secondary block" data-action="week-more" style="margin-top:12px">Show more (${(shown.length - page.length).toLocaleString("en-AU")} more)</button>` : ""}`;
  let timer;
  $("#wq").addEventListener("input", (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      state.weekQuery = e.target.value;
      state.weekShown = WEEK_PAGE;
      const at = e.target.selectionStart;
      renderThisWeek();
      const box = $("#wq");
      box.focus();
      try { box.setSelectionRange(at, at); } catch { /* not a text field */ }
    }, 250);
  });
  $("#week-search").addEventListener("submit", (e) => { e.preventDefault(); $("#wq").blur(); });
}

// ------------------------------------------------------------------ Watchlist and search

function renderWatchlist() {
  const chains = comparedChains();
  const rows = specialRows(chains);
  const pot = potential(rows);
  const groups = new Map();
  const items = watchItems();
  for (const item of items) {
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
        <span class="pill muted caps">${plural(items.length, "item")}</span></div>
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
      ${sections || (items.length ? `<div class="empty">${icon("local_offer")}<b>Nothing on special right now</b>Turn off "Deals only" to see everything.</div>`
        : data.familyMode() ? `<div class="empty">${icon("bookmark")}<b>Nothing on the watchlist yet</b>Search for a product above and tap Watch.</div>`
        : `<div class="empty">${icon("bookmark")}<b>Your family's watchlist shows here</b>It's shared with your family's members. <a class="link" href="#/profile">Join or start a family</a></div>`)}
      ${stoppedHTML()}
      <p class="note">${data.familyMode() ? "Your watchlist is shared with the family. Search for a product and tap Watch to add it, or open an item to stop watching it."
        : "New items are added to the watchlist on our Mac for now. Search for a product and tap \"Suggest to watch\" to send a request."}</p>
    </div>`;
  let timer;
  $("#q").addEventListener("input", (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => { state.query = e.target.value; renderResults(); }, 200);
  });
  $("#search-form").addEventListener("submit", (e) => { e.preventDefault(); $("#q").blur(); });
  if (state.query.trim()) renderResults();
}

/** The family's stopped items, so anyone can start watching them again. */
function stoppedHTML() {
  if (!data.familyMode()) return "";
  const rows = watchChanges().stoppedRows;
  if (!rows.length) return "";
  const base = new Map(state.watch.items.map((i) => [i.key, i]));
  return `<details class="stopped"><summary class="body-sm t2">${icon("visibility_off")}Stopped watching (${rows.length})</summary>
    <div class="stack-sm" style="margin-top:10px">${rows.map((c) => `<div class="watch-row">
      <div class="grow"><p class="title-sm truncate">${esc(base.get(c.watch_key)?.name || c.data?.name || c.watch_key)}</p></div>
      <button type="button" class="btn secondary small" data-action="watch-again" data-key="${esc(c.watch_key)}">${icon("bookmark_add")}Watch again</button></div>`).join("")}</div></details>`;
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
  if (!state.productsLoaded) box.innerHTML = `<p class="note">Searching every store…</p>`;
  try {
    const limit = 40;
    const results = await data.searchProducts(q, { chains: [...comparedChains()], limit });
    state.productsLoaded = true;
    if (seq !== state.searchSeq) return;
    box.innerHTML = `<p class="body-sm t2">${results.length >= limit ? `Top ${limit}` : results.length} ${results.length === 1 ? "product" : "products"}.
        Searches every product at ${esc(listWords([...comparedChains()].map(storeName)))}.</p>` +
      (results.map(productHTML).join("") || `<div class="empty">${icon("search")}<b>Nothing found</b>Try a shorter word.</div>`);
  } catch (e) {
    if (seq === state.searchSeq) box.innerHTML = errorHTML(e);
  }
}

function productHTML(p) {
  const item = state.offerToItem.get(p.id) || watchItems().find((i) => i.key === `product:${p.id}`);
  const r = ref(null, p);
  const unit = p.unit ? unitMoney(p.unit.cents, p.unit.per) : p.store_unit_text || "";
  const size = p.size && !(p.name || "").toLowerCase().replace(/\s/g, "").includes(p.size.toLowerCase().replace(/\s/g, "")) ? p.size : "";
  return `<article class="card deal">
    <div class="row">${p.special ? headPill(p) : `<span class="pill muted">Normal price</span>`}<span class="caps t3">${esc(p.special ? endsText(p) : "")}</span></div>
    <div class="deal-body">
      ${thumb(p)}
      <div class="grow">
        <a class="deal-name clamp2" href="${esc(p.url || "#")}" target="_blank" rel="noopener">${esc(p.name)}</a>
        ${size ? `<p class="product truncate">${esc(size)}</p>` : ""}
        <div class="tagline">${storeTag(p.chain, p.store)}${unit ? `<span class="unit">${esc(unit)}</span>` : ""}</div>
        ${priceLine(p)}
        ${multibuyLine(p, p.multibuy?.unit ? unitMoney(p.multibuy.unit.cents, p.multibuy.unit.per) : "")}
      </div>
    </div>
    ${morePills(p)}
    <div class="actions">
      <button type="button" class="btn small${onList(p) ? " added" : ""}" data-action="add" data-ref="${r}">${icon(onList(p) ? "check" : "add")}${onList(p) ? "On your list" : "Add to list"}</button>
      ${item ? `<a class="btn outline small" href="${href(item.key)}">${icon("bookmark")}Watched</a>`
        : data.familyMode() ? `<button type="button" class="btn outline small" data-action="watch-product" data-ref="${r}">${icon("bookmark_add")}Watch</button>`
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
  const item = watchItems().find((i) => i.key === key) || state.watch.items.find((i) => i.key === key);
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
  const storeList = item.product ? state.watch.stores.filter((s) => s.chain === item.productChain) : state.watch.stores;
  const storeRows = storeList.map(({ chain, name }) => {
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
    ${data.familyMode() ? `<button type="button" class="btn secondary block" data-action="stop-watching" data-key="${esc(item.key)}" data-name="${esc(item.name)}"
        style="margin-top:10px">${icon("visibility_off")}Stop watching</button>` : ""}
    <p class="note">Specials and their dates come from each store.${data.familyMode() ? " Stopping watching changes the watchlist for the whole family." : " Targets and watch rules are changed on our Mac for now."}</p>`;
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
              ${x.product && x.watchKey && x.product !== x.name ? `<span class="body-sm t3 truncate">for ${esc(x.name)}</span>` : ""}
              ${data.familyMode() && x.addedBy ? `<span class="body-sm t3">added by ${esc(memberName(x.addedBy))}</span>` : ""}</div></div>
          ${line != null ? `<span class="line-total">${money(line)}</span>` : ""}
          <button type="button" class="x-btn" data-action="remove" data-id="${esc(x.id)}" aria-label="Remove ${esc(x.product || x.name)}">${icon("close")}</button>
        </div>`;
      }).join("")}
    </section>`;
  }).join("");

  const offline = data.familyMode() && !sync.online()
    ? `<p class="hint">${icon("cloud_off")} You're offline. Ticks and changes are saved on this phone and sync when you're back online.</p>` : "";
  view.innerHTML = head + offline + cart + groupCards + quickAdd +
    (ticked ? `<div style="text-align:center"><button type="button" class="link" data-action="remove-ticked">Remove ${plural(ticked, "ticked item")}</button></div>` : "") +
    `<p class="note">${icon("savings", "t3")} Ticking off a special records its saving in Savings. ${data.familyMode()
      ? `Your list is shared with ${esc(state.family?.name || "your family")}, live on everyone's phone.` : "Your list is saved on this phone."}</p>`;
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
  for (const item of watchItems()) {
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
      : s.stopped_after_block ? `<span class="status" style="color:var(--error-text);border-color:var(--error-bg);background:var(--error-bg)"><span class="dot"></span>Stopped: the store refused us</span>`
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
            <li>Costco's online prices include delivery. Prices from its In-Warehouse Savings booklet are warehouse shelf prices, and show instead while the booklet runs.</li>
            <li>Chemist Warehouse "off RRP" prices aren't counted as specials. A catalogue price counts only when it's lower than the price we saw there before the catalogue started.</li>
            <li>Every store is read once a week, on Wednesday morning, including its full range for search.</li>
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
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isStandalone = () => window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const appLink = () => `${location.origin}${location.pathname}`;

/** Copy text, also inside in-app browsers (WhatsApp, Messages) where the clipboard API may be missing. */
async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall back below */ }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;font-size:16px";
  document.body.append(ta);
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try { ok = document.execCommand("copy"); } catch { ok = false; }
  ta.remove();
  return ok;
}

/** The person's family, fresh from the backend (or as last seen, offline). Keeps family sharing in step. */
async function refreshFamily() {
  if (!state.user) { state.family = null; applyFamilyMode(); return null; }
  const before = state.family;
  let known = true;
  try {
    state.family = await account.myFamily();
  } catch {
    state.family = account.cachedFamily() || before;          // offline: what we knew last time
    known = false;
  }
  if (known && before && !state.family) {
    data.forgetFamilyData(before.id);                         // left or removed: the family's copy goes from this phone
    toast(`You're no longer in ${before.name}`);
  }
  applyFamilyMode();
  return state.family;
}

/** In a family: this phone shares the family's list, savings and watchlist, live. Otherwise its own. */
function applyFamilyMode() {
  const f = state.family;
  if (f && state.user) {
    data.setFamilyMode({ id: f.id, userId: state.user.id });
    sync.start(f.id, () => refreshFamily().then(() => { updateHeader(); scheduleRender(); })).catch(() => {});
  } else {
    data.setFamilyMode(null);
    sync.stop();
  }
}

/** A member's nickname from their account id ("you" for yourself). */
function memberName(userId) {
  if (!userId || !state.family) return "";
  const m = state.family.members.find((x) => x.user_id === userId);
  return m ? (m.is_me ? "you" : m.nickname) : "someone who's left";
}

function authFormHTML() {
  const create = state.authMode === "create";
  return `<section class="card white">
      <div class="seg" role="tablist" aria-label="Create an account or sign in">
        <button type="button" role="tab" data-action="auth-mode" data-mode="create" aria-selected="${create}">Create account</button>
        <button type="button" role="tab" data-action="auth-mode" data-mode="signin" aria-selected="${!create}">I already have an account</button>
      </div>
      <form id="auth-form" novalidate>
        <label class="field">Email<input id="auth-email" type="email" autocomplete="email" inputmode="email" autocapitalize="off" spellcheck="false" required></label>
        <label class="field">Password<input id="auth-password" type="password" autocomplete="${create ? "new-password" : "current-password"}" required></label>
        ${create ? `<label class="field">Confirm password<input id="auth-confirm" type="password" autocomplete="new-password" required></label>
          <p class="body-sm t3" style="margin-top:6px">At least 8 characters.</p>`
          : `<p class="forgot"><a class="link" href="#/forgot">Forgot password?</a></p>`}
        <p class="form-error" id="auth-error" role="alert" hidden></p>
        <button type="submit" class="btn block" style="margin-top:16px">${create ? "Create account" : "Sign in"}</button>
      </form>
    </section>`;
}

function brandHTML(sub = "Specials on the things your family buys, at every store you use.") {
  return `<div class="auth-brand"><span class="logo lg">${icon("shopping_basket", "fill")}</span>
    <h2 class="headline-lg">Family Specials</h2><p class="t2">${esc(sub)}</p></div>`;
}

function renderWelcome() {
  view.innerHTML = `<div class="auth">${brandHTML()}${authFormHTML()}
    <p class="note">We only keep your email and a scrambled password. Your list and savings on this phone are kept.</p></div>`;
}

async function submitAuth(form) {
  const email = $("#auth-email").value.trim();
  const password = $("#auth-password").value;
  const confirmEl = $("#auth-confirm");
  const err = $("#auth-error");
  const btn = form.querySelector('button[type="submit"]');
  const label = btn.textContent;
  const fail = (msg) => { err.textContent = msg; err.hidden = false; btn.disabled = false; btn.textContent = label; };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail("That doesn't look like an email address.");
  if (!password) return fail("Enter your password.");
  if (state.authMode === "create") {
    if (password.length < 8) return fail("Use a password of at least 8 characters.");
    if (confirmEl && confirmEl.value !== password) return fail("The two passwords don't match.");
  }
  btn.disabled = true;
  btn.textContent = "One moment…";
  try {
    state.user = state.authMode === "signin" ? await account.signIn(email, password) : await account.signUp(email, password);
  } catch (e) {
    return fail(e.message);
  }
  await Promise.all([refreshFamily(), refreshProfile()]);
  updateHeader();
  toast(state.authMode === "signin" ? "Signed in" : "Account created", "check");
  if (route().name === "invite") render();                   // straight on to joining
  else location.replace("#/home");
}

// ------------------------------------------------------------------ forgotten passwords

const SENT_TEXT = "If that email has an account, we've sent a link to reset your password. Check your inbox and junk folder.";

function renderForgot() {
  view.innerHTML = `<div class="auth">${brandHTML("Forgot your password? We'll email you a link to set a new one.")}
    <section class="card white" id="forgot-card">
      <form id="forgot-form" novalidate>
        <label class="field">Email<input id="forgot-email" type="email" autocomplete="email" inputmode="email" autocapitalize="off" spellcheck="false" required></label>
        <p class="form-error" id="forgot-error" role="alert" hidden></p>
        <button type="submit" class="btn block" style="margin-top:16px">${icon("mail")}Send reset link</button>
      </form>
    </section>
    <p class="note" id="forgot-back"><a class="link" href="#/welcome" data-action="auth-mode" data-mode="signin">Back to sign in</a></p></div>`;
  $("#forgot-email").focus();
}

async function submitForgot(form) {
  const email = $("#forgot-email").value.trim();
  const err = $("#forgot-error");
  const btn = form.querySelector('button[type="submit"]');
  const fail = (msg) => { err.textContent = msg; err.hidden = false; btn.disabled = false; btn.innerHTML = `${icon("mail")}Send reset link`; };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail("That doesn't look like an email address.");
  btn.disabled = true;
  btn.textContent = "Sending…";
  try {
    await account.requestPasswordReset(email);
  } catch (e) {
    // Waiting between emails, or no connection: say so. Nothing here ever says whether the email has an account.
    if (/wait a minute|connection/i.test(e.message)) return fail(e.message);
  }
  $("#forgot-back").hidden = true;
  $("#forgot-card").innerHTML = `<div class="sent">${icon("mail", "terracotta")}<p class="title-sm" role="status">${esc(SENT_TEXT)}</p>
    <p class="body-sm t3" style="margin-top:8px">The link works once, for an hour. Open it on this phone or any other.</p>
    <a class="btn secondary block" href="#/welcome" data-action="auth-mode" data-mode="signin" style="margin-top:16px">Back to sign in</a></div>`;
}

function resetExpiredHTML() {
  return `<div class="auth">${brandHTML("")}
    <section class="card white"><div class="sent">${icon("link_off", "terracotta")}
      <p class="title-sm" role="alert">This link has expired. Request a new one.</p>
      <a class="btn block" href="#/forgot" style="margin-top:16px">${icon("lock_reset")}Request a new link</a></div></section></div>`;
}

/** The reset link being used, kept for this browser tab only (so reloading the page doesn't lose it). */
function keepReset(link) {
  state.reset = link;
  try {
    if (link && link.kind !== "expired") sessionStorage.setItem("fs.reset", JSON.stringify({ ...link, user: undefined }));
    else sessionStorage.removeItem("fs.reset");
  } catch { /* private mode: kept in memory only */ }
}

function savedReset() {
  try { return JSON.parse(sessionStorage.getItem("fs.reset") || "null"); } catch { return null; }
}

function renderReset(_arg, params) {
  const link = account.resetLinkFrom("", params) || state.reset || savedReset();
  if (link && link !== state.reset) keepReset(link);
  if (!state.reset || state.reset.kind === "expired") {
    view.innerHTML = resetExpiredHTML();
    return;
  }
  // The link's token stays out of the address bar (and out of the browser's history) from here on.
  if (params?.get("token_hash")) history.replaceState(null, "", "#/reset");
  view.innerHTML = `<div class="auth">${brandHTML("Choose a new password for your account.")}
    <section class="card white">
      <form id="reset-form" novalidate>
        <label class="field">New password<input id="reset-password" type="password" autocomplete="new-password" minlength="8" required></label>
        <label class="field">Confirm new password<input id="reset-confirm" type="password" autocomplete="new-password" minlength="8" required></label>
        <div class="row" style="margin-top:8px"><p class="body-sm t3">At least 8 characters.</p>
          <button type="button" class="chip-btn" data-action="show-passwords" aria-pressed="false">${icon("visibility")}Show</button></div>
        <p class="form-error" id="reset-error" role="alert" hidden></p>
        <button type="submit" class="btn block" style="margin-top:16px">${icon("lock_reset")}Set new password</button>
      </form>
    </section></div>`;
  $("#reset-password").focus();
}

async function submitReset(form) {
  const pw = $("#reset-password").value;
  const confirm = $("#reset-confirm").value;
  const err = $("#reset-error");
  const btn = form.querySelector('button[type="submit"]');
  const fail = (msg) => { err.textContent = msg; err.hidden = false; btn.disabled = false; btn.innerHTML = `${icon("lock_reset")}Set new password`; };
  if (pw.length < 8) return fail("Use a password of at least 8 characters.");
  if (pw !== confirm) return fail("The two passwords don't match. Type the same new password in both boxes.");
  btn.disabled = true;
  btn.textContent = "One moment…";
  try {
    // The link is only used now, so an email app that opens links to check them can't use it up first.
    if (!state.reset.user) state.reset.user = await account.useResetLink(state.reset);
  } catch {
    keepReset({ kind: "expired" });
    view.innerHTML = resetExpiredHTML();
    return;
  }
  try {
    await account.updatePassword(pw);
  } catch (e) {
    return fail(e.message);
  }
  state.user = state.reset.user;
  keepReset(null);
  await Promise.all([refreshFamily(), refreshProfile()]);
  updateHeader();
  location.replace("#/home");
  toast("Your password has been updated", "check");
}

/** The invite link's page: who invited you, then an account, then the code and a nickname. */
async function renderInvite(token) {
  setTitle("Join a family");
  if (!token) { location.replace("#/home"); return; }
  if (state.invite?.token !== token) {
    view.innerHTML = `<p class="note" style="padding-top:40px">Checking your invite…</p>`;
    let preview;
    try {
      preview = await account.invitePreview(token);
    } catch (e) {
      view.innerHTML = errorHTML(e);
      return;
    }
    state.invite = { token, preview };                        // kept in memory only, never on the phone
    if (route().name !== "invite") return;
  }
  const p = state.invite.preview;
  const goHome = state.user ? `<a class="btn secondary block" href="#/home">Go to Home</a>` : "";
  if (!p) {
    view.innerHTML = `<div class="auth">${brandHTML()}<div class="empty">${icon("error")}<b>This invite link isn't valid</b>
      Ask the person who invited you for a new link and code.</div>${goHome}</div>`;
    return;
  }
  if (p.status === "expired") {
    view.innerHTML = `<div class="auth">${brandHTML()}<div class="empty">${icon("schedule")}<b>This invite has expired</b>
      Ask ${esc(p.inviter || "the person who invited you")} for a new link and code.</div>${goHome}</div>`;
    return;
  }
  const banner = `<div class="invite-banner">${icon("group_add")}<div><p class="title-sm">${esc(p.inviter)} invited you to join ${esc(p.family_name)}</p>
    <p class="body-sm t2">${state.user ? "Enter the code they sent you in a separate message." : "Create an account or sign in first. Then you'll enter the code they sent you."}</p></div></div>`;
  if (!state.user) {
    view.innerHTML = `<div class="auth">${brandHTML("Shop the specials together, with one shared list.")}${banner}${authFormHTML()}</div>`;
    return;
  }
  if (state.family) {
    view.innerHTML = `<div class="auth">${banner}<div class="empty">${icon("group")}<b>You're already in ${esc(state.family.name)}</b>
      Leave it in Profile first to join another.</div><a class="btn secondary block" href="#/profile">Open Profile</a></div>`;
    return;
  }
  view.innerHTML = `<div class="auth">${banner}${joinFormHTML(p, true)}</div>`;
}

function joinFormHTML(p = {}, haveToken = false) {
  const who = p.inviter ? esc(p.inviter) : "";
  return `<section class="card white"><form id="join-form" novalidate>
      ${haveToken ? "" : `<label class="field plain">The invite link you were sent<input id="join-link" type="url" inputmode="url"
        autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="Paste the link here"></label>`}
      <label class="field plain"${haveToken ? ' style="margin-top:0"' : ""}>${who ? `Enter the 6-character code ${who} sent you` : "Enter the 6-character code you were sent"}
        <input id="join-code" class="code-input" type="text" inputmode="text" autocomplete="off" autocapitalize="characters"
          autocorrect="off" spellcheck="false" maxlength="12" placeholder="6 letters and numbers"></label>
      <label class="field plain">Your nickname in the family<input id="join-nickname" type="text" maxlength="30" autocomplete="nickname"
        placeholder="e.g. Mum, Dad or your name"></label>
      <p class="form-error" id="join-error" role="alert" hidden></p>
      <button type="submit" class="btn block" style="margin-top:16px">${icon("group_add")}Join</button>
    </form></section>`;
}

/** Profile > Join a family (paste the link, then the code), and the notice for links from the first version. */
function renderJoin(_arg, params) {
  if (params.get("code")) {
    // The first version put the code in the link. Those links no longer work, and the code is never kept.
    history.replaceState(null, "", "#/join");
    view.innerHTML = `<div class="auth">${brandHTML()}<div class="empty">${icon("link_off")}<b>This invite link no longer works</b>
      It's from an earlier version of the app. Ask the person who invited you for a new link and code.</div>
      ${state.user ? `<a class="btn secondary block" href="#/home">Go to Home</a>` : `<a class="btn block" href="#/welcome">Create an account or sign in</a>`}</div>`;
    return;
  }
  if (!state.user) { location.replace("#/welcome"); return; }
  if (state.family) {
    view.innerHTML = `<div class="empty">${icon("group")}<b>You're already in ${esc(state.family.name)}</b>
      Leave it in Profile first to join another.<br><a class="btn secondary small" href="#/profile" style="margin-top:14px">Open Profile</a></div>`;
    return;
  }
  state.invite = null;
  view.innerHTML = `<div style="padding-top:12px"><span class="caps terracotta">Shared Pantry</span>
      <h2 class="headline-lg" style="margin-top:2px">Join a family</h2>
      <p class="t2" style="margin-top:4px">Paste the invite link you were sent (or just open it), then type the code they sent separately.</p></div>
    ${joinFormHTML()}`;
}

async function submitJoin(form) {
  const p = state.invite?.preview || {};
  const token = state.invite?.token || account.tokenFrom($("#join-link")?.value);
  const code = account.cleanCode($("#join-code").value);
  const nickname = $("#join-nickname").value.trim();
  const err = $("#join-error");
  const btn = form.querySelector('button[type="submit"]');
  const fail = (msg) => { err.textContent = msg; err.hidden = false; btn.disabled = false; btn.innerHTML = `${icon("group_add")}Join`; };
  if (!token) return fail("Paste the invite link you were sent.");
  if (code.length !== 6) return fail("Enter the 6-character code.");
  if (!nickname) return fail("Add your nickname in the family.");
  btn.disabled = true;
  btn.textContent = "Joining…";
  let res;
  try {
    res = await account.joinFamily(token, code, nickname);
  } catch (e) {
    return fail(e.message);
  }
  if (res.status === "ok") {
    state.family = res.family;
    state.invite = null;
    applyFamilyMode();
    updateHeader();
    location.replace("#/joined");
    return;
  }
  fail(joinMessage(res, p.inviter));
}

/** What to tell someone whose join didn't work (the wording from the family spec). */
function joinMessage(res, inviter) {
  const who = res.inviter || inviter || "the person who invited you";
  switch (res.status) {
    case "wrong-code": return `That code doesn't match. Check the message from ${who} and try again.`;
    case "expired": return `This invite has expired. Ask ${who} for a new link and code.`;
    case "already-in-family": return `You're already in ${res.family_name}. Leave it in Profile first to join another.`;
    case "too-many": return "Too many attempts, try again in 15 minutes.";
    case "nickname": return "Add your nickname (up to 30 characters).";
    default: return "This invite link isn't valid. Ask for a new link and code.";
  }
}

function renderJoined() {
  const f = state.family;
  if (!f) { location.replace("#/home"); return; }
  setTitle(`Welcome to ${f.name}`);
  const tip = isStandalone() ? "" : `<section class="invite-banner">${icon("add_to_home_screen")}<div>
      <p class="title-sm">For the best experience, open this in ${isIOS() ? "Safari, then tap Share > Add to Home Screen" : "Chrome, then tap ⋮ > Add to Home screen"}</p>
      <p class="body-sm t2">You'll sign in once more there. Your family is already on your account.</p>
      <button type="button" class="btn small" data-action="copy-app-link" style="margin-top:10px">${icon("content_copy")}<span>Copy the app link</span></button></div></section>`;
  view.innerHTML = `<div class="auth">
      <div class="empty" style="padding-bottom:8px">${icon("celebration")}<b>Welcome to ${esc(f.name)}</b>
        You're in. The family's watchlist, shopping list and savings are now shared with you.</div>
      ${tip}
      <a class="btn block" href="#/home">Go to Home</a></div>`;
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
        <label class="field plain" style="margin-top:0">Family name<input id="family-name" type="text" maxlength="60" autocomplete="off" placeholder="What your family calls itself" required></label>
        <label class="field plain">Your nickname in the family<input id="family-nickname" type="text" maxlength="30" autocomplete="nickname"
          value="${esc(state.profile?.name || "")}" placeholder="e.g. Mum or Dad" required></label>
        <p class="body-sm t3" style="margin-top:6px">Shown to the people you invite ("${esc("Mum")} invited you").</p>
        <p class="form-error" id="family-error" role="alert" hidden></p>
        <button type="submit" class="btn block" style="margin-top:16px">${icon("group_add")}Create</button>
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
  let res;
  try {
    res = await account.createFamily(name, nickname);
  } catch (e) {
    return fail(e.message);
  }
  state.family = res.family;
  state.newInvite = { ...res.invite, familyId: res.family.id };   // the code lives in memory only
  applyFamilyMode();
  updateHeader();
  location.replace("#/family/invite");
}

/** Owner: the invite link and the join code, in two separate boxes. */
function renderFamilyInvite() {
  const f = state.family;
  if (!f) { location.replace("#/family/new"); return; }
  setTitle("Invite family");
  if (!f.is_owner) {
    view.innerHTML = `<div class="empty">${icon("group")}<b>${esc(f.name)}</b>Only the family's owner can invite people. Ask them for a link and code.
      <br><a class="btn secondary small" href="#/home" style="margin-top:14px">Back to Home</a></div>`;
    return;
  }
  const fresh = state.newInvite?.familyId === f.id ? state.newInvite : null;
  const token = fresh?.token || f.invite?.token;
  const expires = fresh?.expires_at || f.invite?.expires_at;
  const link = token ? account.inviteLink(token) : "";
  view.innerHTML = `
    <div style="padding-top:12px"><span class="caps terracotta">Invite to</span>
      <h2 class="headline-lg" style="margin-top:2px">${esc(f.name)}</h2></div>
    <p class="hint">${icon("info")} Send the link, then send the code in a separate message. The code expires in 7 days.</p>
    ${token ? `<section class="card white">
      <div class="row"><span class="caps t3">1 · Invite link</span>${expires ? `<span class="pill" style="background:var(--panel)">${icon("schedule")}Expires ${esc(day(expires))}</span>` : ""}</div>
      <p class="link-box mono">${esc(link)}</p>
      <div class="actions" style="margin-top:12px">
        <button type="button" class="btn small" data-action="copy" data-what="link">${icon("content_copy")}<span>Copy</span></button>
        <button type="button" class="btn outline small" data-action="share" data-what="link">${icon("ios_share")}<span>Share</span></button></div>
    </section>` : ""}
    <section class="card white">
      <div class="row"><span class="caps t3">${token ? "2 · " : ""}Join code</span></div>
      ${fresh ? `<div class="code-boxes" aria-label="Join code ${esc(fresh.code.split("").join(" "))}">${fresh.code.split("").map((ch) => `<span>${esc(ch)}</span>`).join("")}</div>
        <div class="actions" style="margin-top:12px"><button type="button" class="btn small" data-action="copy" data-what="code">${icon("content_copy")}<span>Copy</span></button></div>
        <p class="body-sm t3" style="margin-top:10px">For safety, the code is only shown now. If it gets lost, make a new code.</p>`
      : `<p class="body-sm t2" style="margin-top:8px">${token ? "For safety, a code is only shown once, when it's made. To send someone a code, make a new one (the current link and code will stop working)."
          : "There's no live invite. Make a new code to invite someone."}</p>`}
    </section>
    <button type="button" class="btn secondary block" data-action="new-code">${icon("sync")}Make a new code</button>
    <a class="btn block" href="#/home" style="margin-top:10px">Done</a>`;
}

async function makeNewCode() {
  const f = state.family;
  if (!f?.is_owner) return;
  if ((f.invite || state.newInvite) && !confirm("Make a new code? The current link and code stop working straight away.")) return;
  try {
    const inv = await account.newInvite();
    state.newInvite = { ...inv, familyId: f.id };
    state.family = account.cachedFamily() || f;
  } catch (e) {
    toast(e.message);
    return;
  }
  toast("New link and code made", "check");
  renderFamilyInvite();
}

async function copyInvite(btn, what) {
  const f = state.family;
  const fresh = state.newInvite?.familyId === f.id ? state.newInvite : null;
  const token = fresh?.token || f.invite?.token;
  const value = what === "code" ? fresh?.code : account.inviteLink(token);
  if (!value) return;
  if (!(await copyText(value))) { toast("Couldn't copy. Press and hold to select it instead."); return; }
  toast("Copied", "check");
  const label = btn.querySelector("span:last-child");
  label.textContent = "Copied";
  setTimeout(() => { label.textContent = "Copy"; }, 1600);
}

/** Share the link only (never the code) through the phone's share sheet. */
async function shareInvite() {
  const f = state.family;
  const token = (state.newInvite?.familyId === f.id ? state.newInvite.token : null) || f.invite?.token;
  const text = `Join ${f.name} on Family Specials: ${account.inviteLink(token)}`;
  if (navigator.share) {
    try {
      await navigator.share({ title: `Join ${f.name}`, text });
      return;
    } catch (e) {
      if (e.name === "AbortError") return;
    }
  }
  if (await copyText(text)) toast("Copied. Paste it into a message.", "check");
  else toast("Couldn't share from this browser.");
}

/** Home's Shared Pantry: the family's members, or how to start or join one. */
function pantryHTML() {
  if (!state.accountsOn || !state.user) {
    return `<section class="card white">
      <div class="member"><div class="row" style="justify-content:flex-start;gap:12px"><span class="avatar">Y<span class="online"></span></span>
        <div><p class="title-sm">You</p><p class="body-sm t2">On this phone</p></div></div>
        <span class="pill" style="background:var(--panel);color:var(--text-3);font-weight:400;letter-spacing:0">Just you for now</span></div>
      <p class="title-sm">Household Sync</p>
      <p class="body-sm t2" style="margin-top:2px">Share the watchlist, shopping list and savings with your family, with ticks syncing between phones.</p>
    </section>`;
  }
  const f = state.family;
  if (!f) {
    return `<section class="card white">
      <p class="title-sm">Shop together</p>
      <p class="body-sm t2" style="margin-top:2px">Share one watchlist, shopping list and savings tracker with your family, live on everyone's phone.</p>
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

/** Settings: where the family is managed (Profile). */
function accountSettingsHTML() {
  if (!state.accountsOn || !state.user) return "";
  const f = state.family;
  return `
    <div class="section-head" style="margin-top:8px"><h2 class="headline-sm">Family</h2><span class="caps t3">Shared Pantry</span></div>
    <a class="setting-card tap" href="#/profile" style="margin-top:10px;text-decoration:none">
      <span class="setting-icon">${icon("group")}</span>
      <div class="grow"><p class="title-md">${f ? esc(f.name) : "Not in a family yet"}</p>
        <p class="body-sm t2">${f ? `You're ${f.is_owner ? "the owner" : "a member"} · ${plural(f.members.length, "member")}` : "Start or join one"} · managed in Profile</p></div>
      ${icon("chevron_right", "t3")}</a>`;
}

async function refreshProfile() {
  if (!state.user) { state.profile = null; return null; }
  try {
    state.profile = await account.myProfile();
  } catch {
    state.profile = account.cachedProfile();          // offline: what we knew last time
  }
  return state.profile;
}

/** Who to show on the account icon: their photo (later), else initials from their name, nickname or email. */
function faceHTML() {
  if (!state.user) return icon("person");
  if (state.profile?.photo_url) return `<img src="${esc(state.profile.photo_url)}" alt="">`;
  const who = state.profile?.name || state.family?.me?.nickname || state.user.email || "?";
  return esc(state.profile?.name || state.family?.me?.nickname ? initials(who) : who[0].toUpperCase());
}

/** The family card in Profile: members, and the owner's and members' controls. */
function familyControlsHTML() {
  const f = state.family;
  if (!f) {
    return `<section class="card white" style="margin-top:10px">
      <p class="body-sm t2">Not in a family yet. Share one watchlist, shopping list and savings tracker with your family.</p>
      <div class="actions" style="margin-top:12px"><a class="btn small" href="#/family/new">${icon("group_add")}Start a family account</a>
        <a class="btn secondary small" href="#/join">${icon("person_add")}Join a family</a></div>
    </section>`;
  }
  const others = f.members.filter((m) => !m.is_me);
  const leaving = state.leaving && f.is_owner && others.length;
  return `<section class="card white" style="margin-top:10px">
    ${f.is_owner ? `<form id="rename-form" class="rename"><label class="field plain" style="margin-top:0;flex:1">Family name
        <input id="rename-input" type="text" maxlength="60" value="${esc(f.name)}" autocomplete="off"></label>
        <button type="submit" class="btn secondary small">Rename</button></form>`
      : `<p class="title-md">${esc(f.name)}</p><p class="body-sm t2">You're a member</p>`}
    <div class="list-rows" style="margin-top:12px">${f.members.map((m) => `<div class="row"><div class="row" style="justify-content:flex-start;gap:12px;min-width:0">
        <span class="avatar">${esc(initials(m.nickname))}</span>
        <div style="min-width:0"><p class="title-sm truncate">${esc(m.nickname)}${m.is_me ? ' <span class="t3" style="font-weight:400">(you)</span>' : ""}</p>
          <p class="body-sm t2">${m.role === "owner" ? "Owner" : "Member"}</p></div></div>
        ${f.is_owner && !m.is_me ? `<button type="button" class="btn secondary small" data-action="remove-member" data-id="${esc(m.user_id)}" data-name="${esc(m.nickname)}">Remove</button>`
          : m.role === "owner" ? `<span class="pill terra caps">Owner</span>` : ""}</div>`).join("")}</div>
    ${leaving ? `<form id="leave-form" class="leave-box">
        <label class="field plain" style="margin-top:0">Who should own ${esc(f.name)} after you leave?
          <select id="new-owner">${others.map((m) => `<option value="${esc(m.user_id)}">${esc(m.nickname)}</option>`).join("")}</select></label>
        <div class="actions" style="margin-top:12px"><button type="button" class="btn secondary small" data-action="cancel-leave">Cancel</button>
          <button type="submit" class="btn danger small">Hand over and leave</button></div></form>`
      : `<div class="actions" style="margin-top:14px">
        ${f.is_owner ? `<a class="btn small" href="#/family/invite">${icon("group_add")}Invite</a>` : ""}
        <button type="button" class="btn danger small" data-action="leave-family">${icon("logout")}Leave family</button></div>`}
  </section>`;
}

/** Profile (from the account menu): name, nickname in the family, email, the family and its controls, sign out. */
function renderProfile() {
  if (!state.user) { location.replace("#/welcome"); return; }
  const f = state.family;
  const p = state.profile || {};
  view.innerHTML = `
    <section class="card white profile-head" style="margin-top:8px">
      <span class="avatar lg">${faceHTML()}</span>
      <div class="grow"><p class="headline-sm truncate">${esc(p.name || f?.me?.nickname || "Your profile")}</p>
        <p class="body-sm t2 truncate">${esc(state.user.email)}</p></div>
    </section>
    <div class="section-head"><h2 class="headline-sm">About you</h2><span class="caps t3">Only you see your name</span></div>
    <section class="card white" style="margin-top:10px">
      <form id="profile-form" novalidate>
        <label class="field" style="margin-top:0">Your name<input id="profile-name" type="text" maxlength="60" autocomplete="name"
          value="${esc(p.name || "")}" placeholder="Optional"></label>
        ${f ? `<label class="field">Nickname in the family<input id="profile-nickname" type="text" maxlength="30" autocomplete="nickname"
          value="${esc(f.me.nickname)}" required></label>
          <p class="body-sm t3" style="margin-top:6px">Your family sees your nickname, not your name.</p>` : ""}
        <p class="form-error" id="profile-error" role="alert" hidden></p>
        <button type="submit" class="btn block" style="margin-top:16px">${icon("check")}Save</button>
      </form>
    </section>
    <div class="section-head"><h2 class="headline-sm">Family</h2>${f ? `<span class="caps t3">${f.is_owner ? "Owner" : "Member"}</span>` : ""}</div>
    ${familyControlsHTML()}
    <div class="section-head"><h2 class="headline-sm">Account</h2></div>
    <section class="card white" style="margin-top:10px">
      <div class="readonly"><span class="t2">Email</span><span class="truncate" style="max-width:65%">${esc(state.user.email)}</span></div>
      <div class="readonly"><span class="t2">Family</span><span class="truncate" style="max-width:65%">${f ? esc(f.name) : "Not in a family yet"}</span></div>
      <div class="readonly"><span class="t2">Role</span>${f ? `<span class="pill ${f.is_owner ? "terra" : "sage"} caps">${f.is_owner ? "Owner" : "Member"}</span>` : `<span class="t3">—</span>`}</div>
    </section>
    <button type="button" class="btn secondary block" data-action="sign-out" style="margin-top:16px">${icon("logout")}Sign out</button>
    <button type="button" class="btn danger block" data-action="delete-account" style="margin-top:10px">${icon("delete_sweep")}Delete account</button>
    <p class="note">We keep your email, a scrambled password and, if you add it, your name. Deleting your account removes them.</p>`;
}

async function submitProfile(form) {
  const name = $("#profile-name").value.trim();
  const nickEl = $("#profile-nickname");
  const nickname = nickEl ? nickEl.value.trim() : null;
  const err = $("#profile-error");
  const btn = form.querySelector('button[type="submit"]');
  const fail = (msg) => { err.textContent = msg; err.hidden = false; btn.disabled = false; };
  if (nickEl && !nickname) return fail("Add your nickname.");
  btn.disabled = true;
  try {
    state.profile = await account.updateProfile(name, nickname);
    state.family = account.cachedFamily() || state.family;
  } catch (e) {
    return fail(e.message);
  }
  updateHeader();
  toast("Saved", "check");
  renderProfile();
}

async function renameFamilyNow(form) {
  const name = $("#rename-input").value.trim();
  if (!name) { toast("Give the family a name."); return; }
  try {
    state.family = await account.renameFamily(name);
  } catch (e) {
    toast(e.message);
    return;
  }
  toast("Renamed", "check");
  render();
}

async function removeMemberNow(userId, nickname) {
  const f = state.family;
  if (!confirm(`Remove ${nickname} from ${f.name}? They'll lose access to the family's watchlist, list and savings.`)) return;
  try {
    state.family = await account.removeMember(userId);
  } catch (e) {
    toast(e.message);
    return;
  }
  toast(`${nickname} removed`);
  render();
}

async function leaveFamilyNow(newOwnerId = null) {
  const f = state.family;
  if (!f) return;
  const others = f.members.filter((m) => !m.is_me);
  if (f.is_owner && others.length && !newOwnerId) { state.leaving = true; render(); return; }
  const msg = f.is_owner && !others.length
    ? `You're the only one in ${f.name}. Leaving deletes it, with its list, watchlist and savings.`
    : f.is_owner ? `Hand ${f.name} to ${others.find((m) => m.user_id === newOwnerId)?.nickname} and leave?`
    : `Leave ${f.name}? Its list, watchlist and savings stay with the family.`;
  if (!confirm(msg)) return;
  try {
    await account.leaveFamily(newOwnerId);
  } catch (e) {
    toast(e.message);
    return;
  }
  state.leaving = false;
  data.forgetFamilyData(f.id);
  state.family = null;
  applyFamilyMode();
  updateHeader();
  toast(`You've left ${f.name}`);
  render();
}

// The account menu under the account icon: Profile, then Settings. Closes on an outside tap, Escape or a choice.
function setMenu(open, focusFirst = true) {
  const btn = $("#account-btn");
  const menu = $("#account-menu");
  menu.hidden = !open;
  btn.setAttribute("aria-expanded", String(open));
  if (open && focusFirst) menu.querySelector('[role="menuitem"]').focus();
}

$("#account-btn").addEventListener("click", () => setMenu($("#account-menu").hidden));
$("#account-btn").addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); setMenu(true); }
});
$("#account-menu").addEventListener("keydown", (e) => {
  const items = [...$("#account-menu").querySelectorAll('[role="menuitem"]')];
  const i = items.indexOf(document.activeElement);
  const go = (n) => { e.preventDefault(); items[(n + items.length) % items.length].focus(); };
  if (e.key === "ArrowDown") go(i + 1);
  else if (e.key === "ArrowUp") go(i - 1);
  else if (e.key === "Home") go(0);
  else if (e.key === "End") go(items.length - 1);
  else if (e.key === " ") { e.preventDefault(); document.activeElement.click(); }
  else if (e.key === "Escape") { e.preventDefault(); setMenu(false); $("#account-btn").focus(); }
  else if (e.key === "Tab") setMenu(false);
});
$("#account-menu").addEventListener("click", (e) => {
  if (e.target.closest('[role="menuitem"]')) setMenu(false);
});
document.addEventListener("pointerdown", (e) => {
  if (!$("#account-menu").hidden && !e.target.closest("#account-wrap")) setMenu(false);
});

/** The account icon in the top-right corner: the person's initials (or photo, later). */
function updateHeader() {
  $("#account-face").innerHTML = faceHTML();
  const who = state.profile?.name || state.family?.me?.nickname;
  $("#account-btn").setAttribute("aria-label", who ? `Account menu for ${who}` : "Account menu");
}

async function signOutNow() {
  const fid = state.family?.id;
  await sync.stop();
  await account.signOut().catch(() => {});
  if (fid) data.forgetFamilyData(fid);
  state.user = null;
  state.family = null;
  state.profile = null;
  applyFamilyMode();
  account.forgetFamily();
  updateHeader();
  toast("Signed out");
  location.replace("#/welcome");
}

async function deleteAccountNow() {
  const f = state.family;
  const others = f ? f.members.filter((m) => !m.is_me).length : 0;
  const what = f && f.is_owner ? (others ? ` ${f.name} will be handed to the longest-standing member.` : ` ${f.name} will be deleted too.`) : "";
  if (!confirm(`Delete your account for good? This removes your email and your place in the family.${what}`)) return;
  try {
    await account.deleteAccount();
  } catch (e) {
    toast(e.message);
    return;
  }
  await sync.stop();
  if (f) data.forgetFamilyData(f.id);
  state.user = null;
  state.family = null;
  state.profile = null;
  applyFamilyMode();
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
  } else if (action === "show-passwords") {
    const on = b.getAttribute("aria-pressed") !== "true";
    b.setAttribute("aria-pressed", String(on));
    b.innerHTML = `${icon(on ? "visibility_off" : "visibility")}${on ? "Hide" : "Show"}`;
    for (const id of ["#reset-password", "#reset-confirm"]) $(id).type = on ? "text" : "password";
  } else if (action === "week-tab") {
    e.preventDefault();
    state.weekTab = b.dataset.tab;
    state.weekShown = WEEK_PAGE;
    renderThisWeek();
  } else if (action === "week-more") {
    state.weekShown += 60;
    const y = window.scrollY;
    renderThisWeek();
    window.scrollTo(0, y);
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
      copyText(code).then((ok) => toast(ok ? "Code copied" : "Couldn't copy. Try Share code.", ok ? "check" : ""));
    }
  } else if (action === "auth-mode") {
    state.authMode = b.dataset.mode;
    render().then(() => $("#auth-email")?.focus());
  } else if (action === "copy") {
    copyInvite(b, b.dataset.what);
  } else if (action === "share") {
    shareInvite();
  } else if (action === "new-code") {
    makeNewCode();
  } else if (action === "copy-app-link") {
    copyText(appLink()).then((ok) => {
      toast(ok ? "App link copied. Paste it into Safari." : "Couldn't copy. Open Safari and type the address.", ok ? "check" : "");
      if (ok) { const l = b.querySelector("span:last-child"); if (l) l.textContent = "Copied"; }
    });
  } else if (action === "remove-member") {
    removeMemberNow(b.dataset.id, b.dataset.name);
  } else if (action === "leave-family") {
    leaveFamilyNow();
  } else if (action === "cancel-leave") {
    state.leaving = false;
    render();
  } else if (action === "stop-watching") {
    if (!confirm(`Stop watching ${b.dataset.name}? It comes off the watchlist for the whole family. You can watch it again from the Watchlist.`)) return;
    data.setWatching(b.dataset.key, false, { name: b.dataset.name });
    toast("Stopped watching");
    location.replace("#/watchlist");
  } else if (action === "watch-again") {
    data.setWatching(b.dataset.key, true, data.getWatchChanges().find((c) => c.watch_key === b.dataset.key)?.data || {});
    toast("Watching again", "check");
  } else if (action === "watch-product") {
    const prod = state.refs.get(b.dataset.ref).offer;
    data.setWatching(`product:${prod.id}`, true, { name: prod.name, store: prod.store, chain: prod.chain, unit_per: prod.unit?.per });
    toast("Added to the family's watchlist", "check");
    b.outerHTML = `<a class="btn outline small" href="${href(`product:${prod.id}`)}">${icon("bookmark")}Watched</a>`;
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
  if (e.target.id === "forgot-form") { e.preventDefault(); submitForgot(e.target); return; }
  if (e.target.id === "reset-form") { e.preventDefault(); submitReset(e.target); return; }
  if (e.target.id === "family-form") { e.preventDefault(); submitFamily(e.target); return; }
  if (e.target.id === "profile-form") { e.preventDefault(); submitProfile(e.target); return; }
  if (e.target.id === "join-form") { e.preventDefault(); submitJoin(e.target); return; }
  if (e.target.id === "rename-form") { e.preventDefault(); renameFamilyNow(e.target); return; }
  if (e.target.id === "leave-form") { e.preventDefault(); leaveFamilyNow($("#new-owner").value); return; }
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
  const [specials, watch, status] = await Promise.all([data.getSpecials(), data.getWatchlist(),
    data.getStatus().catch(() => null)]);
  state.specials = specials.specials;
  // Not in a family (or its watchlist isn't built yet): no watched items, every store's specials still show.
  state.watch = { history_started: null, min_history_weeks: 4, ...watch,
    stores: watch.stores?.length ? watch.stores : specials.stores || [],
    cycle_started: watch.cycle_started || specials.cycle_started, items: watch.items || [] };
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
  welcome: renderWelcome, join: renderJoin, family: renderFamily, profile: renderProfile,
  invite: renderInvite, joined: renderJoined, forgot: renderForgot, reset: renderReset,
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
  // With accounts switched on, everyone signs in first. An invite link's page opens without an account (on any
  // phone, even one that's never opened the app), and so does the notice for links from the first version.
  const open = r.name === "welcome" || r.name === "invite" || r.name === "forgot" || r.name === "reset"
    || (r.name === "join" && r.params.get("code"));
  if (state.accountsOn && !state.user && !open) {
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
  // Top-right on every tab (and an item's page): the bell, then the account icon in the corner.
  const onTab = !!TABS[r.name] || r.name === "watch";
  $("#bell").hidden = !onTab;
  $("#account-wrap").hidden = !(onTab || r.name === "alerts");
  setMenu(false, false);
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
  await ROUTES[r.name](r.arg, r.params);
}

let renderTimer = null;
function scheduleRender() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(() => {
    const active = document.activeElement;
    if (active && view.contains(active) && active.matches("input, textarea, select")) return;   // don't disturb typing
    const y = window.scrollY;
    render().then(() => window.scrollTo(0, y));
  }, 150);
}

const LIVE_SCREENS = new Set(["home", "this-week", "watchlist", "watch", "list", "savings", "alerts"]);
data.onDataChange(() => {
  updateBadge();
  if (LIVE_SCREENS.has(route().name)) scheduleRender();
});

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
  // A reset link from Supabase's standard email lands as #access_token=...&type=recovery (or #error=... when it has
  // expired). Keep what it brought, and take the tokens out of the address bar straight away.
  const resetLink = account.resetLinkFrom(location.hash);
  if (resetLink) {
    keepReset(resetLink);
    history.replaceState(null, "", "#/reset");
  }
  state.accountsOn = await account.available();
  if (state.accountsOn) {
    state.user = await account.currentUser();
    state.family = account.cachedFamily();
    state.profile = account.cachedProfile();
    if (state.user) applyFamilyMode();             // offline-first: the family's copy on this phone, straight away
    else state.family = null;
    // Every minute while the app is open, check the family (someone joined, was removed, renamed it).
    setInterval(() => {
      if (state.user && document.visibilityState === "visible") refreshFamily().then(updateHeader);
    }, 60000);
    if (state.user) {
      Promise.all([refreshFamily(), refreshProfile()]).then(() => {
        updateHeader();
        if (["home", "settings", "family", "join", "profile", "invite", "list", "watchlist"].includes(route().name)) render();
      });
    }
    account.onChange((u) => {
      if ((u?.id || null) === (state.user?.id || null)) return;
      state.user = u;
      state.family = null;
      state.profile = null;
      applyFamilyMode();
      updateHeader();
      if (!u && route().name !== "invite") location.replace("#/welcome");
    });
  }
  if (!location.hash) history.replaceState(null, "", "#/home");
  state.stack.push(location.hash);
  updateBadge();
  updateHeader();
  render();
}

start();
