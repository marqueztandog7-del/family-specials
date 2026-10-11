"""The search page and JSON API. Run with `uv run specials serve`."""

from __future__ import annotations

from fastapi import FastAPI, Query
from fastapi.responses import HTMLResponse

from . import db
from .search import search, status

app = FastAPI(title="Family Specials Finder")


@app.get("/api/search")
def api_search(
    q: str,
    chain: list[str] | None = Query(None),
    specials_only: bool = True,
    sort: str = "relevance",
    limit: int = 60,
):
    conn = db.connect()
    try:
        return {"query": q, "results": search(conn, q, chains=chain, specials_only=specials_only,
                                              sort=sort, limit=min(limit, 200))}
    finally:
        conn.close()


@app.get("/api/status")
def api_status():
    conn = db.connect()
    try:
        return status(conn)
    finally:
        conn.close()


@app.get("/", response_class=HTMLResponse)
def page() -> str:
    return PAGE


PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Family Specials</title>
<style>
  :root { --bg:#fafafa; --card:#fff; --ink:#111; --muted:#666; --line:#ddd; --soft:#f0f0f0; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#111; --card:#1b1b1b; --ink:#eee; --muted:#9a9a9a; --line:#333; --soft:#242424; }
  }
  * { box-sizing: border-box; }
  body { margin:0; font:16px/1.4 -apple-system, system-ui, sans-serif; background:var(--bg); color:var(--ink); }
  header { padding:16px; border-bottom:1px solid var(--line); background:var(--card); position:sticky; top:0; }
  h1 { font-size:18px; margin:0 0 10px; }
  form { display:flex; gap:8px; }
  input[type=search] { flex:1; font-size:16px; padding:10px 12px; border:1px solid var(--line); border-radius:8px;
    background:var(--bg); color:var(--ink); min-width:0; }
  button { font-size:16px; padding:10px 14px; border:0; border-radius:8px; background:var(--ink); color:var(--bg); }
  .filters { display:flex; flex-wrap:wrap; gap:6px 14px; margin-top:10px; font-size:14px; color:var(--muted); }
  .filters label { white-space:nowrap; }
  main { padding:12px 16px 40px; max-width:820px; margin:0 auto; }
  .note { color:var(--muted); font-size:14px; margin:8px 0 14px; }
  .item { display:flex; gap:12px; padding:12px; background:var(--card); border:1px solid var(--line);
    border-radius:10px; margin-bottom:10px; }
  .item img { width:64px; height:64px; object-fit:contain; background:#fff; border-radius:6px; flex:none; }
  .body { min-width:0; flex:1; }
  .top { display:flex; justify-content:space-between; gap:8px; align-items:baseline; }
  .store { font-size:13px; font-weight:600; text-transform:uppercase; letter-spacing:.03em; }
  .price { font-size:20px; font-weight:700; white-space:nowrap; }
  .name { margin:2px 0; overflow-wrap:anywhere; }
  .name a { color:inherit; text-decoration:none; }
  .meta { font-size:13px; color:var(--muted); }
  .tag { display:inline-block; font-size:12px; padding:1px 7px; border:1px solid var(--ink); border-radius:999px;
    margin:4px 6px 0 0; }
  .tag.soft { border-color:var(--line); color:var(--muted); }
  .status { font-size:13px; color:var(--muted); border-top:1px solid var(--line); margin-top:24px; padding-top:12px; }
  .status div { margin:2px 0; }
</style>
</head>
<body>
<header>
  <h1>Family Specials</h1>
  <form id="f">
    <input id="q" type="search" placeholder="Search specials, e.g. milk, rice, Colgate" autocomplete="off" autofocus>
    <button>Search</button>
  </form>
  <div class="filters">
    <label><input type="checkbox" id="all"> Include regular prices</label>
    <label>Sort <select id="sort"><option value="relevance">best match</option><option value="price">price</option>
      <option value="saving">biggest saving</option></select></label>
    <span id="chains"></span>
  </div>
</header>
<main>
  <div class="note" id="note">Prices are what each store showed when we last collected. Specials only, unless you tick
    "Include regular prices".</div>
  <div id="results"></div>
  <div class="status" id="status"></div>
</main>
<script>
const CHAINS = {woolworths:"Woolworths", coles:"Coles", aldi:"ALDI", costco:"Costco", chemistwarehouse:"Chemist Warehouse", tongli:"Tong Li"};
const $ = s => document.querySelector(s);
$("#chains").innerHTML = Object.entries(CHAINS).map(([k,v]) =>
  `<label><input type="checkbox" class="chain" value="${k}" checked> ${v}</label>`).join(" ");
const money = c => c == null ? "n/a" : "$" + (c/100).toFixed(2);
const esc = s => (s ?? "").toString().replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));

