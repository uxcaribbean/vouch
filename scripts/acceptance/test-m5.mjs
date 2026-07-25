/** M5 acceptance — vouches: positive-only, gated, rate-limited.
 * Written by the reviewer independently of the implementation; the
 * implementation must satisfy THIS file, not vice versa.
 *
 * Runs after test-m3.mjs fixtures: Keisha (+…0001, trader: Plumber +
 * "Drone Roof Inspection", island-wide) and James Testman (+…0004,
 * trader: Plumber + "bassoon tuning", Arima).
 *
 * Error-code contract for upsert-vouch / remove-vouch:
 *   unauthorized, invalid_input, trader_not_found, trade_not_offered,
 *   self_vouch, gate_not_met, rate_limited, vouch_locked
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
async function rest(path, { anon = false, token = null, method = "GET", body = null } = {}) {
  const key = anon ? ANON : SERVICE;
  const res = await fetch(`${API}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${token ?? key}`,
      "Content-Type": "application/json",
      Prefer: method === "POST" ? "return=representation" : "return=minimal",
    },
    body: body ? JSON.stringify(body) : null,
  });
  return {
    status: res.status,
    data: res.status === 204 ? null : await res.json().catch(() => null),
  };
}
async function rpcSearch(body) {
  const res = await fetch(`${API}/rest/v1/rpc/search_traders`, {
    method: "POST",
    headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

// ---------------------------------------------------------------- setup ----
const t3 = await login("+18685550003");
await fn("complete-profile", t3, { display_name: "Tariq Ali", home_region_id: 11 });
const t5 = await login("+18685550005");
await fn("complete-profile", t5, { display_name: "Nikki Persad", home_region_id: 12 });
const t4 = await login("+18685550004");

const { data: dir } = await rest(
  "trader_directory?select=trader_id,user_id,display_name",
  { anon: true },
);
const jamesT = dir.find((d) => d.display_name === "James Testman");
const keishaT = dir.find((d) => d.display_name === "Keisha Mohammed");
const { data: users } = await rest("users?select=id,display_name,phone_e164");
const tariq = users.find((u) => u.display_name === "Tariq Ali");
const nikki = users.find((u) => u.display_name === "Nikki Persad");
const { data: bassoonRows } = await rest("trades?slug=eq.bassoon-tuning&select=id");
const BASSOON = bassoonRows[0].id;
const PLUMBER = 100;
const ELECTRICIAN = 101;

// ------------------------------------------------------------- the gate ----
const blocked = await fn("upsert-vouch", t3, {
  trader_id: jamesT.trader_id,
  trade_id: PLUMBER,
  comment: "Fixed my kitchen sink same day.",
});
check(
  "stranger cannot vouch (gate_not_met)",
  blocked.status === 403 && blocked.data?.error === "gate_not_met",
  JSON.stringify(blocked.data),
);

// gate (a): trader's number in the voucher's contact hashes
await rest("contact_hashes", {
  method: "POST",
  body: { owner_user_id: tariq.id, phone_hash: sha256("+18685550004") },
});
const created = await fn("upsert-vouch", t3, {
  trader_id: jamesT.trader_id,
  trade_id: PLUMBER,
  comment: "Fixed my kitchen sink same day.",
});
check("contact-hash match opens the gate (201)", created.status === 201, JSON.stringify(created.data));
check("vouch is published, source app", created.data?.vouch?.status === "published" && created.data?.vouch?.source === "app");

// upsert = edit, never duplicate
const edited = await fn("upsert-vouch", t3, {
  trader_id: jamesT.trader_id,
  trade_id: PLUMBER,
  comment: "Fixed my kitchen sink same day. Fair price too.",
});
check("same (voucher,trader,trade) edits in place (200)", edited.status === 200);
const { data: tariqVouches } = await rest(
  `vouches?voucher_user_id=eq.${tariq.id}&trader_id=eq.${jamesT.trader_id}&trade_id=eq.${PLUMBER}&select=id,comment`,
);
check(
  "exactly one row, comment updated",
  tariqVouches.length === 1 && /Fair price/.test(tariqVouches[0].comment),
);

// validation
const longComment = await fn("upsert-vouch", t3, {
  trader_id: jamesT.trader_id,
  trade_id: PLUMBER,
  comment: "x".repeat(401),
});
check("401-char comment rejected", longComment.status === 400 && longComment.data?.error === "invalid_input");
const wrongTrade = await fn("upsert-vouch", t3, {
  trader_id: jamesT.trader_id,
  trade_id: ELECTRICIAN,
});
check("trade the trader doesn't offer rejected", wrongTrade.status === 400 && wrongTrade.data?.error === "trade_not_offered");
const selfVouch = await fn("upsert-vouch", t4, {
  trader_id: jamesT.trader_id,
  trade_id: PLUMBER,
});
check("self-vouch blocked", selfVouch.status === 403 && selfVouch.data?.error === "self_vouch");
const ghost = await fn("upsert-vouch", t3, {
  trader_id: "00000000-0000-0000-0000-000000000000",
  trade_id: PLUMBER,
});
check("unknown trader rejected", ghost.status === 404 && ghost.data?.error === "trader_not_found");

// gate (c): prior in-app contact ≥7 days ago — fresh taps do NOT count
await rest("events", {
  method: "POST",
  body: {
    user_id: nikki.id,
    name: "contact_tapped",
    props: { trader_id: keishaT.trader_id, channel: "call" },
  },
});
const freshTap = await fn("upsert-vouch", t5, {
  trader_id: keishaT.trader_id,
  trade_id: PLUMBER,
});
check("fresh contact tap does not open gate", freshTap.status === 403 && freshTap.data?.error === "gate_not_met");

const eightDaysAgo = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
await rest("events", {
  method: "POST",
  body: {
    user_id: nikki.id,
    name: "contact_tapped",
    props: { trader_id: keishaT.trader_id, channel: "whatsapp" },
    created_at: eightDaysAgo,
  },
});
const oldTap = await fn("upsert-vouch", t5, {
  trader_id: keishaT.trader_id,
  trade_id: PLUMBER,
  comment: "Real neat work by she and the crew.",
});
check("week-old contact tap opens the gate", oldTap.status === 201, JSON.stringify(oldTap.data));

// ------------------------------------------------- rate limit (<24h × 5) ----
// nikki is a brand-new account holding 1 vouch; pad to 5 via service role
for (const tradeId of [ELECTRICIAN, 102, 103, 104]) {
  await rest("vouches", {
    method: "POST",
    body: {
      voucher_user_id: nikki.id,
      trader_id: keishaT.trader_id,
      trade_id: tradeId,
      source: "app",
    },
  });
}
// seed a contact hash so only the rate limit can be the blocker
await rest("contact_hashes", {
  method: "POST",
  body: { owner_user_id: nikki.id, phone_hash: sha256("+18685550004") },
});
const capped = await fn("upsert-vouch", t5, {
  trader_id: jamesT.trader_id,
  trade_id: BASSOON,
});
check("new account capped at 5 vouches (429)", capped.status === 429 && capped.data?.error === "rate_limited", JSON.stringify(capped.data));

// accounts older than 24h are exempt
await rest(`users?id=eq.${tariq.id}`, {
  method: "PATCH",
  body: { created_at: new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString() },
});
for (const tradeId of [ELECTRICIAN, 102, 103, 104]) {
  await rest("vouches", {
    method: "POST",
    body: {
      voucher_user_id: tariq.id,
      trader_id: keishaT.trader_id,
      trade_id: tradeId,
      source: "app",
    },
  });
}
await rest("contact_hashes", {
  method: "POST",
  body: { owner_user_id: tariq.id, phone_hash: sha256("+18685550001") },
});
const matureOk = await fn("upsert-vouch", t3, {
  trader_id: keishaT.trader_id,
  trade_id: PLUMBER,
  comment: "Sorted out meh whole bathroom.",
});
check(">24h account not capped", matureOk.status === 201, JSON.stringify(matureOk.data));

// ------------------------------------------------------ removal + counts ----
const beforeRemoval = await rpcSearch({ p_trade_id: PLUMBER });
const jamesBefore = beforeRemoval.find((r) => r.trader_id === jamesT.trader_id);
check("search card carries real vouch_count", jamesBefore?.vouch_count >= 1, JSON.stringify(jamesBefore));

const removed = await fn("remove-vouch", t3, {
  trader_id: jamesT.trader_id,
  trade_id: PLUMBER,
});
check("own vouch removal works", removed.status === 200, JSON.stringify(removed.data));
const afterRemoval = await rpcSearch({ p_trade_id: PLUMBER });
const jamesAfter = afterRemoval.find((r) => r.trader_id === jamesT.trader_id);
check("removal decrements the public count", jamesAfter?.vouch_count === jamesBefore.vouch_count - 1);

const reVouch = await fn("upsert-vouch", t3, {
  trader_id: jamesT.trader_id,
  trade_id: PLUMBER,
  comment: "Still the best plumber in the East.",
});
check("re-vouch after own removal republishes", reVouch.status === 200 || reVouch.status === 201);

// admin removal locks the row
const { data: lockRows } = await rest(
  `vouches?voucher_user_id=eq.${tariq.id}&trader_id=eq.${jamesT.trader_id}&trade_id=eq.${PLUMBER}&select=id`,
);
await rest(`vouches?id=eq.${lockRows[0].id}`, {
  method: "PATCH",
  body: { status: "removed_by_admin" },
});
const lockedEdit = await fn("upsert-vouch", t3, {
  trader_id: jamesT.trader_id,
  trade_id: PLUMBER,
  comment: "try again",
});
check("admin-removed vouch cannot be resurrected", lockedEdit.status === 403 && lockedEdit.data?.error === "vouch_locked");

// ------------------------------------------------------------ visibility ----
const anonVouches = await rest(
  `vouches?trader_id=eq.${keishaT.trader_id}&select=status,comment,voucher_user_id`,
  { anon: true },
);
check(
  "anon sees only published vouches",
  anonVouches.data?.length >= 1 && anonVouches.data.every((v) => v.status === "published"),
  JSON.stringify(anonVouches.data),
);
const nikkiName = await rest(
  `public_profiles?id=eq.${nikki.id}&select=display_name`,
  { anon: true },
);
check("voucher names resolve for the public list", nikkiName.data?.[0]?.display_name === "Nikki Persad");

const directWrite = await rest("vouches", {
  anon: true,
  token: t3,
  method: "POST",
  body: {
    voucher_user_id: tariq.id,
    trader_id: keishaT.trader_id,
    trade_id: 105,
    source: "app",
  },
});
check("clients cannot write vouches directly", directWrite.status >= 400);

// count integrity vs raw data
const { data: publishedJ } = await rest(
  `vouches?trader_id=eq.${jamesT.trader_id}&status=eq.published&select=id`,
);
const finalSearch = await rpcSearch({ p_trade_id: PLUMBER });
const jamesFinal = finalSearch.find((r) => r.trader_id === jamesT.trader_id);
check(
  "RPC count equals raw published count",
  jamesFinal?.vouch_count === publishedJ.length,
  `rpc=${jamesFinal?.vouch_count} raw=${publishedJ.length}`,
);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures ? 1 : 0);
