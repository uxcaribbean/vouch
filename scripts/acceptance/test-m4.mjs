/** M4 acceptance — contact sync & graph matching (the USP).
 * Reviewer-authored; the implementation must satisfy THIS file.
 *
 * Runs after test-m5.mjs. Relies on: Nikki Persad (+…0005) holding
 * published vouches on Keisha Mohammed's trader; James Testman (+…0004)
 * being a trader; +…0002 available for a fresh member (deleted in M1's
 * suite, re-onboarded here as "Anika Ram").
 *
 * Contracts under test:
 *   sync-contacts fn: { hashes: sha256hex[] ≤500, replace: boolean } —
 *     raw numbers are UNREPRESENTABLE (schema rejects non-64-hex).
 *   search_traders(p_trade_id, p_region_id, p_friends_only, p_limit,
 *     p_offset) — viewer-aware friend_vouch_count via auth.uid().
 *   trader_summary(p_trader_id) → { vouch_count_total, vouch_count_by_trade,
 *     friend_vouch_count, friend_voucher_names }.
 *   contacts_on_vouch() → traders among the caller's contacts.
 */
import { createHash } from "node:crypto";

const API = "http://127.0.0.1:54321";
const ANON =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";
const SERVICE =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

let failures = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  " + extra}`);
  if (!cond) failures++;
};
const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");

