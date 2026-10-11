// The data layer: the ONLY place the app reads data from.
//
// Today it fetches two JSON files published next to the page (GitHub Pages).
// A future native build (Capacitor) or a server can replace these functions,
// or point DATA_BASE somewhere else, without touching the screens in app.js.

const DATA_BASE = new URL("./data/", document.baseURI);
const cache = new Map();

async function getJSON(name) {
  if (!cache.has(name)) {
    const url = new URL(name, DATA_BASE);
    cache.set(name, fetch(url, { cache: "no-cache" }).then((res) => {
      if (!res.ok) throw new Error(`Couldn't load ${name} (${res.status})`);
      return res.json();
    }));
  }
  return cache.get(name);
}

/** Forget cached data so the next call re-downloads it (pull-to-refresh, app resume). */
export function refresh() {
  cache.clear();
}

/** All published products with their current price at one store. */
export async function getProducts() {
  const data = await getJSON("products.json");
  for (const p of data.products) {
    if (!p._words) p._words = words([p.name, p.brand, p.size, p.store].join(" "));
  }
  return data.products;
}

/** When each store was last updated, and where it updates from. */
export async function getStatus() {
  return getJSON("status.json");
}

/**
 * Search products.
 * @param {object} o
 * @param {string} o.query     words to match (each word matches the start of a word in the product)
 * @param {string[]} o.chains  stores to include (empty = all)
 * @param {boolean} o.specialsOnly
 * @param {"match"|"unit"|"price"|"saving"} o.sort
 */
export async function search({ query = "", chains = [], specialsOnly = true, sort = "match" } = {}) {
  const products = await getProducts();
  const terms = words(query);
  const results = [];
  for (const p of products) {
    if (chains.length && !chains.includes(p.chain)) continue;
    if (specialsOnly && !p.special) continue;
    let score = 0;
    let ok = true;
    for (const t of terms) {
      const hit = p._words.findIndex((w) => w.startsWith(t));
      if (hit < 0) { ok = false; break; }
      score += hit === 0 ? 3 : 1;
    }
    if (ok) results.push({ p, score });
  }
  const unit = (p) => bestUnit(p)?.cents ?? Infinity;
  const saving = (p) => (p.was_cents ? p.was_cents - p.price_cents : 0);
  const sorters = {
    match: (a, b) => b.score - a.score || unit(a.p) - unit(b.p),
    unit: (a, b) => unit(a.p) - unit(b.p) || a.p.price_cents - b.p.price_cents,
    price: (a, b) => (a.p.price_cents ?? Infinity) - (b.p.price_cents ?? Infinity),
    saving: (a, b) => saving(b.p) - saving(a.p),
  };
  results.sort(sorters[sort] || sorters.match);
  return results.map((r) => r.p);
}

/** The unit price to compare on: the multibuy's effective unit price if there is one. */
export function bestUnit(p) {
  return p.multibuy?.unit || p.unit || null;
}

function words(text) {
  return (text || "").toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}\s.]/gu, " ")
    .split(/\s+/).filter(Boolean);
}
