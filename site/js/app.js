// The screens. Reads and saves data only through data.js, so a native (Capacitor) build or a shared
// family account can swap the data layer without touching this file.
import * as data from "./data.js";
import * as push from "./push.js";

const $ = (s, el = document) => el.querySelector(s);
const view = $("#view");

const TABS = { "this-week": "This Week", watchlist: "Watchlist", home: "Home", list: "List", savings: "Savings" };
const SUB_SCREENS = { watch: { tab: "watchlist", up: "#/watchlist" }, alerts: { tab: "home", up: "#/home" },
  settings: { tab: null, up: "#/home" } };
const TIER_ORDER = { core: 0, regular: 1, occasional: 2 };
const TIER_LABEL = { core: "Core", regular: "Regular", occasional: "Occasional" };
// Tiers come from our receipts (core: bought in 4+ of the shops, regular: 3, occasional: 2), so these stay modest.
const TIER_REASON = { core: "You buy this often", regular: "You buy this regularly", occasional: "You buy this now and then" };
const NOTE_TEXT = { paused: "Paused, so no prices", "not found": "No match found", "no current price": "Matched, but no current price" };
const BASIS_TEXT = { online: "online price", "online, incl. delivery": "online price incl. delivery" };
const FROM_TEXT = { github: "updates automatically", mac: "updates from our Mac", paused: "paused" };
// Chart lines are told apart by dash pattern and marker shape (no colours).
const SERIES_STYLE = {
  woolworths: { dash: "", mark: "circle" }, aldi: { dash: "6 3", mark: "square" },
  costco: { dash: "2 3", mark: "triangle" }, chemistwarehouse: { dash: "9 3 2 3", mark: "diamond" },
  coles: { dash: "4 2", mark: "circle" },
};

const state = {
  watch: null, status: null, loadedAt: 0, offerToItem: new Map(), offersById: new Map(),
  query: "", searchSeq: 0, productsLoaded: false,
  refs: new Map(), expanded: new Set(), scroll: new Map(), stack: [],
};

