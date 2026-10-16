// Accounts and families: the only file that talks to the family backend (Supabase). Part of the data layer, with
// data.js. The backend's address and public key come from app-config.json, written at publish time from GitHub
// secrets (never in the repo). Without it the app runs as before, with everything kept on this phone.
// A native (Capacitor) build can keep this file as it is.

const STORAGE_KEY = "fs.auth.v1";
const PENDING_CODE = "fs.invite.v1";
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
  [/rate limit|too many requests|over_request_rate_limit/i, "Too many tries. Wait a minute and try again."],
  [/already-in-family/, "You're already in a family."],
  [/family-name-length/, "Give the family a name (up to 60 characters)."],
  [/nickname-length/, "Add a nickname (up to 30 characters)."],
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

export async function createFamily(name, nickname) {
  return remember(await rpc("create_family", { p_name: name.trim(), p_nickname: nickname.trim() }));
}

/** The invite link: our app's sign-in page with the code after the # (so it's never sent to a server). */
export function inviteLink(code) {
  return `${location.origin}${location.pathname}#/join?code=${encodeURIComponent(code)}`;
}

/** A code that arrived in an invite link, kept on this phone until the person has joined. */
export function setPendingCode(code) {
  try { localStorage.setItem(PENDING_CODE, code); } catch { /* private mode: the code is still in the link */ }
}

export function pendingCode() {
  try { return localStorage.getItem(PENDING_CODE) || ""; } catch { return ""; }
}

export function clearPendingCode() {
  try { localStorage.removeItem(PENDING_CODE); } catch { /* nothing saved */ }
}

/** Join codes are 6 characters from 2-9 and A-Z without O, I and L. Tidies what someone typed. */
export function cleanCode(text) {
  return (text || "").toUpperCase().replace(/[^0-9A-Z]/g, "").slice(0, 6);
}

export function looksLikeCode(text) {
  return /^[2-9A-HJKMNP-Z]{6}$/.test(text);
}
