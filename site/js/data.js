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

// ------------------------------------------------------------------ the shopping list, savings and watchlist
//
// Two modes, same functions for the screens:
//   - On your own: kept on this phone, as before.
//   - In a family: this phone keeps a copy of the family's list, savings and watchlist changes. sync.js sends
//     each change and brings in everyone else's, live. Changes made offline wait in an outbox. Every change carries
//     a time per field, and the latest change wins field by field (the same rule the server applies), so changes
//     from several phones merge and nothing is lost. Removals are kept as "removed" for the same reason.

let family = null;                       // { id, userId } while in a family
const listeners = new Set();
let queueHook = null;                    // sync.js: told when there's something to send

export function onDataChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function changed(what) {
  for (const fn of listeners) fn(what);
}

export function setQueueHook(fn) {
  queueHook = fn;
}

export function setFamilyMode(f) {
  const next = f ? { id: f.id, userId: f.userId } : null;
  if ((next?.id || null) === (family?.id || null) && (next?.userId || null) === (family?.userId || null)) return;
  family = next;
  changed("mode");
}

export function familyMode() {
  return family;
}

const nowIso = () => new Date().toISOString();
const ms = (s) => (s ? Date.parse(s) : 0);
const famKey = (what) => `fs.fam.${family.id}.${what}`;
const TABLE_KEY = { list: "item_key", savings: "entry_id", watch: "watch_key" };
// Field groups and the time each group last changed (mirrors the server's merge functions).
const GROUPS = {
  list: [[["qty"], "qty_changed"], [["ticked", "ticked_at"], "ticked_changed"], [["deleted"], "deleted_changed"]],
  savings: [[["deleted"], "deleted_changed"]],
  watch: [[["watching"], "watching_changed"]],
};
const SNAPSHOT = { list: ["data"], savings: ["data", "saving_cents", "saved_at"], watch: ["data"] };
const ADDED_BY = { list: "added_by", savings: "recorded_by", watch: "added_by" };
const REVIVE = { list: ["deleted", true], savings: ["deleted", true], watch: ["watching", false] };   // [field, "removed" value]

function rows(what) {
  return family ? load(famKey(what), {}) : {};
}

function saveRows(what, map) {
  save(famKey(what), map);
  save(famKey("touched"), nowIso());
}

/** The outbox: per table, each key waiting to be sent and a change number (so a change made while sending isn't lost). */
export function pending() {
  return family ? { list: {}, savings: {}, watch: {}, ...load(famKey("outbox"), {}) } : { list: {}, savings: {}, watch: {} };
}

function queue(what, key) {
  const o = pending();
  o[what][key] = (o[what][key] || 0) + 1;
  save(famKey("outbox"), o);
  queueHook?.();
}

/** sync.js: these were sent (key -> change number). Keys changed again since stay queued. */
export function markSent(what, sent) {
  const o = pending();
  for (const [key, n] of Object.entries(sent)) if (o[what][key] === n) delete o[what][key];
  save(famKey("outbox"), o);
}

export function rowFor(what, key) {
  return rows(what)[key] || null;
}

/**
 * Merge a row from the server with this phone's copy: the server's row, except for any field this phone changed
 * more recently (a change still on its way). Mirrors the server: a removed row comes back if something changed
 * after the removal.
 */
export function mergeRow(what, local, server) {
  if (!local) return { ...server };
  const r = { ...server };
  const [reviveField, removedValue] = REVIVE[what];
  for (const [fields, at] of GROUPS[what]) {
    if (ms(local[at]) > ms(server[at])) {
      for (const f of fields) r[f] = local[f];
      r[at] = local[at];
      if (fields.includes(reviveField) && local[reviveField] !== removedValue && server[reviveField] === removedValue) {
        for (const f of SNAPSHOT[what]) r[f] = local[f];          // added back here: with what was added
      }
    }
  }
  if (what === "list" && r.deleted && Math.max(ms(r.qty_changed), ms(r.ticked_changed)) > ms(r.deleted_changed)) r.deleted = false;
  return r;
}

