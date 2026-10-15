// The screens. Reads data only through data.js.
import { bestUnit, getStatus, refresh, search } from "./data.js";

const STORES = [
  ["woolworths", "Woolworths"], ["coles", "Coles"], ["chemistwarehouse", "Chemist Warehouse"],
  ["costco", "Costco"], ["aldi", "ALDI"],
];
const $ = (s) => document.querySelector(s);
const state = { query: "", chains: [], specialsOnly: true, sort: "match", view: "search" };

const money = (c) => (c == null ? "no price" : "$" + (c / 100).toFixed(2));
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const unitText = (u) => (u ? `${money(u.cents)}/${u.per}` : "");
const date = (iso) => new Date(iso).toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short", timeZone: "Australia/Sydney" });
const dateTime = (iso) => new Date(iso).toLocaleString("en-AU", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Australia/Sydney" });

function card(p) {
  const tags = [];
  if (p.special) tags.push(`<span class="tag strong">${esc(p.promo || "Special")}</span>`);
  else if (p.promo) tags.push(`<span class="tag">${esc(p.promo)}</span>`);
  if (p.valid_from && new Date(p.valid_from) > new Date()) tags.push(`<span class="tag">from ${date(p.valid_from)}</span>`);
  if (p.valid_to) tags.push(`<span class="tag">ends ${date(p.valid_to)}${p.valid_to_assumed ? " (weekly cycle)" : ""}</span>`);
  if (p.in_stock === false) tags.push(`<span class="tag">out of stock online</span>`);

  const lines = [];
  const unit = unitText(p.unit) || p.store_unit_text || "";
  const was = p.was_cents ? `was ${money(p.was_cents)}` : p.rrp_cents ? `RRP ${money(p.rrp_cents)}` : "";
  lines.push([unit, was].filter(Boolean).join(" · "));
  if (p.multibuy) {
    const m = p.multibuy;
    lines.push(`<b>${m.qty} for ${money(m.cents)}</b> = ${money(Math.round(m.each_cents))} each${m.unit ? " · " + unitText(m.unit) : ""}`);
  }
  lines.push(esc(p.basis));

  return `<article class="item">
    ${p.image ? `<img loading="lazy" src="${esc(p.image)}" alt="">` : `<div class="noimg"></div>`}
    <div class="body">
      <div class="top"><span class="store">${esc(p.store)}</span>
        <span class="price">${money(p.price_cents)}${p.price_per === "kg" ? "<small>/kg</small>" : ""}</span></div>
      <a class="name" href="${esc(p.url || "#")}" target="_blank" rel="noopener">${esc(p.name)}</a>
      ${lines.filter(Boolean).map((l) => `<div class="meta">${l}</div>`).join("")}
      ${tags.length ? `<div class="tags">${tags.join("")}</div>` : ""}
    </div></article>`;
}

async function renderSearch() {
  const list = $("#results");
  try {
    const results = await search(state);
    $("#count").textContent = `${results.length} ${results.length === 1 ? "product" : "products"}` +
      (state.specialsOnly ? " on special" : "");
    list.innerHTML = results.slice(0, 200).map(card).join("") ||
      `<p class="empty">Nothing found.${state.specialsOnly ? " Try including regular prices." : ""}</p>`;
  } catch (e) {
    list.innerHTML = `<p class="empty">Couldn't load prices. ${esc(e.message)}</p>`;
  }
}

async function renderStatus() {
  const el = $("#stores");
  try {
    const s = await getStatus();
    const where = { github: "automatic", mac: "from our Mac", paused: "paused" };
    el.innerHTML = s.stores.map((x) => `<div class="store-row">
        <div><b>${esc(x.name)}</b><div class="meta">${esc(x.store)}</div></div>
        <div class="right">${x.last_updated ? esc(dateTime(x.last_updated)) : "not yet"}
          <div class="meta">${esc(where[x.updates_from] || x.updates_from)} · ${x.products} products</div></div>
      </div>`).join("") + `<p class="meta">Data built ${esc(dateTime(s.generated_at))}.</p>`;
  } catch (e) {
    el.innerHTML = `<p class="empty">Couldn't load store status.</p>`;
  }
}

function show(view) {
  state.view = view;
  document.querySelectorAll("[data-view]").forEach((b) => b.setAttribute("aria-current", b.dataset.view === view ? "page" : "false"));
  $("#view-search").hidden = view !== "search";
  $("#view-stores").hidden = view !== "stores";
  if (view === "stores") renderStatus();
}

function setup() {
  $("#chains").innerHTML = STORES.map(([k, v]) =>
    `<button type="button" class="chip" data-chain="${k}" aria-pressed="false">${v}</button>`).join("");
  let timer;
  $("#q").addEventListener("input", (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => { state.query = e.target.value; renderSearch(); }, 150);
  });
  $("#search-form").addEventListener("submit", (e) => { e.preventDefault(); $("#q").blur(); });
  $("#chains").addEventListener("click", (e) => {
    const b = e.target.closest("[data-chain]");
    if (!b) return;
    const on = b.getAttribute("aria-pressed") !== "true";
    b.setAttribute("aria-pressed", String(on));
    state.chains = [...document.querySelectorAll('[data-chain][aria-pressed="true"]')].map((x) => x.dataset.chain);
    renderSearch();
  });
  $("#specials-only").addEventListener("change", (e) => { state.specialsOnly = e.target.checked; renderSearch(); });
  $("#sort").addEventListener("change", (e) => { state.sort = e.target.value; renderSearch(); });
  document.querySelectorAll("[data-view]").forEach((b) => b.addEventListener("click", () => show(b.dataset.view)));
  // Re-download data when the app comes back to the foreground.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") { refresh(); renderSearch(); if (state.view === "stores") renderStatus(); }
  });
  renderSearch();
  getStatus().then((s) => {
    const latest = s.stores.map((x) => x.last_updated).filter(Boolean).sort().pop();
    $("#updated").textContent = latest ? `Updated ${dateTime(latest)}` : "";
  }).catch(() => {});
}

if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}
setup();
