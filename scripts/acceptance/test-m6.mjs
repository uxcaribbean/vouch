/** M6 acceptance — invites, referrals & free-month credits.
 * Reviewer-authored; the implementation must satisfy THIS file.
 *
 * Runs after test-m4.mjs. Uses fresh test numbers 0006–0008 (config.toml
 * test_otp). Relies on fixtures: Keisha (trader, has one referral credit
 * from M1's Andre signup), James (trader), Tariq + Nikki (plain members).
 *
 * Error-code contract: create-invite → unauthorized, invalid_input,
 * not_a_trader, rate_limited. resolve-invite (public) → invalid token
 * handled gracefully. upsert-vouch gains gate (b): a valid, unexpired
 * vouch_request token for THAT trader opens the gate for any caller.
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
const addMonths = (dateStr, months) => {
  const d = new Date(dateStr);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
};

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
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
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
const t3 = await login("+18685550003"); // Tariq — plain member
const t4 = await login("+18685550004"); // James — trader
const { data: users } = await rest(
  "users?select=id,display_name,referral_code&order=created_at.asc",
);
const byName = (n) => users.find((u) => u.display_name === n);
const keisha = byName("Keisha Mohammed");
const tariq = byName("Tariq Ali");
const nikki = byName("Nikki Persad");
const { data: dir } = await rest("trader_directory?select=trader_id,user_id,display_name", { anon: true });
const keishaT = dir.find((d) => d.display_name === "Keisha Mohammed");
const jamesT = dir.find((d) => d.display_name === "James Testman");
const { data: keishaTraderBefore } = await rest(
  `trader_profiles?id=eq.${keishaT.trader_id}&select=free_until`,
);
const keishaFreeUntilBefore = keishaTraderBefore[0].free_until;
const { data: keishaRefsBefore } = await rest(
  `credit_ledger?user_id=eq.${keisha.id}&reason=eq.referral&select=id`,
);

// ------------------------------------------------------- invite creation ----
const vouchReq = await fn("create-invite", t4, { kind: "vouch_request" });
check("trader creates vouch_request invite (201)", vouchReq.status === 201, JSON.stringify(vouchReq.data));
const vToken = vouchReq.data?.token;
check("token is url-safe and ≥16 chars", /^[A-Za-z0-9\-_]{16,64}$/.test(vToken ?? ""));
check("invite carries the trader id", vouchReq.data?.trader_id === jamesT.trader_id);
const expiresMs = new Date(vouchReq.data?.expires_at ?? 0).getTime() - Date.now();
check(
  "expires ~30 days out",
  expiresMs > 28 * 24 * 3600 * 1000 && expiresMs < 32 * 24 * 3600 * 1000,
);

const nonTrader = await fn("create-invite", t3, { kind: "vouch_request" });
check("non-trader cannot create vouch_request", nonTrader.status === 400 && nonTrader.data?.error === "not_a_trader");

const joinInvite = await fn("create-invite", t3, { kind: "join_invite" });
check("anyone creates join_invite", joinInvite.status === 201 && !!joinInvite.data?.token);

const anonCreate = await fn("create-invite", null, { kind: "join_invite" });
check("anon cannot create invites", anonCreate.status === 401);

const { data: inviteLeak } = await rest("invites?select=token", { anon: true });
check(
  "tokens are not publicly listable",
  !Array.isArray(inviteLeak) || inviteLeak.length === 0,
  JSON.stringify(inviteLeak)?.slice(0, 120),
);
const { data: ownInvites } = await rest("invites?select=token,inviter_user_id", {
  anon: true,
  token: t3,
});
check(
  "inviter sees only their own invites",
  ownInvites.every((i) => i.inviter_user_id === tariq.id),
);

// ---------------------------------------- gate (b): invite token in M5 fn ----
// Ria (0006) is brand new: no contact hashes, no prior contact events.
const t6 = await login("+18685550006");
await fn("complete-profile", t6, {
  display_name: "Ria Boodoo",
  home_region_id: 14,
  referral_code: keisha.referral_code,
});

const noToken = await fn("upsert-vouch", t6, {
  trader_id: jamesT.trader_id,
  trade_id: 100,
});
check("no token → still gated", noToken.status === 403 && noToken.data?.error === "gate_not_met");

const withToken = await fn("upsert-vouch", t6, {
  trader_id: jamesT.trader_id,
  trade_id: 100,
  comment: "Quick and tidy work.",
  invite_token: vToken,
});
check("valid vouch_request token opens the gate", withToken.status === 201, JSON.stringify(withToken.data));

const wrongTrader = await fn("upsert-vouch", t6, {
  trader_id: keishaT.trader_id,
  trade_id: 100,
  invite_token: vToken,
});
check("token bound to its trader only", wrongTrader.status === 403 && wrongTrader.data?.error === "gate_not_met");

const joinAsGate = await fn("upsert-vouch", t6, {
  trader_id: keishaT.trader_id,
  trade_id: 100,
  invite_token: joinInvite.data.token,
});
check("join_invite token does not open the vouch gate", joinAsGate.status === 403);

const { data: bassoonRows } = await rest("trades?slug=eq.bassoon-tuning&select=id");
await rest(`invites?token=eq.${vToken}`, {
  method: "PATCH",
  body: { expires_at: new Date(Date.now() - 3600_000).toISOString() },
});
const expired = await fn("upsert-vouch", t6, {
  trader_id: jamesT.trader_id,
  trade_id: bassoonRows[0].id,
  invite_token: vToken,
});
check("expired token rejected", expired.status === 403 && expired.data?.error === "gate_not_met");

// --------------------------------------------------- referral crediting ----
const { data: riaRef } = await rest(
  "referrals?select=credited,referred_phone_hash,referrer_user_id&order=created_at.desc&limit=1",
);
check(
  "Ria's referral row credited with phone fingerprint",
  riaRef[0]?.credited === true &&
    riaRef[0]?.referred_phone_hash === sha256("+18685550006") &&
    riaRef[0]?.referrer_user_id === keisha.id,
  JSON.stringify(riaRef),
);
const { data: keishaRefsAfter } = await rest(
  `credit_ledger?user_id=eq.${keisha.id}&reason=eq.referral&select=id`,
);
check("Keisha earned exactly +1 referral month", keishaRefsAfter.length === keishaRefsBefore.length + 1);
const { data: keishaTraderAfter } = await rest(
  `trader_profiles?id=eq.${keishaT.trader_id}&select=free_until`,
);
check(
  "trader referrer's free_until extended by 1 month",
  keishaTraderAfter[0].free_until === addMonths(keishaFreeUntilBefore, 1),
  `${keishaFreeUntilBefore} → ${keishaTraderAfter[0].free_until}`,
);

const repeat = await fn("complete-profile", t6, {
  display_name: "Ria Boodoo",
  home_region_id: 14,
  referral_code: keisha.referral_code,
});
const { data: keishaRefsRepeat } = await rest(
  `credit_ledger?user_id=eq.${keisha.id}&reason=eq.referral&select=id`,
);
check(
  "idempotent re-call never double-credits",
  repeat.data?.created === false && keishaRefsRepeat.length === keishaRefsAfter.length,
);

// farming defense: same phone can never earn a second credit
const t7a = await login("+18685550007");
await fn("complete-profile", t7a, {
  display_name: "Farm One",
  home_region_id: 10,
  referral_code: nikki.referral_code,
});
const { data: nikkiLedger1 } = await rest(
  `credit_ledger?user_id=eq.${nikki.id}&reason=eq.referral&select=id`,
);
check("first signup credits the referrer", nikkiLedger1.length === 1);
await fn("delete-account", t7a);
const t7b = await login("+18685550007");
await fn("complete-profile", t7b, {
  display_name: "Farm Two",
  home_region_id: 10,
  referral_code: nikki.referral_code,
});
const { data: nikkiLedger2 } = await rest(
  `credit_ledger?user_id=eq.${nikki.id}&reason=eq.referral&select=id`,
);
const { data: farmRef } = await rest(
  "referrals?select=credited&order=created_at.desc&limit=1",
);
check(
  "recycled phone cannot earn a second credit",
  nikkiLedger2.length === 1 && farmRef[0]?.credited === false,
  JSON.stringify({ ledger: nikkiLedger2.length, row: farmRef[0] }),
);

// 24-months-per-year cap
for (let i = 0; i < 24; i++) {
  await rest("credit_ledger", {
    method: "POST",
    body: { user_id: tariq.id, months: 1, reason: "referral" },
  });
}
const t8 = await login("+18685550008");
await fn("complete-profile", t8, {
  display_name: "Cap Test",
  home_region_id: 11,
  referral_code: tariq.referral_code,
});
const { data: tariqLedger } = await rest(
  `credit_ledger?user_id=eq.${tariq.id}&reason=eq.referral&select=id`,
);
const { data: capRef } = await rest(
  "referrals?select=credited&order=created_at.desc&limit=1",
);
check(
  "24 months/year cap holds",
  tariqLedger.length === 24 && capRef[0]?.credited === false,
  `ledger=${tariqLedger.length}`,
);

// ------------------------------------------------- resolve-invite (public) --
const fresh = await fn("create-invite", t4, { kind: "vouch_request" });
const resolveOk = await fn("resolve-invite", null, { token: fresh.data.token });
check(
  "public resolve returns the trader card",
  resolveOk.status === 200 &&
    resolveOk.data?.valid === true &&
    resolveOk.data?.kind === "vouch_request" &&
    resolveOk.data?.trader?.display_name === "James Testman" &&
    Array.isArray(resolveOk.data?.trader?.trade_names),
  JSON.stringify(resolveOk.data),
);
const resolveExpired = await fn("resolve-invite", null, { token: vToken });
check(
  "expired token resolves as invalid/expired",
  resolveExpired.data?.valid === false,
  JSON.stringify(resolveExpired.data),
);
const resolveGarbage = await fn("resolve-invite", null, { token: "nope-nope-nope-nope" });
check("garbage token resolves as invalid", resolveGarbage.data?.valid === false);

// ------------------------------------------------------------ rate limit ----
let limited = false;
for (let i = 0; i < 25 && !limited; i++) {
  const r = await fn("create-invite", t3, { kind: "join_invite" });
  if (r.status === 429 && r.data?.error === "rate_limited") limited = true;
}
check("invite creation is rate limited (≤20/day)", limited);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures ? 1 : 0);