/** sync.js: rows from the server (a first load, a live update, or the answer to a send). */
export function applyServerRows(what, list) {
  if (!family || !list?.length) return;
  const map = rows(what);
  const key = TABLE_KEY[what];
  for (const row of list) {
    if (row.family_id !== family.id) continue;
    map[row[key]] = mergeRow(what, map[row[key]], row);
  }
  saveRows(what, map);
  changed(what);
}

/** Leave family mode for good on this phone (left or removed): forget the family's copy here. */
export function forgetFamilyData(familyId) {
  try {
    for (const what of ["list", "savings", "watch", "outbox", "touched", "adopted"]) localStorage.removeItem(`fs.fam.${familyId}.${what}`);
  } catch { /* nothing saved */ }
}

/**
 * Move what's on this phone (its own list and savings) into the family, once, without duplicates: things the
 * family already has are skipped. Run after the family's rows have loaded.
 */
export function adoptPersonal() {
  if (!family || load(famKey("adopted"), false)) return 0;
  const personal = load(KEYS.list, { items: [] }).items;
  const personalSavings = load(KEYS.savings, { entries: [] }).entries;
  const list = rows("list");
  const savings = rows("savings");
  let moved = 0;
  const ts = nowIso();
  for (const x of personal) {
    if (list[x.id] && !list[x.id].deleted) continue;
    const { id, qty, ticked, tickedAt, ...rest } = x;
    list[id] = { family_id: family.id, item_key: id, data: clean(rest), qty: Math.min(99, qty || 1), qty_changed: ts,
      ticked: !!ticked, ticked_at: tickedAt || null, ticked_changed: ts, deleted: false, deleted_changed: ts,
      added_by: family.userId };
    queue("list", id);
    moved += 1;
  }
  for (const e of personalSavings) {
    if (savings[e.id]) continue;
    savings[e.id] = savingRow(e, ts);
    queue("savings", e.id);
  }
  saveRows("list", list);
  saveRows("savings", savings);
  save(KEYS.list, { items: [], updatedAt: ts });
  save(KEYS.savings, { entries: [] });
  save(famKey("adopted"), true);
  if (moved || personalSavings.length) changed("list");
  return moved;
}

function clean(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out;
}

const listKey = (entry) => entry.offerId || entry.watchKey || `own:${entry.name.toLowerCase()}`;

function itemFrom(row) {
  return { ...row.data, id: row.item_key, qty: row.qty, ticked: row.ticked, tickedAt: row.ticked_at,
    addedBy: row.added_by || null, addedAt: row.data?.addedAt || row.created_at || null };
}

/** The shopping list: { items, updatedAt }. In a family, each item also says who added it (addedBy). */
export function getList() {
  if (!family) return load(KEYS.list, { items: [], updatedAt: null });
  const items = Object.values(rows("list")).filter((r) => !r.deleted).map(itemFrom)
    .sort((a, b) => (a.addedAt || "").localeCompare(b.addedAt || ""));
  return { items, updatedAt: load(famKey("touched"), null) };
}

/** Is anything waiting to be sent to the family? */
export function hasUnsent() {
  const o = pending();
  return Object.keys(o.list).length + Object.keys(o.savings).length + Object.keys(o.watch).length > 0;
}

export function addToList(entry) {
  const ts = nowIso();
  const id = listKey(entry);
  if (!family) {
    const list = getList();
    const existing = list.items.find((x) => x.id === id);
    if (existing) existing.qty += 1;
    else list.items.push({ id, qty: 1, ticked: false, addedAt: ts, ...entry });
    list.updatedAt = ts;
    save(KEYS.list, list);
    return list;
  }
  const map = rows("list");
  const ex = map[id];
  if (ex && !ex.deleted) {
    ex.qty = Math.min(99, ex.qty + 1);
    ex.qty_changed = ts;
  } else {
    map[id] = { ...(ex || {}), family_id: family.id, item_key: id, data: clean({ ...entry, addedAt: ts }), qty: 1, qty_changed: ts,
      ticked: false, ticked_at: null, ticked_changed: ts, deleted: false, deleted_changed: ts, added_by: family.userId };
  }
  saveRows("list", map);
  queue("list", id);
  changed("list");
  return getList();
}

function changeListRow(id, fn) {
  const map = rows("list");
  if (!map[id]) return null;
  fn(map[id], nowIso());
  saveRows("list", map);
  queue("list", id);
  changed("list");
  return itemFrom(map[id]);
}

