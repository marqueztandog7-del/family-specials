// Keeps this phone's copy of the family's list, savings and watchlist in step with everyone else's, through the
// family backend (Supabase). Part of the data layer, with data.js and account.js:
//   - start: load the family's rows, move this phone's own list and savings in (once), then listen for live changes.
//   - every change made on this phone is sent straight away; offline, it waits and is sent when the phone is back.
// Live changes arrive through Supabase Realtime, which only delivers a family's rows to its members.

import * as data from "./data.js";
import { getClient } from "./account.js";

const TABLES = {
  list: { name: "family_list_items", key: "item_key", fields: ["family_id", "item_key", "data", "qty", "qty_changed",
    "ticked", "ticked_at", "ticked_changed", "deleted", "deleted_changed"] },
  savings: { name: "family_savings", key: "entry_id", fields: ["family_id", "entry_id", "data", "saving_cents",
    "saved_at", "deleted", "deleted_changed"] },
  watch: { name: "family_watch_items", key: "watch_key", fields: ["family_id", "watch_key", "data", "watching",
    "watching_changed"] },
};

let current = null;    // { familyId, sb, channel, flushing, timer, backoff, onFamily }

function only(row, fields) {
  const out = {};
  for (const f of fields) if (row[f] !== undefined) out[f] = row[f];
  return out;
}

/** Start keeping this phone in step with the family. `onFamily` runs when members or the family name change. */
export async function start(familyId, onFamily) {
  if (current?.familyId === familyId) return;
  await stop();
  const sb = await getClient();
  current = { familyId, sb, channel: null, flushing: false, timer: null, backoff: 0, onFamily };
  data.setQueueHook(() => schedule(0));
  window.addEventListener("online", onOnline);
  document.addEventListener("visibilitychange", onVisible);
  await pullAll();
  data.adoptPersonal();
  subscribe();
  schedule(0);
}

export async function stop() {
  if (!current) return;
  const c = current;
  current = null;
  clearTimeout(c.timer);
  data.setQueueHook(null);
  window.removeEventListener("online", onOnline);
  document.removeEventListener("visibilitychange", onVisible);
  if (c.channel) await c.sb.removeChannel(c.channel).catch(() => {});
}

export function online() {
  return navigator.onLine !== false;
}

async function pullAll() {
  const c = current;
  if (!c) return;
  for (const [what, t] of Object.entries(TABLES)) {
    const { data: rows, error } = await c.sb.from(t.name).select("*").eq("family_id", c.familyId);
    if (error || current !== c) return;
    data.applyServerRows(what, rows);
  }
}

function subscribe() {
  const c = current;
  const ch = c.sb.channel(`family-${c.familyId}`);
  for (const [what, t] of Object.entries(TABLES)) {
    ch.on("postgres_changes", { event: "*", schema: "public", table: t.name, filter: `family_id=eq.${c.familyId}` },
      (msg) => { if (msg.new && msg.new.family_id === c.familyId) data.applyServerRows(what, [msg.new]); });
  }
  ch.on("postgres_changes", { event: "*", schema: "public", table: "family_members", filter: `family_id=eq.${c.familyId}` },
    () => c.onFamily?.());
  ch.on("postgres_changes", { event: "UPDATE", schema: "public", table: "families", filter: `id=eq.${c.familyId}` },
    () => c.onFamily?.());
  let joinedBefore = false;
  ch.subscribe((status) => {
    // After a dropped connection, catch up on anything missed while away.
    if (status === "SUBSCRIBED") {
      if (joinedBefore) pullAll().then(() => schedule(0));
      joinedBefore = true;
    }
  });
  c.channel = ch;
}

function schedule(delay) {
  if (!current) return;
  clearTimeout(current.timer);
  current.timer = setTimeout(flush, delay);
}

function onOnline() {
  if (current) { current.backoff = 0; schedule(0); }
}

function onVisible() {
  if (document.visibilityState === "visible" && current) pullAll().then(() => schedule(0));
}

/** Send everything waiting. On failure (offline), try again later, waiting a little longer each time. */
async function flush() {
  const c = current;
  if (!c || c.flushing) return;
  if (!data.hasUnsent()) return;
  c.flushing = true;
  try {
    const out = data.pending();
    for (const [what, t] of Object.entries(TABLES)) {
      const sent = out[what];
      const keys = Object.keys(sent);
      if (!keys.length) continue;
      const rows = keys.map((k) => data.rowFor(what, k)).filter(Boolean).map((r) => only(r, t.fields));
      const { data: saved, error } = await c.sb.from(t.name).upsert(rows, { onConflict: `family_id,${t.key}` }).select();
      if (error) throw error;
      if (current !== c) return;
      data.markSent(what, sent);
      data.applyServerRows(what, saved);
    }
    c.backoff = 0;
  } catch {
    c.backoff = Math.min(60000, c.backoff ? c.backoff * 2 : 3000);
  } finally {
    c.flushing = false;
  }
  if (current === c && data.hasUnsent()) schedule(c.backoff || 500);
}