async function run() {
  const q = $("#q").value.trim();
  if (!q) return;
  const p = new URLSearchParams({q, specials_only: !$("#all").checked, sort: $("#sort").value});
  document.querySelectorAll(".chain:checked").forEach(c => p.append("chain", c.value));
  $("#results").innerHTML = "<div class='note'>Searching…</div>";
  const r = await fetch("/api/search?" + p).then(r => r.json());
  if (!r.results.length) { $("#results").innerHTML = "<div class='note'>No matches.</div>"; return; }
  $("#results").innerHTML = r.results.map(x => {
    const tags = [];
    if (x.is_special) tags.push(`<span class="tag">${esc(x.promo_text || "Special")}</span>`);
    else if (x.promo_text) tags.push(`<span class="tag soft">${esc(x.promo_text)}</span>`);
    if (x.member_only) tags.push(`<span class="tag soft">members</span>`);
    if (x.starts_label) tags.push(`<span class="tag soft">${esc(x.starts_label)}</span>`);
    if (x.ends_label) tags.push(`<span class="tag soft">ends ${esc(x.ends_label)}</span>`);
    if (x.in_stock === 0) tags.push(`<span class="tag soft">out of stock online</span>`);
    const was = x.was_cents ? ` · was ${money(x.was_cents)}` : x.rrp_cents ? ` · RRP ${money(x.rrp_cents)}` : "";
    const per = x.price_per === "kg" ? " /kg" : "";
    const shown = (x.display_name || x.name).toLowerCase().replace(/\\s+/g,"");
    const size = x.size_text && !shown.includes(x.size_text.toLowerCase().replace(/\\s+/g,"")) ? ` · ${esc(x.size_text)}` : "";
    return `<div class="item">
      ${x.image_url ? `<img loading="lazy" src="${esc(x.image_url)}" alt="">` : ""}
      <div class="body">
        <div class="top"><span class="store">${esc(x.store_label)}</span><span class="price">${money(x.price_cents)}${per}</span></div>
        <div class="name"><a href="${esc(x.url || "#")}" target="_blank" rel="noopener">${esc(x.display_name || x.name)}</a></div>
        <div class="meta">${esc(x.unit_price_text || "")}${was}${size} · ${esc(x.basis_label)}</div>
        <div>${tags.join("")}</div>
      </div></div>`;
  }).join("");
}
async function loadStatus() {
  const s = await fetch("/api/status").then(r => r.json());
  $("#status").innerHTML = "<b>Last collected</b>" + s.runs.map(r =>
    `<div>${esc(CHAINS[r.chain] || r.chain)} ${esc(r.kind)}: ${esc(r.status)}, ${new Date(r.started_at).toLocaleString("en-AU")}, ${r.items_seen} items</div>`).join("");
}
$("#f").addEventListener("submit", e => { e.preventDefault(); run(); });
["#all", "#sort"].forEach(s => $(s).addEventListener("change", run));
document.addEventListener("change", e => { if (e.target.classList.contains("chain")) run(); });
loadStatus();
</script>
</body>
</html>
"""
