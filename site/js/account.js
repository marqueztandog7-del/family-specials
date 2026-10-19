// Accounts and families: the only file that talks to the family backend (Supabase). Part of the data layer, with
// data.js. The backend's address and public key come from app-config.json, written at publish time from GitHub
// secrets (never in the repo). Without it the app runs as before, with everything kept on this phone.
// A native (Capacitor) build can keep this file as it is.

const STORAGE_KEY = "fs.auth.v1";
// The first version kept an invite code on the phone. Codes are never stored now: clear any old one.
try { localStorage.removeItem("fs.invite.v1"); } catch { /* nothing saved */ }
let configPromise = null;
let clientPromise = null;

function getConfig() {
  configPromise ||= fetch(new URL("./app-config.json", document.baseURI), { cache: "no-cache" })
    .then((r) => (r.ok ? r.json() : null))
    .then((c) => (c && c.supabaseUrl && c.supabaseKey ? c : null))
    .catch(() => null);
  return configPromise;
}

/** Are accounts switched on for this app? */
export async function available() {
  return !!(await getConfig());
}

function loadSdk() {
  if (window.supabase) return Promise.resolve(window.supabase);
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = new URL("./js/vendor/supabase.js", document.baseURI).href;
    s.onload = () => resolve(window.supabase);
    s.onerror = () => reject(new Error("Couldn't load sign-in. Check your connection."));
    document.head.append(s);
  });
}

/** The backend client, for sync.js (part of the data layer). */
export function getClient() {
  return client();
}

function client() {
  clientPromise ||= (async () => {
    const c = await getConfig();
    if (!c) throw new Error("Accounts aren't set up yet.");
    const sdk = await loadSdk();
    // detectSessionInUrl is off: the app uses #/routes, which aren't sign-in callbacks.
    return sdk.createClient(c.supabaseUrl, c.supabaseKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: STORAGE_KEY },
    });
  })();
  clientPromise.catch(() => { clientPromise = null; });
  return clientPromise;
}

// Plain-English messages for what the backend can say.
const FRIENDLY = [
  [/invalid login credentials/i, "That email and password don't match."],
  [/already registered|already been registered|user_already_exists/i, "There's already an account with that email. Sign in instead."],
  [/password should be at least|weak_password|password is too weak/i, "Use a password of at least 8 characters."],
  [/unable to validate email|invalid format|email address .* is invalid|email_address_invalid/i, "That doesn't look like an email address."],
  [/over_email_send_rate_limit|email rate limit|only request this after|for security purposes/i, "Please wait a minute before asking for another email."],
  [/rate limit|too many requests|over_request_rate_limit/i, "Too many tries. Wait a minute and try again."],
  [/same_password|should be different from the old/i, "That's your current password. Choose a new one."],
  [/already-in-family/, "You're already in a family."],
  [/not-owner/, "Only the family's owner can do that."],
  [/choose-new-owner/, "Choose who'll own the family before you leave."],
  [/cannot-remove-yourself/, "You can't remove yourself. Leave the family instead."],
  [/not-in-family/, "You're not in a family."],
  [/family-name-length/, "Give the family a name (up to 60 characters)."],
  [/nickname-length/, "Add a nickname (up to 30 characters)."],
  [/name-length/, "Names can be up to 60 characters."],
  [/not-signed-in|JWT expired|invalid jwt/i, "Please sign in again."],
  [/failed to fetch|networkerror|load failed|network request failed/i, "No connection. Check your signal and try again."],
];

function friendly(error) {
  const msg = error?.message || String(error);
  const hit = FRIENDLY.find(([re]) => re.test(msg));
  return new Error(hit ? hit[1] : msg);
}

// ------------------------------------------------------------------ signing in

/** The signed-in person ({ id, email }) or null. Works offline from the saved session. */
export async function currentUser() {
  if (!(await available())) return null;
  try {
    const sb = await client();
    const { data } = await sb.auth.getSession();
    const u = data.session?.user;
    return u ? { id: u.id, email: u.email } : null;
  } catch {
    return null;
  }
}

export async function signUp(email, password) {
  const sb = await client();
  const { data, error } = await sb.auth.signUp({ email: email.trim(), password });
  if (error) throw friendly(error);
  if (!data.session) throw new Error("Your account was made. Sign in to continue.");
  return { id: data.user.id, email: data.user.email };
}

