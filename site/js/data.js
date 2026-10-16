// The data layer: the ONLY place the app reads or saves data.
//
// Prices come from JSON files published next to the page (GitHub Pages). The shopping list and
// settings are saved on this phone (localStorage) for now. A future native build (Capacitor) or a
// shared family account can replace the functions in this file without touching the screens.

const DATA_BASE = new URL("./data/", document.baseURI);
const cache = new Map();

async function getJSON(name) {
  if (!cache.has(name)) {
    const url = new URL(name, DATA_BASE);
    cache.set(name, fetch(url, { cache: "no-cache" }).then((res) => {
      if (!res.ok) throw new Error(`Couldn't load ${name} (${res.status})`);
      return res.json();
    }).catch((e) => { cache.delete(name); throw e; }));
  }
  return cache.get(name);
}

/** Forget downloaded prices so the next call fetches fresh ones (e.g. when the app is reopened). */
export function refresh() {
  cache.clear();
}

// ------------------------------------------------------------------ prices and the watchlist

/** The watchlist with each item's current offers, history and signals. */
export async function getWatchlist() {
  return getJSON("watchlist.json");
}

export async function getWatchItem(key) {
  const w = await getWatchlist();
  return w.items.find((i) => i.key === key) || null;
}

/** Phone notification settings published with the app (the public key that phones subscribe with). */
export async function getPushConfig() {
  const res = await fetch(new URL("./push.json", document.baseURI), { cache: "no-cache" });
  if (!res.ok) throw new Error("Notifications aren't set up yet");
  return res.json();
}

/** When each store was last updated, and where it updates from. */
export async function getStatus() {
  return getJSON("status.json");
}

/** Every published product (large: only loaded when someone searches). */
export async function getProducts() {
  const data = await getJSON("products.json");
  for (const p of data.products) {
    if (!p._words) p._words = words([p.name, p.brand, p.size, p.store].join(" "));
  }
  return data.products;
}

/** Search all published products: each word must match the start of a word in the product. */
export async function searchProducts(query, { chains = [], limit = 60 } = {}) {
  const terms = words(query);
  if (!terms.length) return [];
  const products = await getProducts();
  const out = [];
  for (const p of products) {
    if (chains.length && !chains.includes(p.chain)) continue;
    let score = 0;
    let ok = true;
    for (const t of terms) {
      const hit = p._words.findIndex((w) => w.startsWith(t));
      if (hit < 0) { ok = false; break; }
      score += hit === 0 ? 3 : 1;
    }
    if (ok) out.push({ p, score });
  }
  out.sort((a, b) => b.score - a.score || (b.p.special - a.p.special) || a.p.price_cents - b.p.price_cents);
  return out.slice(0, limit).map((x) => x.p);
}

function words(text) {
  return (text || "").toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}\s.]/gu, " ").split(/\s+/).filter(Boolean);
}

// ------------------------------------------------------------------ on this phone (for now)

const KEYS = { list: "fs.list.v1", settings: "fs.settings.v1", savings: "fs.savings.v1", alerts: "fs.alerts.v1" };

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;   // private mode or storage full: the app still works, it just won't remember
  }
}

/** Settings: which stores to compare (all with data, unless switched off), and this phone's name. */
export function getSettings() {
  return { excludedChains: [], phoneName: "", ...load(KEYS.settings, {}) };
}

export function setSettings(patch) {
  const next = { ...getSettings(), ...patch };
  save(KEYS.settings, next);
  return next;
}

/** The shopping list (saved on this phone; designed to move to a family account later). */
export function getList() {
  return load(KEYS.list, { items: [], updatedAt: null });
}

export function addToList(entry) {
  const list = getList();
  const id = entry.offerId || entry.watchKey || entry.name;
  const existing = list.items.find((x) => x.id === id);
  if (existing) existing.qty += 1;
  else list.items.push({ id, qty: 1, ticked: false, addedAt: new Date().toISOString(), ...entry });
  list.updatedAt = new Date().toISOString();
  save(KEYS.list, list);
  return list;
}

export function removeFromList(id) {
  const list = getList();
  list.items = list.items.filter((x) => x.id !== id);
  list.updatedAt = new Date().toISOString();
  save(KEYS.list, list);
  return list;
}

export function clearList() {
  save(KEYS.list, { items: [], updatedAt: new Date().toISOString() });
}

export function getSavings() {
  return load(KEYS.savings, { entries: [] });
}

export function clearSavings() {
  save(KEYS.savings, { entries: [] });
}

// ------------------------------------------------------------------ alerts (made on this phone for now)

/** Alerts newest first. `seen` remembers every special already alerted, so each one alerts once. */
export function getAlerts() {
  return { alerts: [], seen: [], ...load(KEYS.alerts, {}) };
}

/** Add an alert for each candidate special this phone hasn't alerted before. Returns how many were added. */
export function recordAlerts(candidates) {
  const a = getAlerts();
  const seen = new Set(a.seen);
  const now = new Date().toISOString();
  let added = 0;
  for (const c of candidates) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    a.alerts.unshift({ ...c, createdAt: now, read: false });
    added += 1;
  }
  if (added) {
    a.alerts = a.alerts.slice(0, 200);
    a.seen = [...seen].slice(-2000);
    save(KEYS.alerts, a);
  }
  return added;
}

export function unreadAlertCount() {
  return getAlerts().alerts.filter((x) => !x.read).length;
}

export function markAlertRead(id) {
  const a = getAlerts();
  const hit = a.alerts.find((x) => x.id === id && !x.read);
  if (!hit) return;
  hit.read = true;
  save(KEYS.alerts, a);
}

/** Forget the alerts on this phone (they're kept in `seen`, so the same specials don't alert again). */
export function clearAlerts() {
  const a = getAlerts();
  save(KEYS.alerts, { alerts: [], seen: a.seen });
}

export function markAlertsRead() {
  const a = getAlerts();
  if (!a.alerts.some((x) => !x.read)) return;
  a.alerts.forEach((x) => { x.read = true; });
  save(KEYS.alerts, a);
}

// ------------------------------------------------------------------ household (family accounts later)

/** Who shares this list. Just this phone's user for now; family accounts will fill this in. */
export function getHousehold() {
  return { members: [{ id: "me", name: "You", you: true }], canInvite: false };
}
