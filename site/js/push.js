// Phone notifications (Web Push): the only file that talks to the phone's push service.
// A native (Capacitor) build would swap this file for the PushNotifications plugin.
//
// Each phone opts in for itself (the switch in Settings). Turning it on gives this phone a subscription from
// Apple's or Google's push service; its code is then added on the Mac (`uv run specials notify add`), and
// GitHub sends the notifications. Turning it off cancels the subscription, so nothing more can arrive.

const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent)
  || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isStandalone = () => window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

/** Can this phone get notifications right now? { ok } or { ok: false, reason }. */
export function support() {
  if (isIOS() && !isStandalone()) return { ok: false, reason: "ios-home-screen" };
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    return { ok: false, reason: "unsupported" };
  }
  if (Notification.permission === "denied") return { ok: false, reason: "blocked" };
  return { ok: true };
}

/** This phone's current subscription, or null when notifications are off. */
export async function currentSubscription() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg || Notification.permission !== "granted") return null;
  return reg.pushManager.getSubscription();
}

/**
 * Ask permission and subscribe. Call straight from the tap (iPhone only asks during a tap).
 * Throws Error("blocked") or Error("not-allowed") when the person says no.
 */
export async function enable(publicKey) {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error(permission === "denied" ? "blocked" : "not-allowed");
  const reg = await navigator.serviceWorker.ready;
  return (await reg.pushManager.getSubscription())
    || reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromBase64Url(publicKey) });
}

export async function disable() {
  const sub = await currentSubscription();
  if (sub) await sub.unsubscribe();
}

/** The code to add on the Mac: this phone's push address and keys, plus a name to recognise it by. */
export function codeFor(sub, name) {
  const { endpoint, keys } = sub.toJSON();
  const bytes = new TextEncoder().encode(JSON.stringify({ e: endpoint, k: keys, n: name }));
  let bin = "";
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function defaultPhoneName() {
  return isIOS() ? "iPhone" : /Android/.test(navigator.userAgent) ? "Android phone" : "Phone";
}

function fromBase64Url(text) {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}