// ------------------------------------------------------------------ formatting

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (c) => (c == null ? "no price" : "$" + (c / 100).toFixed(2));
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const SYD = { timeZone: "Australia/Sydney" };
const day = (iso) => new Date(iso).toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short", ...SYD });
const dateTime = (iso) => new Date(iso).toLocaleString("en-AU", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", ...SYD });
const localDate = (ymd, year = false) => new Date(ymd + "T12:00:00").toLocaleDateString("en-AU", { day: "numeric", month: "short", ...(year ? { year: "numeric" } : {}) });

/** "6.8¢" below a dollar, otherwise "$13.33". */
function amount(cents) {
  if (cents < 1) return cents.toFixed(2) + "¢";
  if (cents < 100) return cents.toFixed(1) + "¢";
  return money(cents);
}

/** "$13.33/kg", "6.8¢/tea bag", "$2.50 each". */
function unitMoney(cents, per) {
  if (cents == null) return "";
  return per === "item" ? `${amount(cents)} each` : `${amount(cents)}/${per}`;
}

const perPhrase = (per) => (per === "item" ? "per item" : `per ${per}`);

function listWords(names) {
  return names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
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
    return `Save ${money(o.price_cents - o.multibuy.each_cents)} each when you buy ${o.multibuy.qty}`;
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

/** Every watch item with a special at the compared stores; `best` is its lowest unit price special. */
function specialRows(chains) {
  const rows = [];
  for (const item of state.watch.items) {
    const offers = offersIn(item, chains);
    const specials = offers.filter((o) => o.special);
    if (specials.length) rows.push({ item, offers, specials, best: specials[0] });
  }
  return rows.sort((a, b) => (TIER_ORDER[a.item.tier] ?? 9) - (TIER_ORDER[b.item.tier] ?? 9)
    || savingShare(b.best) - savingShare(a.best) || a.item.name.localeCompare(b.item.name));
}

function savingShare(o) {
  if (o.was_cents && o.price_cents != null && o.was_cents > o.price_cents) return (o.was_cents - o.price_cents) / o.was_cents;
  if (o.multibuy && o.price_cents) return Math.max(0, (o.price_cents - o.multibuy.each_cents) / o.price_cents);
  return 0;
}

// ------------------------------------------------------------------ building blocks

const chip = (text, cls = "") => `<span class="chip ${cls}">${esc(text)}</span>`;

function chipsHTML(o) {
  const sig = o.signals || [];
  const out = [];
  if (o.special && !sig.some((s) => s.kind === "promo")) out.push(chip(o.promo || "Special", "solid"));
  for (const s of sig.filter((s) => s.kind === "promo")) out.push(chip(s.text, "solid"));
  if (!o.special && o.promo) out.push(chip(o.promo));
  if (o.new_this_cycle === true) out.push(chip("New this week", "strong"));
  const save = savingText(o);
  if (save) out.push(chip(save, "strong"));
  for (const s of sig.filter((s) => s.kind === "target")) out.push(chip(s.text, "strong"));
  for (const s of sig.filter((s) => s.kind === "warning")) out.push(chip(s.text, "warn"));
  if (o.valid_from && new Date(o.valid_from) > new Date()) out.push(chip(`from ${day(o.valid_from)}`));
  if (o.valid_to) out.push(chip(`ends ${day(o.valid_to)}${o.valid_to_assumed ? " (usual weekly end)" : ""}`));
  for (const s of sig.filter((s) => s.kind === "history")) out.push(chip(s.text));
  if (o.in_stock === false) out.push(chip("Out of stock online"));
  return out.length ? `<div class="chips">${out.join("")}</div>` : "";
}

/** One product at one store. `unit` and `mbUnit` are already-formatted unit prices. */
function offerHTML(o, { unit = "", mbUnit = "", showStore = true, action = "" } = {}) {
  const kg = o.price_per === "kg";
  const was = o.was_cents ? `was ${money(o.was_cents)}${kg ? "/kg" : ""}` : o.rrp_cents ? `RRP ${money(o.rrp_cents)}` : "";
  const meta = [unit && `<span class="unit">${unit}</span>`, was, BASIS_TEXT[o.basis]].filter(Boolean).join(" · ");
  const mb = o.multibuy ? `<div class="meta"><b>${o.multibuy.qty} for ${money(o.multibuy.cents)}</b> =
      ${money(o.multibuy.each_cents)} each${mbUnit ? " · " + mbUnit : ""}</div>` : "";
  return `<div class="offer">
    <div class="offer-body">
      ${o.image ? `<img class="thumb" loading="lazy" src="${esc(o.image)}" alt="">` : ""}
      <div class="grow">
        <div class="row">${showStore ? `<span class="store">${esc(o.store)}</span>` : "<span></span>"}
          <span class="price">${money(o.price_cents)}${kg ? "<small>/kg</small>" : ""}</span></div>
        <a class="product" href="${esc(o.url || "#")}" target="_blank" rel="noopener">${esc(o.name)}</a>
        ${meta ? `<div class="meta">${meta}</div>` : ""}${mb}${chipsHTML(o)}
      </div>
    </div>${action}</div>`;
}

/** A watch item's offer, with unit prices in the item's own unit (per kg, per can...). */
function watchOfferHTML(item, o, opts = {}) {
  const unit = o.unit_cents != null ? unitMoney(o.unit_cents, item.compare_per)
    : `<span class="faint">can't compare ${perPhrase(item.compare_per)}</span>`;
  return offerHTML(o, { unit, mbUnit: unitMoney(o.multibuy_unit_cents, item.compare_per), ...opts });
}

function ref(item, offer) {
  const id = String(state.refs.size + 1);
  state.refs.set(id, { item, offer });
  return id;
}

const addButton = (item, o, cls = "block") =>
  `<button type="button" class="btn ${cls}" data-action="add" data-ref="${ref(item, o)}">Add to list</button>`;

function errorHTML(e) {
  return `<div class="empty"><p><b>Couldn't load prices.</b></p><p>${esc(e.message)}</p>
    <p>Check your connection and try again.</p>
    <button type="button" class="btn secondary" data-action="retry">Try again</button></div>`;
}

function updatedLine(chains) {
  const times = (state.status?.stores || []).filter((s) => chains.has(s.chain) && s.last_updated).map((s) => s.last_updated).sort();
  return times.length ? `updated ${day(times[times.length - 1])}` : "";
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

// ------------------------------------------------------------------ Home

function renderHome() {
  const chains = comparedChains();
  const rows = specialRows(chains);
  const list = data.getList();
  const onListItems = new Set(list.items.map((x) => x.watchKey).filter(Boolean));
  const onListOffers = new Set(list.items.map((x) => x.id));

  // 1. Potential savings: the store's was price (or multibuy) on the best special for each item.
  let total = 0, counted = 0;
  for (const r of rows) {
    const s = savingCents(r.best);
    if (s != null) { total += s; counted += 1; }
  }
  const uncounted = rows.length - counted;
  const savings = rows.length
    ? `<a class="card tap hero" href="#/this-week">
        <div class="meta">Potential savings this week</div>
        ${counted ? `<div class="big">${money(total)}</div>
        <p>if you buy ${counted === rows.length ? "all " : ""}${plural(counted, "watched item")} on special${counted < rows.length ? ` (of ${rows.length})` : ""}</p>` :
        `<p><b>${plural(rows.length, "watched item")} on special</b>, but no was prices to work out a saving.</p>`}
        <p class="meta">Estimate: each store's was price minus the special price, buying one of each (or the multibuy
          number).${uncounted && counted ? ` ${plural(uncounted, "item")} with no was price ${uncounted === 1 ? "isn't" : "aren't"} counted.` : ""}</p>
      </a>`
    : `<a class="card tap hero" href="#/watchlist"><div class="meta">Potential savings this week</div>
        <p><b>Nothing on your watchlist is on special</b> at the stores you compare right now.</p></a>`;

  // 2. New on special this week: only specials we can confirm are new (we read the product the week before).
  const fresh = rows.map((r) => {
    const offer = r.specials.find((o) => o.new_this_cycle === true);
    return offer ? { ...r, offer } : null;
  }).filter(Boolean).sort((a, b) => (savingCents(b.offer) ?? 0) - (savingCents(a.offer) ?? 0)).slice(0, 5);
  const unsure = rows.filter((r) => !r.specials.some((o) => o.new_this_cycle === true)
    && r.specials.some((o) => o.new_this_cycle == null)).length;
  const freshRows = fresh.map(({ item, offer, best }) => {
    const better = bestUnit(best) != null && bestUnit(offer) != null && bestUnit(best) < bestUnit(offer);
    return `<div class="mini"><div class="grow">
        <a class="item-name" href="#/watch/${encodeURIComponent(item.key)}">${esc(item.name)}</a>
        <div class="meta">${esc(offer.store)} · <b>${money(offer.price_cents)}</b>${offer.was_cents ? ` · was ${money(offer.was_cents)}` : ""}</div>
        ${savingText(offer) ? `<div class="chips">${chip(savingText(offer), "strong")}</div>` : ""}
        ${better ? `<div class="meta">Better value on another special: ${unitMoney(bestUnit(best), item.compare_per)}</div>` : ""}
      </div>${onListOffers.has(offer.id) ? `<span class="chip">On list</span>` : addButton(item, offer, "small")}</div>`;
  }).join("");
  const freshCard = `<section class="card">${freshRows || `<p>Nothing we can confirm is new this week.</p>`}
    ${unsure ? `<p class="meta">${plural(unsure, "more item")} on special that we can't call new yet: it's the first week
      we've read ${unsure === 1 ? "it" : "them"}. This fills in after next week's update.</p>` : ""}</section>`;

  // 3. Recently added to the list.
  const recent = [...list.items].sort((a, b) => (b.addedAt || "").localeCompare(a.addedAt || "")).slice(0, 5);
  const t = listTotal(list.items);
  const listCard = list.items.length
    ? `<a class="card tap" href="#/list">
        ${recent.map((x) => `<div class="mini"><div class="grow"><p class="item-name">${esc(x.name)}</p>
          <div class="meta">${esc(x.store || "")}${x.qty > 1 ? ` · ${x.qty} ×` : ""} ${money(x.price_cents)}${x.price_per === "kg" ? "/kg" : ""}</div></div></div>`).join("")}
        <div class="mini"><div class="grow"><b>List total ${money(t.cents)}</b>
          <div class="meta">${plural(list.items.length, "item")}${t.perKg ? `, plus ${t.perKg} priced per kg` : ""}${t.unpriced ? `, ${t.unpriced} with no price` : ""}. Estimate at today's prices.</div></div>
          <svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg></div>
      </a>`
    : `<section class="card"><p>Nothing on your list yet.</p><p class="meta">Tap "Add to list" on a special to start it.</p></section>`;

  // 4. Recommended: watched items (from our receipts) on special now, not on the list, not already shown above.
  const shown = new Set(fresh.map((r) => r.item.key));
  const recs = rows.filter((r) => !shown.has(r.item.key) && !onListItems.has(r.item.key)).slice(0, 5);
  const recRows = recs.map(({ item, best }) => {
    const kg = best.price_per === "kg" ? "/kg" : "";
    const price = best.usual_cents && best.usual_cents > best.price_cents ? `On special, usually ${money(best.usual_cents)}${kg}`
      : best.was_cents ? `On special, was ${money(best.was_cents)}${kg}`
      : best.multibuy ? `Multibuy: ${best.multibuy.qty} for ${money(best.multibuy.cents)}` : "On special";
    return `<div class="mini"><div class="grow">
        <a class="item-name" href="#/watch/${encodeURIComponent(item.key)}">${esc(item.name)}</a>
        <div class="meta">${esc(TIER_REASON[item.tier] || "On your watchlist")} · ${esc(price)}</div>
        <div class="meta">${esc(best.store)} · <b>${money(best.price_cents)}${kg}</b></div>
      </div>${addButton(item, best, "small")}</div>`;
  }).join("");
  const recCard = `<section class="card">${recRows || `<p>Nothing else to suggest right now.</p>`}
    <p class="meta">Suggestions only come from your watchlist, which was built from your receipts. Items you're due to buy
      again will show here once the List records what you buy.</p></section>`;

  // 5. Family (fills in when family accounts arrive).
  const hh = data.getHousehold();
  const familyCard = `<section class="card">
    <div class="members">${hh.members.map((m) => `<span class="avatar" aria-hidden="true">${esc(m.name[0])}</span>`).join("")}
      <b>${hh.members.length === 1 ? "Just you for now" : esc(listWords(hh.members.map((m) => m.name)))}</b></div>
    <div class="row"><button type="button" class="btn secondary small" disabled>Invite family</button>
      ${hh.canInvite ? "" : `<span class="chip">Coming soon</span>`}</div></section>`;

  view.innerHTML = savings +
    `<div class="section-head"><h2>New on special this week</h2><a href="#/this-week">See all</a></div>${freshCard}
    <div class="section-head"><h2>Recently added to the list</h2>${list.items.length ? `<a href="#/list">Open list</a>` : ""}</div>${listCard}
    <div class="section-head"><h2>Recommended to add</h2></div>${recCard}
    <div class="section-head"><h2>Family</h2></div>${familyCard}
    <p class="note">Prices ${updatedLine(chains) || "not updated yet"}.${pausedChains().size ? ` ${esc(listWords([...pausedChains()].map(storeName)))} paused.` : ""}</p>`;
}

// ------------------------------------------------------------------ This Week

function renderThisWeek() {
  const chains = comparedChains();
  const rows = specialRows(chains);
  const names = [...chains].map(storeName);
  const paused = [...pausedChains()].map(storeName);
  const head = `<p class="meta">${plural(rows.length, "watched item")} on special at ${esc(listWords(names)) || "no stores"}
    ${updatedLine(chains) ? "· " + updatedLine(chains) : ""}.${paused.length ? ` ${esc(listWords(paused))} ${paused.length === 1 ? "is" : "are"} paused.` : ""}</p>`;

  if (!rows.length) {
    view.innerHTML = head + `<p class="empty">None of your watched items are on special at the stores you compare.
      <br><a href="#/watchlist">See the watchlist</a></p>`;
    return;
  }
  view.innerHTML = head + rows.map(({ item, offers, specials, best }) => {
    const bu = bestUnit(best);
    const normal = offers.find((o) => !o.special && bestUnit(o) != null);
    const cheaper = bu != null && normal && bestUnit(normal) < bu
      ? `<p class="meta">Cheaper without a special: <b>${unitMoney(bestUnit(normal), item.compare_per)}</b>
          at ${esc(normal.store)} (${esc(normal.name)})</p>` : "";
    const more = specials.length - 1;
    return `<article class="card">
      <div class="row"><span class="tier">${TIER_LABEL[item.tier] || ""}</span>
        <span class="meta">compared ${perPhrase(item.compare_per)}</span></div>
      <a class="item-name" href="#/watch/${encodeURIComponent(item.key)}">${esc(item.name)}</a>
      ${watchOfferHTML(item, best)}
      ${cheaper}
      <a class="linkbtn" href="#/watch/${encodeURIComponent(item.key)}">${more ? `+${plural(more, "more special")}, ` : ""}all stores and price history</a>
      ${addButton(item, best)}
    </article>`;
  }).join("");
}

// ------------------------------------------------------------------ Watchlist and search

function renderWatchlist() {
  const chains = comparedChains();
  const groups = new Map();
  for (const item of state.watch.items) {
    if (!groups.has(item.tier)) groups.set(item.tier, []);
    groups.get(item.tier).push(item);
  }
  const watched = [...groups].sort(([a], [b]) => (TIER_ORDER[a] ?? 9) - (TIER_ORDER[b] ?? 9)).map(([tier, items]) =>
    `<h2>${esc(TIER_LABEL[tier] || tier)} <span class="meta">(${items.length})</span></h2>` +
    items.map((item) => watchRow(item, chains)).join("")).join("");

  view.innerHTML = `
    <form class="search" role="search" id="search-form">
      <input id="q" type="search" placeholder="Search products to add" enterkeyhint="search" autocomplete="off"
        autocorrect="off" spellcheck="false" aria-label="Search products" value="${esc(state.query)}">
    </form>
    <div id="results" hidden></div>
    <div id="watched">
      <p class="meta">Tap an item for its price at each store and its price history.</p>
      ${watched}
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
  const best = offers[0];
  const stores = new Set(offers.map((o) => o.chain)).size;
  const bu = best && bestUnit(best);
  const right = best
    ? `<div class="unit">${bu != null ? unitMoney(bu, item.compare_per) : money(best.price_cents)}</div>
       <div class="meta">${bu != null ? "cheapest at " : ""}${esc(best.store)}</div>`
    : `<div class="meta">Not found yet</div>`;
  return `<a class="card tap wl" href="#/watch/${encodeURIComponent(item.key)}">
    <div class="grow"><p class="item-name">${esc(item.name)}</p>
      <div class="meta">${stores ? `${plural(offers.length, "product")} at ${plural(stores, "store")}` : "No matches at the stores you compare"}</div>
      ${offers.some((o) => o.special) ? `<div class="chips"><span class="chip solid">On special</span></div>` : ""}</div>
    <div class="right">${right}</div>
    <svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg></a>`;
}

async function renderResults() {
  const box = $("#results"), watched = $("#watched");
  if (!box) return;
  const q = state.query.trim();
  box.hidden = !q;
  watched.hidden = !!q;
  if (!q) return;
  const seq = ++state.searchSeq;
  if (!state.productsLoaded) box.innerHTML = `<p class="empty">Loading all products…</p>`;
  try {
    const limit = 40;
    const results = await data.searchProducts(q, { chains: [...comparedChains()], limit });
    state.productsLoaded = true;
    if (seq !== state.searchSeq) return;
    box.innerHTML = `<p class="meta">${results.length >= limit ? `Top ${limit}` : results.length} ${results.length === 1 ? "product" : "products"}.
        This searches the products we track: the store categories your watched items are in.</p>` +
      (results.map(productHTML).join("") || `<p class="empty">Nothing found.</p>`);
  } catch (e) {
    if (seq === state.searchSeq) box.innerHTML = errorHTML(e);
  }
}

function productHTML(p) {
  const item = state.offerToItem.get(p.id);
  const r = ref(null, p);
  const action = `<div class="actions">
      <button type="button" class="btn secondary small" data-action="add" data-ref="${r}">Add to list</button>
      ${item ? `<a class="btn secondary small" href="#/watch/${encodeURIComponent(item.key)}">Watched</a>`
             : `<button type="button" class="btn secondary small" data-action="suggest" data-ref="${r}">Suggest to watch</button>`}
    </div>`;
  return `<article class="card">${offerHTML(p, {
    unit: p.unit ? unitMoney(p.unit.cents, p.unit.per) : "",
    mbUnit: p.multibuy?.unit ? unitMoney(p.multibuy.unit.cents, p.multibuy.unit.per) : "", action })}</article>`;
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
    view.innerHTML = `<p class="empty">This item isn't on the watchlist any more.<br><a href="#/watchlist">Back to the watchlist</a></p>`;
    return;
  }
  setTitle(item.name);
  const chains = comparedChains();
  const offers = offersIn(item, chains);
  const best = offers.find((o) => bestUnit(o) != null);
  const settingsOff = new Set(data.getSettings().excludedChains);
  const paused = pausedChains();

  const sections = [];
  const notes = [];
  for (const { chain, name } of state.watch.stores) {
    if (paused.has(chain)) { notes.push([name, "Paused, so no prices"]); continue; }
    if (settingsOff.has(chain)) { notes.push([name, "Switched off in settings"]); continue; }
    const mine = offers.filter((o) => o.chain === chain);
    if (!mine.length) { notes.push([name, NOTE_TEXT[item.stores_note[chain]] || "No match found"]); continue; }
    const open = state.expanded.has(`${key}|${chain}`);
    const shown = open ? mine : mine.slice(0, 3);
    sections.push(`<section class="card">
      <div class="row"><span class="store">${esc(name)}</span><span class="meta">${plural(mine.length, "product")}</span></div>
      ${shown.map((o) => watchOfferHTML(item, o, { showStore: false, action: addButton(item, o, "secondary small add") })).join("")}
      ${mine.length > 3 ? `<button type="button" class="linkbtn" data-action="more" data-key="${esc(`${key}|${chain}`)}">
        ${open ? "Show fewer" : `Show all ${mine.length}`}</button>` : ""}
    </section>`);
  }

  view.innerHTML = `
    <section class="card">
      <span class="tier">${TIER_LABEL[item.tier] || ""}</span>
      <p>${esc(item.rule)}</p>
      <p class="meta">Compared ${perPhrase(item.compare_per)}${item.target_cents ? ` · your target ${unitMoney(item.target_cents, item.compare_per)}` : ""}</p>
      ${best ? `<p>Cheapest now: <b>${unitMoney(bestUnit(best), item.compare_per)}</b> at ${esc(best.store)}${best.special ? " (on special)" : ""}</p>` : ""}
    </section>
    <h2>Price history</h2>
    <section class="card chart">${chartHTML(item, chains)}</section>
    <h2>Prices now</h2>
    ${sections.join("") || `<p class="empty">No prices at the stores you compare.</p>`}
    ${notes.length ? `<section class="card">${notes.map(([n, t]) =>
      `<div class="setting"><b>${esc(n)}</b><span class="meta">${esc(t)}</span></div>`).join("")}</section>` : ""}
    <p class="note">Specials and their dates come from each store. We never guess when the next special will be.</p>`;
}

function marker(shape, x, y, filled) {
  const c = `pt${filled ? " special" : ""}`;
  const f = (n) => n.toFixed(1);
  if (shape === "square") return `<rect class="${c}" x="${f(x - 3.5)}" y="${f(y - 3.5)}" width="7" height="7"/>`;
  if (shape === "triangle") return `<path class="${c}" d="M${f(x)} ${f(y - 4.5)}L${f(x + 4.5)} ${f(y + 3.5)}H${f(x - 4.5)}Z"/>`;
  if (shape === "diamond") return `<path class="${c}" d="M${f(x)} ${f(y - 5)}L${f(x + 5)} ${f(y)}L${f(x)} ${f(y + 5)}L${f(x - 5)} ${f(y)}Z"/>`;
  return `<circle class="${c}" cx="${f(x)}" cy="${f(y)}" r="4"/>`;
}

/** Weekly lowest unit price at each store. Filled markers are weeks it was on special. */
function chartHTML(item, chains) {
  const h = item.history;
  const started = state.watch.history_started;
  const foot = `<p class="meta">Lowest price ${perPhrase(item.compare_per)} each week at each store.
    ${started ? `Price history started ${localDate(started, true)}.` : ""}
    "Lowest in N weeks" shows once we have ${state.watch.min_history_weeks} weeks.</p>`;
  const series = state.watch.stores.filter((s) => chains.has(s.chain) && (h.series[s.chain] || []).some((v) => v != null));
  if (!h.weeks.length || !series.length) return `<p class="meta">No price history yet at the stores you compare.</p>` + foot;

  const W = 340, H = 190, L = 50, R = 14, T = 12, B = 26;
  const vals = series.flatMap((s) => h.series[s.chain]).filter((v) => v != null);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  const pad = hi - lo < hi * 0.05 ? hi * 0.1 : (hi - lo) * 0.15;
  lo = Math.max(0, lo - pad);
  hi += pad;
  const n = h.weeks.length;
  const x = (i) => (n === 1 ? (L + W - R) / 2 : L + (i * (W - L - R)) / (n - 1));
  const y = (v) => T + ((hi - v) * (H - T - B)) / (hi - lo);

  const grid = [0.1, 0.5, 0.9].map((k) => {
    const v = lo + (hi - lo) * k;
    return `<line class="axis" x1="${L}" x2="${W - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/>
      <text x="${L - 6}" y="${(y(v) + 3).toFixed(1)}" text-anchor="end">${esc(amount(v))}</text>`;
  }).join("");
  const xIdx = n === 1 ? [0] : n < 5 ? [...Array(n).keys()] : [0, Math.floor((n - 1) / 2), n - 1];
  const xLabels = xIdx.map((i) => `<text x="${x(i).toFixed(1)}" y="${H - 8}" text-anchor="middle">${esc(localDate(h.weeks[i]))}</text>`).join("");

  const lines = series.map(({ chain }) => {
    const st = SERIES_STYLE[chain] || SERIES_STYLE.woolworths;
    const pts = h.series[chain];
    let d = "", pen = false;
    pts.forEach((v, i) => {
      if (v == null) { pen = false; return; }
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`;
      pen = true;
    });
    const marks = pts.map((v, i) => (v == null ? "" : marker(st.mark, x(i), y(v), h.specials[chain]?.[i]))).join("");
    return `<path class="series" d="${d}"${st.dash ? ` stroke-dasharray="${st.dash}"` : ""}/>${marks}`;
  }).join("");

  const legend = series.map(({ chain, name }) => {
    const st = SERIES_STYLE[chain] || SERIES_STYLE.woolworths;
    return `<span><svg viewBox="0 0 26 10" aria-hidden="true"><line x1="0" y1="5" x2="26" y2="5"${st.dash ? ` stroke-dasharray="${st.dash}"` : ""}/>${marker(st.mark, 13, 5, false)}</svg>${esc(name)}</span>`;
  }).join("") + `<span><svg viewBox="0 0 26 10" aria-hidden="true">${marker("circle", 13, 5, true)}</svg>on special that week</span>`;

  const label = `Price history ${perPhrase(item.compare_per)}: ` + series.map(({ chain, name }) => {
    const v = h.series[chain].filter((x) => x != null);
    return `${name} ${unitMoney(v[v.length - 1], item.compare_per)} latest`;
  }).join(", ");
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">${grid}${xLabels}${lines}</svg>
    <div class="legend">${legend}</div>${foot}`;
}

// ------------------------------------------------------------------ List (the full list is the next step)

function renderList() {
  const list = data.getList();
  if (!list.items.length) {
    view.innerHTML = `<p class="empty">Your list is empty.<br>Add specials from <a href="#/this-week">This Week</a>
      or the <a href="#/watchlist">Watchlist</a>.</p>`;
    return;
  }
  view.innerHTML = `<p class="meta">${plural(list.items.length, "item")}, saved on this phone.</p>` +
    list.items.map((x) => `<article class="card">
      <div class="row"><span class="store">${esc(x.store || "")}</span><span class="price">${x.qty > 1 ? `<small>${x.qty} ×</small> ` : ""}${money(x.price_cents)}${x.price_per === "kg" ? "<small>/kg</small>" : ""}</span></div>
      <p class="item-name">${esc(x.name)}</p>
      ${x.product && x.product !== x.name ? `<p class="meta">${esc(x.product)}</p>` : ""}
      ${x.special ? `<div class="chips"><span class="chip solid">On special when added</span></div>` : ""}
      <button type="button" class="linkbtn" data-action="remove" data-id="${esc(x.id)}">Remove</button>
    </article>`).join("") +
    `<p class="note">Coming next: ticking items off in the shop, totals for each store, where to shop, and sharing the list.</p>`;
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
        watchKey: item.key, name: item.name, chain, store: o.store, product: o.name, offerId: o.id,
        price_cents: o.price_cents, price_per: o.price_per, was_cents: o.was_cents,
        promo: o.signals?.find((s) => s.kind === "promo")?.text || o.promo || "Special",
        saving: savingText(o), valid_to: o.valid_to, valid_to_assumed: o.valid_to_assumed,
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

function renderAlerts() {
  const { alerts } = data.getAlerts();
  if (!alerts.length) {
    view.innerHTML = `<p class="empty">No alerts yet.<br>When a watched item goes on special, it shows up here.</p>`;
  } else {
    view.innerHTML = alerts.map((a) => `<article class="card${a.read ? "" : " unread"}">
        <div class="row"><span class="store">${esc(a.store)}</span><span class="meta">${a.read ? "" : "<b>New</b> · "}${esc(day(a.createdAt))}</span></div>
        <a class="item-name" href="#/watch/${encodeURIComponent(a.watchKey)}">${esc(a.name)}</a>
        <div class="meta">${esc(a.product)}</div>
        <div class="meta"><b>${money(a.price_cents)}${a.price_per === "kg" ? "/kg" : ""}</b>${a.was_cents ? ` · was ${money(a.was_cents)}` : ""}</div>
        <div class="chips">${chip(a.promo, "solid")}${a.saving ? chip(a.saving, "strong") : ""}${a.valid_to
          ? chip(`ends ${day(a.valid_to)}${a.valid_to_assumed ? " (usual weekly end)" : ""}`) : ""}</div>
      </article>`).join("");
  }
  view.innerHTML += `<p class="note">Alerts are made on this phone when the app finds a new special on your watchlist,
    at the stores you compare. Phone notifications aren't set up yet.</p>`;
  data.markAlertsRead();
  updateBell();
}

function renderSavings() {
  view.innerHTML = `<div class="empty"><p><b>Savings are coming soon.</b></p>
    <p>When you tick off a special you bought, we'll estimate what you saved: the normal shelf price minus the
      special price.</p></div>`;
}

// ------------------------------------------------------------------ Settings (grows into Account and Settings)

function renderSettings() {
  const off = new Set(data.getSettings().excludedChains);
  const status = new Map((state.status?.stores || []).map((s) => [s.chain, s]));
  const rows = state.watch.stores.map(({ chain, name }) => {
    const s = status.get(chain) || {};
    const paused = s.updates_from === "paused";
    const failed = !paused && s.last_attempt && s.last_attempt.status !== "ok";
    const lines = paused ? ["Paused: it blocked our reads, so there are no prices"]
      : [s.last_updated ? `Updated ${dateTime(s.last_updated)}` : "Not updated yet", FROM_TEXT[s.updates_from] || ""];
    if (failed) lines.push(`last try didn't work (${day(s.last_attempt.started_at)})`);
    return `<label class="setting">
      <div><b>${esc(name)}</b><div class="meta">${esc(lines.filter(Boolean).join(" · "))}</div>
        ${s.store && !paused ? `<div class="meta faint">${esc(s.store)}</div>` : ""}</div>
      <span class="switch"><input type="checkbox" data-chain="${esc(chain)}" aria-label="Compare ${esc(name)}"
        ${paused ? "disabled" : off.has(chain) ? "" : "checked"}><span></span></span></label>`;
  }).join("");
  const n = data.getList().items.length;
  view.innerHTML = `
    <h2>Notifications</h2>
    <section class="card" id="notify-card"><p class="meta">Checking this phone…</p></section>
    <h2>Stores to compare</h2>
    <section class="card" id="stores">${rows}</section>
    <h2>How our prices work</h2>
    <section class="card"><ul>
      <li>Shelf prices and specials only. Member prices (like Everyday Rewards), rewards dollars, delivery and bag fees are left out.</li>
      <li>Multibuys ("2 for $7") count as specials. We show the price per item and per unit.</li>
      <li>Items are compared on unit price: per kg, per litre, per can, per sheet and so on. Meat sold by weight is compared per kg.</li>
      <li>Woolworths prices come from its default online store, so your local shop can differ slightly.</li>
      <li>Costco prices are online prices that include delivery, so the warehouse is usually cheaper.</li>
      <li>Chemist Warehouse "off RRP" prices aren't counted as specials.</li>
      <li>Coles is paused: it blocked our reads, so there are no Coles prices.</li>
      <li>End dates come from the store. Woolworths doesn't publish them, so we show its usual weekly end (Tuesday) and say so.</li>
      <li>"Lowest in N weeks" needs at least ${state.watch.min_history_weeks} weeks of price history. We never predict the next special.</li>
    </ul></section>
    <h2>On this phone</h2>
    <section class="card">
      <div class="setting"><div><b>Shopping list</b><div class="meta">${plural(n, "item")}</div></div>
        <button type="button" class="btn secondary small" data-action="clear-list" ${n ? "" : "disabled"}>Clear</button></div>
      <div class="setting"><div><b>Savings</b><div class="meta">Not tracked yet</div></div>
        <button type="button" class="btn secondary small" data-action="clear-savings">Clear</button></div>
    </section>
    <h2>Account</h2>
    <section class="card"><p class="meta">Family accounts, alerts and receipts will live here later. For now, your list
      and settings are saved on this phone only.</p></section>
    <p class="note">Prices built ${state.status ? dateTime(state.status.generated_at) : "(unknown)"}.</p>`;
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
    <label class="setting"><div><b>Allow notifications</b><div class="meta">${sub ? "On for this phone" : esc(why || "Off for this phone")}</div></div>
      <span class="switch"><input type="checkbox" id="notify-switch" aria-label="Allow notifications on this phone"
        ${sub ? "checked" : ""} ${!sub && (!config || !sup.ok) ? "disabled" : ""}><span></span></span></label>
    ${sub ? `<div class="setting-block">
        <p><b>One more step:</b> copy this phone's code and add it on the Mac with <code>uv run specials notify add</code>.
          Nothing arrives until then.</p>
        <label class="field">This phone's name
          <input id="phone-name" type="text" value="${esc(name)}" maxlength="40" autocomplete="off"></label>
        <div class="actions">
          <button type="button" class="btn secondary small" data-action="copy-code">Copy code</button>
          <button type="button" class="btn secondary small" data-action="share-code">Share code</button></div>
      </div>` : ""}
    <p class="meta">A notification when a watched item goes on special (at most one per item each week), plus a weekly
      summary. Covers every store we have prices for. Each phone turns this on for itself.</p>`;
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
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
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
    chain: o.chain, store: o.store, url: o.url, price_cents: o.price_cents, price_per: o.price_per,
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
    toast(qty > 1 ? `On your list (${qty})` : "Added to list");
  } else if (action === "suggest") {
    suggest(state.refs.get(b.dataset.ref).offer);
  } else if (action === "more") {
    const k = b.dataset.key;
    state.expanded.has(k) ? state.expanded.delete(k) : state.expanded.add(k);
    render();
  } else if (action === "remove") {
    data.removeFromList(b.dataset.id);
    updateBadge();
    render();
  } else if (action === "clear-list") {
    if (confirm("Clear the shopping list on this phone?")) { data.clearList(); updateBadge(); render(); toast("List cleared"); }
  } else if (action === "clear-savings") {
    if (confirm("Clear the savings on this phone?")) { data.clearSavings(); toast("Savings cleared"); }
  } else if (action === "copy-code" || action === "share-code") {
    if (!state.pushSub) return;
    const name = ($("#phone-name")?.value || "").trim() || push.defaultPhoneName();
    data.setSettings({ phoneName: name });
    const code = push.codeFor(state.pushSub, name);
    if (action === "share-code" && navigator.share) {
      navigator.share({ title: "Notification code", text: code }).catch(() => {});
    } else {
      navigator.clipboard.writeText(code).then(() => toast("Code copied"), () => toast("Couldn't copy. Try Share code."));
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
  $("#back").hidden = !sub;
  $("#bell").hidden = r.name !== "home";          // the bell lives on Home only
  $("#gear").hidden = r.name === "settings";       // the gear is on every other screen
  setTitle(TABS[r.name] || { alerts: "Alerts", settings: "Settings" }[r.name] || "Watchlist");
  state.refs.clear();
  if (NEEDS_DATA.has(r.name) && !state.watch) {
    view.innerHTML = `<p class="empty">Loading prices…</p>`;
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

window.addEventListener("hashchange", async () => {
  const prev = state.stack[state.stack.length - 1];
  if (prev) state.scroll.set(prev, window.scrollY);
  if (state.stack[state.stack.length - 2] === location.hash) state.stack.pop();
  else state.stack.push(location.hash);
  await render();
  window.scrollTo(0, state.scroll.get(location.hash) || 0);
});

$("#back").addEventListener("click", () => {
  if (state.stack.length > 1) history.back();
  else location.replace(SUB_SCREENS[route().name]?.up || "#/home");
});

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