async function auth(path, body) {
  const res = await fetch(`${API}/auth/v1/${path}`, {
    method: "POST",
    headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}
async function login(phone) {
  await auth("otp", { phone });
  const d = await auth("verify", { phone, token: "123456", type: "sms" });
  if (!d?.access_token) throw new Error(`login failed ${phone}`);
  return d.access_token;
}
async function fn(name, token, body = {}) {
  const res = await fetch(`${API}/functions/v1/${name}`, {
    method: "POST",
    headers: {
      apikey: ANON,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}
async function rpc(name, body, token = null) {
  const res = await fetch(`${API}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: ANON,
      Authorization: `Bearer ${token ?? ANON}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}
async function rest(path, { anon = false, token = null, method = "GET", body = null } = {}) {
  const key = anon ? ANON : SERVICE;
  const res = await fetch(`${API}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${token ?? key}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : null,
  });
  return {
    status: res.status,
    data: res.status === 204 ? null : await res.json().catch(() => null),
  };
}

// ---------------------------------------------------------------- setup ----
const tA = await login("+18685550002");
await fn("complete-profile", tA, { display_name: "Anika Ram", home_region_id: 13 });
const { data: dir } = await rest("trader_directory?select=trader_id,user_id,display_name", { anon: true });
const keishaT = dir.find((d) => d.display_name === "Keisha Mohammed");
const jamesT = dir.find((d) => d.display_name === "James Testman");
const { data: anikaRows } = await rest("users?display_name=eq.Anika Ram&select=id");
const anika = anikaRows[0];

const NIKKI_HASH = sha256("+18685550005"); // voucher of Keisha's trader
const JAMES_HASH = sha256("+18685550004"); // a trader's own number
const RANDOM_HASH = sha256("+15550000001"); // matches nobody

// ------------------------------------------------- the sync contract -------
const rawRejected = await fn("sync-contacts", tA, {
  hashes: ["+18685550005"], // a raw phone number must be unrepresentable
  replace: true,
});
check(
  "raw phone number is rejected by schema",
  rawRejected.status === 400 && rawRejected.data?.error === "invalid_input",
  JSON.stringify(rawRejected.data),
);

const tooMany = await fn("sync-contacts", tA, {
  hashes: Array.from({ length: 501 }, (_, i) => sha256(`x${i}`)),
  replace: true,
});
check("batches capped at 500", tooMany.status === 400 && tooMany.data?.error === "invalid_input");

const firstSync = await fn("sync-contacts", tA, {
  hashes: [NIKKI_HASH, RANDOM_HASH],
  replace: true,
});
check("valid sync accepted", firstSync.status === 200, JSON.stringify(firstSync.data));

const { data: afterFirst } = await rest(
  `contact_hashes?owner_user_id=eq.${anika.id}&select=phone_hash`,
);
check("two fingerprints stored", afterFirst.length === 2);

const { data: flagRow } = await rest(`users?id=eq.${anika.id}&select=contact_sync_enabled`);
check("contact_sync_enabled flipped on", flagRow[0].contact_sync_enabled === true);

// replace semantics: a fresh replace:true sync wipes previous rows
await fn("sync-contacts", tA, { hashes: [NIKKI_HASH], replace: true });
const { data: afterReplace } = await rest(
  `contact_hashes?owner_user_id=eq.${anika.id}&select=phone_hash`,
);
check(
  "replace:true replaces (1 row remains)",
  afterReplace.length === 1 && afterReplace[0].phone_hash === NIKKI_HASH,
);

// append semantics for follow-up batches of the same run
await fn("sync-contacts", tA, { hashes: [RANDOM_HASH], replace: false });
const { data: afterAppend } = await rest(
  `contact_hashes?owner_user_id=eq.${anika.id}&select=phone_hash`,
);
check("replace:false appends (2 rows)", afterAppend.length === 2);

// -------------------------------------------------- friend matching --------
// Nikki (in Anika's contacts) holds published vouches on Keisha's trader.
const searchAsAnika = await rpc("search_traders", { p_trade_id: 100 }, tA);
const keishaCard = searchAsAnika.data?.find((r) => r.trader_id === keishaT.trader_id);
const jamesCard = searchAsAnika.data?.find((r) => r.trader_id === jamesT.trader_id);
// Nikki holds SEVERAL published vouches on Keisha but is ONE person —
// "N people you know" counts distinct vouchers, so this must be exactly 1.
check(
  "friend_vouch_count counts people, not vouch rows (=1)",
  keishaCard?.friend_vouch_count === 1,
  JSON.stringify(keishaCard),
);
check("no friend inflation for others", jamesCard?.friend_vouch_count === 0);
check(
  "friend-vouched trader sorts first",
  searchAsAnika.data?.[0]?.trader_id === keishaT.trader_id,
);

const searchAnon = await rpc("search_traders", { p_trade_id: 100 });
check(
  "anon always sees friend_vouch_count 0",
  searchAnon.data?.every((r) => r.friend_vouch_count === 0),
);

// friends-only filter
const friendsOnly = await rpc("search_traders", { p_trade_id: 100, p_friends_only: true }, tA);
check(
  "friends-only filter returns only friend-vouched traders",
  friendsOnly.data?.length >= 1 &&
    friendsOnly.data.every((r) => r.friend_vouch_count >= 1),
  JSON.stringify(friendsOnly.data?.map((r) => r.display_name)),
);
const friendsOnlyAnon = await rpc("search_traders", { p_trade_id: 100, p_friends_only: true });
check(
  "friends-only for anon degrades to normal results (flag ignored)",
  friendsOnlyAnon.status === 200 && friendsOnlyAnon.data?.length >= 2,
);

// ------------------------------------------------------ trader_summary -----
const summary = await rpc("trader_summary", { p_trader_id: keishaT.trader_id }, tA);
check(
  "summary: friend count is distinct people (=1) and Nikki named",
  summary.data?.friend_vouch_count === 1 &&
    JSON.stringify(summary.data?.friend_voucher_names ?? []).includes("Nikki Persad"),
  JSON.stringify(summary.data),
);
const { data: rawCount } = await rest(
  `vouches?trader_id=eq.${keishaT.trader_id}&status=eq.published&select=id`,
);
check("summary: total equals raw published count", summary.data?.vouch_count_total === rawCount.length);
check(
  "summary: per-trade breakdown present",
  summary.data?.vouch_count_by_trade && Object.keys(summary.data.vouch_count_by_trade).length >= 1,
);
const summaryAnon = await rpc("trader_summary", { p_trader_id: keishaT.trader_id });
check(
  "summary for anon: totals yes, friends zero/empty",
  summaryAnon.data?.vouch_count_total === rawCount.length &&
    summaryAnon.data?.friend_vouch_count === 0 &&
    (summaryAnon.data?.friend_voucher_names ?? []).length === 0,
);

// ----------------------------------------------------- reverse prompt ------
// Add a trader's own number (James) to Anika's contacts.
await fn("sync-contacts", tA, { hashes: [NIKKI_HASH, JAMES_HASH], replace: true });
const reverse = await rpc("contacts_on_vouch", {}, tA);
check(
  "reverse prompt finds the trader in my contacts",
  Array.isArray(reverse.data) &&
    reverse.data.some((r) => r.trader_id === jamesT.trader_id),
  JSON.stringify(reverse.data),
);
check(
  "reverse prompt excludes traders not in contacts",
  !reverse.data.some((r) => r.trader_id === keishaT.trader_id),
);
const reverseAnon = await rpc("contacts_on_vouch", {});
check(
  "reverse prompt empty for anon",
  reverseAnon.status !== 200 || (reverseAnon.data ?? []).length === 0,
);

// ------------------------------------------------------------- privacy -----
const { data: crossRead } = await rest("contact_hashes?select=owner_user_id", {
  anon: true,
  token: tA,
});
check(
  "RLS: a user sees only their own fingerprints",
  crossRead.every((r) => r.owner_user_id === anika.id),
);

// -------------------------------------------------- disable = delete -------
const delRes = await rest(`contact_hashes?owner_user_id=eq.${anika.id}`, {
  anon: true,
  token: tA,
  method: "DELETE",
});
check("owner can delete all own hashes (RLS)", delRes.status < 300);
await rest(`users?id=eq.${anika.id}`, {
  anon: true,
  token: tA,
  method: "PATCH",
  body: { contact_sync_enabled: false },
});
const { data: afterDisable } = await rest(
  `contact_hashes?owner_user_id=eq.${anika.id}&select=phone_hash`,
);
check("hash row count is 0 after disable", afterDisable.length === 0);
const postDisable = await rpc("search_traders", { p_trade_id: 100 }, tA);
check(
  "friend UI data disappears after disable",
  postDisable.data?.every((r) => r.friend_vouch_count === 0),
);
const { data: flagOff } = await rest(`users?id=eq.${anika.id}&select=contact_sync_enabled`);
check("contact_sync_enabled flipped off", flagOff[0].contact_sync_enabled === false);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures ? 1 : 0);
