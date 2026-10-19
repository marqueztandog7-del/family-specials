// Offline support: keeps the app shell, and the last downloaded prices, so the app opens without a signal.
// Prices are always fetched fresh first (network first); the saved copy is only a fallback.
// Also shows phone notifications sent from GitHub (Web Push).
const VERSION = "v7";
const FONTS = "fonts-v1";   // Google Fonts (text, prices, icons): kept after the first visit
const SHELL = ["./", "index.html", "styles.css", "js/app.js", "js/data.js", "js/push.js", "js/account.js", "js/sync.js", "js/vendor/supabase.js", "manifest.webmanifest",
  "push.json", "data/specials.json", "data/status.json",
  "icons/icon-192.png", "icons/apple-touch-icon.png", "icons/favicon.svg"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== FONTS).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    e.respondWith(caches.open(FONTS).then((c) => c.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
      if (res.ok || res.type === "opaque") c.put(e.request, res.clone());
      return res;
    }))));
    return;
  }
  if (url.origin !== location.origin) return;
  // "no-cache" asks the server whether the file changed (a cheap "not modified" when it hasn't), so a new version
  // of the app or new prices show up straight away instead of after the browser's cache expires.
  e.respondWith(
    fetch(e.request, { cache: "no-cache" })
      .then((res) => {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match("index.html")))
  );
});

// A notification from GitHub: { title, body, url, tag }. Every push must show one (iPhone requires it).
self.addEventListener("push", (e) => {
  let msg = {};
  try {
    msg = e.data ? e.data.json() : {};
  } catch {
    msg = { body: e.data ? e.data.text() : "" };
  }
  e.waitUntil(self.registration.showNotification(msg.title || "Family Specials", {
    body: msg.body || "", tag: msg.tag || undefined, icon: "icons/icon-192.png",
    data: { url: msg.url || "#/home" },
  }));
});

// Tapping a notification opens the app on the right screen.
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const target = new URL(e.notification.data?.url || "#/home", self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((open) => {
    const app = open.find((c) => c.url.startsWith(self.registration.scope));
    if (app) {
      app.postMessage({ type: "open", url: target });
      return app.focus();
    }
    return self.clients.openWindow(target);
  }));
});