export async function signIn(email, password) {
  const sb = await client();
  const { data, error } = await sb.auth.signInWithPassword({ email: email.trim(), password });
  if (error) throw friendly(error);
  return { id: data.user.id, email: data.user.email };
}

export async function signOut() {
  const sb = await client();
  await sb.auth.signOut({ scope: "local" });
  remember(null);
  rememberProfile(null);
}

// ------------------------------------------------------------------ forgotten passwords

/** The app's own address (no #route): where the reset email's link comes back to. */
export function appAddress() {
  return `${location.origin}${location.pathname}`;
}

/** Ask for a reset email. Says nothing about whether the email has an account (Supabase doesn't either). */
export async function requestPasswordReset(email) {
  const sb = await client();
  const { error } = await sb.auth.resetPasswordForEmail(email.trim(), { redirectTo: appAddress() });
  if (error) throw friendly(error);
}

/**
 * What a reset link brought with it, read from the address: { kind: 'token', tokenHash } (our email's link),
 * { kind: 'session', access, refresh } (Supabase's standard email), { kind: 'expired' }, or null.
 */
export function resetLinkFrom(hash, params) {
  if (params?.get("token_hash") && params.get("type") === "recovery") return { kind: "token", tokenHash: params.get("token_hash") };
  const h = new URLSearchParams((hash || "").replace(/^#/, ""));
  if (h.get("error_code") || (h.get("error") && h.get("error_description"))) return { kind: "expired" };
  if (h.get("type") === "recovery" && h.get("access_token") && h.get("refresh_token")) {
    return { kind: "session", access: h.get("access_token"), refresh: h.get("refresh_token") };
  }
  return null;
}

/** Use a reset link: signs in on this phone for setting the new password. Throws 'expired' if it can't be used. */
export async function useResetLink(link) {
  const sb = await client();
  const { data, error } = link.kind === "token"
    ? await sb.auth.verifyOtp({ token_hash: link.tokenHash, type: "recovery" })
    : await sb.auth.setSession({ access_token: link.access, refresh_token: link.refresh });
  if (error || !data?.session) throw new Error("expired");
  return { id: data.session.user.id, email: data.session.user.email };
}

/** Set the signed-in person's new password (after a reset link). */
export async function updatePassword(password) {
  const sb = await client();
  const { error } = await sb.auth.updateUser({ password });
  if (error) throw friendly(error);
}

// ------------------------------------------------------------------ every store's range, and the family's watchlist

/** Search every store's full range (signed in). Rows as stored: chain, product_id, name, price_cents, ... */
export async function searchProducts(query, chains, limit = 40) {
  return rpc("search_products", { p_query: query, p_chains: chains?.length ? chains : null, p_limit: limit });
}

/** Today's prices for a few products ('woolworths:123'). */
export async function productsById(ids) {
  if (!ids.length) return [];
  return rpc("products_by_id", { p_ids: ids });
}

/** The family's watchlist ({ generated_at, data } or { generated_at, unchanged } if `since` is the latest), or
 *  null when not in a family. Private to the family's members. */
export async function myWatchlist(since = null) {
  return rpc("my_watchlist", { p_since: since });
}

/** Call `fn(user or null)` whenever someone signs in or out on this phone. */
export async function onChange(fn) {
  if (!(await available())) return;
  const sb = await client();
  sb.auth.onAuthStateChange((_event, session) => {
    const u = session?.user;
    fn(u ? { id: u.id, email: u.email } : null);
  });
}

async function rpc(name, args) {
  const sb = await client();
  const { data, error } = await sb.rpc(name, args);
  if (error) throw friendly(error);
  return data;
}

/** Delete this account for good. The family is handed to another member, or removed if there's nobody else. */
export async function deleteAccount() {
  await rpc("delete_my_account");
  const sb = await client();
  await sb.auth.signOut({ scope: "local" });
  remember(null);
  rememberProfile(null);
}

// ------------------------------------------------------------------ families

const FAMILY_CACHE = "fs.family.v1";

function remember(family) {
  try {
    if (family) localStorage.setItem(FAMILY_CACHE, JSON.stringify(family));
    else localStorage.removeItem(FAMILY_CACHE);
  } catch { /* not saved: shown again once online */ }
  return family;
}

/** { id, name, is_owner, me: { nickname, role }, members: [...], invite: { code, expires_at } (owner only) } or null. */
export async function myFamily() {
  return remember(await rpc("my_family"));
}

/** The family as last seen on this phone (for showing it offline). */
export function cachedFamily() {
  try { return JSON.parse(localStorage.getItem(FAMILY_CACHE) || "null"); } catch { return null; }
}

export function forgetFamily() {
  remember(null);
}

/** Start a family. Returns { family, invite: { token, code, expires_at } }: the code is shown this once only. */
export async function createFamily(name, nickname) {
  const res = await rpc("create_family", { p_name: name.trim(), p_nickname: nickname.trim() });
  const { new_invite: invite, ...family } = res;
  remember(family);
  return { family, invite };
}

/** Owner: a new link and code. The old ones stop working straight away. Returns { token, code, expires_at }. */
export async function newInvite() {
  const invite = await rpc("new_invite");
  await myFamily().catch(() => {});
  return invite;
}

/** What an invite link may show, even signed out: { status: 'ok'|'expired', family_name, inviter } or null. */
export async function invitePreview(token) {
  const sb = await client();
  const { data, error } = await sb.rpc("get_invite_preview", { p_token: token });
  if (error) throw friendly(error);
  return data;
}

/**
 * Join with the link's token, the code sent separately and a nickname. Returns { status, family_name, inviter,
 * family }: status is ok, wrong-code, expired, already-in-family, too-many, not-found or nickname.
 */
export async function joinFamily(token, code, nickname) {
  const res = await rpc("join_family", { p_token: token, p_code: code, p_nickname: nickname.trim() });
  if (res?.status === "ok") remember(res.family);
  return res;
}

export async function renameFamily(name) {
  return remember(await rpc("rename_family", { p_name: name.trim() }));
}

export async function removeMember(userId) {
  return remember(await rpc("remove_member", { p_user_id: userId }));
}

/** Leave the family. An owner with others in it names the new owner (their account id). */
export async function leaveFamily(newOwnerId = null) {
  await rpc("leave_family", newOwnerId ? { p_new_owner: newOwnerId } : {});
  remember(null);
}

// ------------------------------------------------------------------ profile (seen only by the person themselves)

const PROFILE_CACHE = "fs.profile.v1";

function rememberProfile(profile) {
  try {
    if (profile) localStorage.setItem(PROFILE_CACHE, JSON.stringify(profile));
    else localStorage.removeItem(PROFILE_CACHE);
  } catch { /* not saved: fetched again next time */ }
  return profile;
}

/** { name } (name may be null). */
export async function myProfile() {
  return rememberProfile(await rpc("my_profile"));
}

export function cachedProfile() {
  try { return JSON.parse(localStorage.getItem(PROFILE_CACHE) || "null"); } catch { return null; }
}

/** Save the name (empty clears it) and, when given, the nickname in the family. */
export async function updateProfile(name, nickname) {
  const args = { p_name: name.trim() };
  if (nickname != null) args.p_nickname = nickname.trim();
  const profile = rememberProfile(await rpc("update_my_profile", args));
  if (nickname != null && cachedFamily()) await myFamily().catch(() => {});
  return profile;
}

/** The invite link: our app's invite page with the invite's token only. It never contains the code. */
export function inviteLink(token) {
  return `${location.origin}${location.pathname}#/invite/${encodeURIComponent(token)}`;
}

/** The token from a pasted invite link (or a bare token). */
export function tokenFrom(text) {
  const t = (text || "").trim();
  const m = t.match(/#\/invite\/([A-Za-z0-9_-]{16,})/);
  if (m) return m[1];
  return /^[A-Za-z0-9_-]{16,}$/.test(t) ? t : "";
}

/** Join codes are 6 characters from 2-9 and A-Z without O, I and L. Tidies what someone typed (any case, spaces). */
export function cleanCode(text) {
  return (text || "").toUpperCase().replace(/[^0-9A-Z]/g, "");
}

export function looksLikeCode(text) {
  return /^[2-9A-HJKMNP-Z]{6}$/.test(cleanCode(text));
}