export function removeFromList(id) {
  if (!family) {
    const list = getList();
    list.items = list.items.filter((x) => x.id !== id);
    list.updatedAt = nowIso();
    save(KEYS.list, list);
    return list;
  }
  changeListRow(id, (r, ts) => { r.deleted = true; r.deleted_changed = ts; });
  return getList();
}

/** Tick an item off (or back on). Returns the item. */
export function setTicked(id, ticked) {
  if (!family) {
    const list = getList();
    const item = list.items.find((x) => x.id === id);
    if (!item) return null;
    item.ticked = ticked;
    item.tickedAt = ticked ? nowIso() : null;
    list.updatedAt = nowIso();
    save(KEYS.list, list);
    return item;
  }
  return changeListRow(id, (r, ts) => { r.ticked = ticked; r.ticked_at = ticked ? ts : null; r.ticked_changed = ts; });
}

export function removeTicked() {
  if (!family) {
    const list = getList();
    list.items = list.items.filter((x) => !x.ticked);
    list.updatedAt = nowIso();
    save(KEYS.list, list);
    return list;
  }
  for (const x of getList().items.filter((i) => i.ticked)) changeListRow(x.id, (r, ts) => { r.deleted = true; r.deleted_changed = ts; });
  return getList();
}

export function clearList() {
  if (!family) {
    save(KEYS.list, { items: [], updatedAt: nowIso() });
    return;
  }
  for (const x of getList().items) changeListRow(x.id, (r, ts) => { r.deleted = true; r.deleted_changed = ts; });
}

function savingRow(e, ts) {
  return { family_id: family.id, entry_id: e.id,
    data: clean({ watchKey: e.watchKey, name: e.name, product: e.product, chain: e.chain, store: e.store, qty: e.qty }),
    saving_cents: Math.max(0, Math.round(e.saving_cents)), saved_at: e.at || ts, deleted: false, deleted_changed: ts,
    recorded_by: family.userId };
}

/** Savings: one entry per special ticked off as bought (an estimate from shelf prices). */
export function getSavings() {
  if (!family) return { entries: [], ...load(KEYS.savings, {}) };
  const entries = Object.values(rows("savings")).filter((r) => !r.deleted)
    .map((r) => ({ ...r.data, id: r.entry_id, saving_cents: r.saving_cents, at: r.saved_at, recordedBy: r.recorded_by || null }));
  return { entries };
}

export function recordSaving(entry) {
  if (!family) {
    const s = getSavings();
    s.entries = s.entries.filter((e) => e.id !== entry.id);
    s.entries.push(entry);
    save(KEYS.savings, s);
    return;
  }
  const map = rows("savings");
  map[entry.id] = savingRow(entry, nowIso());
  saveRows("savings", map);
  queue("savings", entry.id);
  changed("savings");
}

export function removeSaving(id) {
  if (!family) {
    const s = getSavings();
    s.entries = s.entries.filter((e) => e.id !== id);
    save(KEYS.savings, s);
    return;
  }
  const map = rows("savings");
  if (!map[id]) return;
  map[id].deleted = true;
  map[id].deleted_changed = nowIso();
  saveRows("savings", map);
  queue("savings", id);
  changed("savings");
}

export function clearSavings() {
  if (!family) {
    save(KEYS.savings, { entries: [] });
    return;
  }
  for (const e of getSavings().entries) removeSaving(e.id);
}

/** The family's watchlist changes: [{ watch_key, watching, data, added_by }]. Empty when not in a family. */
export function getWatchChanges() {
  return Object.values(rows("watch"));
}

/** Start or stop watching something for the whole family (a watchlist item's key, or 'product:<id>'). */
export function setWatching(key, watching, info = {}) {
  if (!family) return;
  const map = rows("watch");
  const prev = map[key];
  map[key] = { ...(prev || {}), family_id: family.id, watch_key: key, data: clean(watching ? info : (prev?.data || info)),
    watching, watching_changed: nowIso(), added_by: watching ? family.userId : (prev?.added_by || null) };
  saveRows("watch", map);
  queue("watch", key);
  changed("watch");
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
