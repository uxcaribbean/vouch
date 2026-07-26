/** M8 acceptance — notifications: server-enforced toggles, caps, digests.
 * Reviewer-authored; the implementation must satisfy THIS file.
 *
 * The observable is notification_log — every send DECISION is recorded:
 * status ∈ sent | no_token | error | skipped_pref | skipped_cap.
 * Transactional types (vouch_received, referral_credited) bypass the
 * 2/week cap; digest types (contacts_joined_traders, sync_nudge) don't.
 * run-nudges requires header x-cron-secret (default local-dev-cron-secret).
 *
 * Runs after test-m7.mjs.
 */
import { createHash } from "node:crypto";

const API = "http://127.0.0.1:54321";
const ANON =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";
const SERVICE =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";
const CRON = "local-dev-cron-secret";

let failures = 0;
const check = (n, c, x = "") => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${c ? "" : "  " + x}`);
  if (!c) failures++;
};
const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");

async function auth(path, body) {
  const r = await fetch(`${API}/auth/v1/${path}`, {
    method: "POST",
    headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json();
}
async function login(p) {
  await auth("otp", { phone: p });
  const d = await auth("verify", { phone: p, token: "123456", type: "sms" });
  if (!d?.access_token) throw new Error(`login failed ${p}`);
  return d.access_token;
}
async function fn(name, token, body = {}, headers = {}) {
  const r = await fetch(`${API}/functions/v1/${name}`, {
    method: "POST",
    headers: {
      apikey: ANON,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  return { status: r.status, data: await r.json().catch(() => null) };
}
async function rest(path, { anon = false, token = null, method = "GET", body = null, prefer = null } = {}) {
  const key = anon ? ANON : SERVICE;
  const r = await fetch(`${API}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${token ?? key}`,
      "Content-Type": "application/json",
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: body ? JSON.stringify(body) : null,
  });
  return { status: r.status, data: r.status === 204 ? null : await r.json().catch(() => null) };
}
// Earlier suites legitimately write notification_log rows now that M8 is
// live (their vouches/referrals notify — that's the feature). Scope every
// assertion to THIS suite's window.
const T0 = new Date().toISOString();
const logsFor = async (userId, type) =>
  (
    await rest(
      `notification_log?user_id=eq.${userId}&type=eq.${type}&created_at=gte.${encodeURIComponent(T0)}&select=status,title,body&order=created_at.asc`,
    )
  ).data ?? [];

// ---------------------------------------------------------------- setup ----
const t3 = await login("+18685550003"); // Tariq — sync off
const t4 = await login("+18685550004"); // James — trader
const t6 = await login("+18685550006"); // Ria — has vouch on James×100
const t9 = await login("+18685550009"); // Web Voucher — has weblink vouch on James×100
const { data: users } = await rest("users?select=id,display_name");
const U = (n) => users.find((u) => u.display_name === n);
const james = U("James Testman");
const tariq = U("Tariq Ali");
const nikki = U("Nikki Persad");
const anika = U("Anika Ram");
const { data: dir } = await rest("trader_directory?select=trader_id,display_name", { anon: true });
const jamesT = dir.find((d) => d.display_name === "James Testman");
const { data: bassoon } = await rest("trades?slug=eq.bassoon-tuning&select=id");

// ------------------------------------------------------ push_tokens RLS ----
const ownToken = await rest("push_tokens", {
  anon: true,
  token: t4,
  method: "POST",
  body: { user_id: james.id, token: "ExponentPushToken[test-james]", platform: "ios" },
  prefer: "resolution=merge-duplicates",
});
check("user registers own push token", ownToken.status < 300, JSON.stringify(ownToken.data));
const foreign = await rest("push_tokens", {
  anon: true,
  token: t3,
  method: "POST",
  body: { user_id: james.id, token: "ExponentPushToken[evil]", platform: "ios" },
});
check("cannot register a token for someone else", foreign.status >= 400);
const anonRead = await rest("push_tokens?select=token", { anon: true });
check("tokens not readable by anon", !anonRead.data?.length);

// ------------------------------------ transactional: vouch received --------
const invite = await fn("create-invite", t4, { kind: "vouch_request" });
const newVouch = await fn("upsert-vouch", t9, {
  trader_id: jamesT.trader_id,
  trade_id: bassoon[0].id,
  comment: "Tuned my bassoon beautifully.",
  invite_token: invite.data.token,
});
check("fresh vouch publishes", newVouch.status === 201);
let vlogs = await logsFor(james.id, "vouch_received");
check(
  "vouch_received notification logged (token present → sent/error)",
  vlogs.length === 1 && ["sent", "error"].includes(vlogs[0].status),
  JSON.stringify(vlogs),
);
await fn("upsert-vouch", t9, {
  trader_id: jamesT.trader_id,
  trade_id: bassoon[0].id,
  comment: "Edited comment.",
  invite_token: invite.data.token,
});
vlogs = await logsFor(james.id, "vouch_received");
check("editing a vouch does not re-notify", vlogs.length === 1);

// pref off → skipped_pref, server-side
await rest("notification_prefs", {
  anon: true,
  token: t4,
  method: "POST",
  body: { user_id: james.id, type: "vouch_received", enabled: false },
  prefer: "resolution=merge-duplicates",
});
const riaVouch = await fn("upsert-vouch", t6, {
  trader_id: jamesT.trader_id,
  trade_id: bassoon[0].id,
  comment: "Bassoon sounding sweet too.",
  invite_token: invite.data.token,
});
check("second voucher publishes", riaVouch.status === 201, JSON.stringify(riaVouch.data));
vlogs = await logsFor(james.id, "vouch_received");
check(
  "disabled type is skipped server-side (skipped_pref)",
  vlogs.length === 2 && vlogs[1].status === "skipped_pref",
  JSON.stringify(vlogs),
);

// --------------------------------- transactional: referral credited --------
const t8a = await login("+18685550008");
// register a device token, then delete: M1.4 must sweep device rows too
const { data: capTestRows } = await rest("users?display_name=eq.Cap Test&select=id");
const capTestId = capTestRows[0].id;
await rest("push_tokens", {
  anon: true,
  token: t8a,
  method: "POST",
  body: { user_id: capTestId, token: "ExponentPushToken[test-0008]", platform: "android" },
  prefer: "resolution=merge-duplicates",
});
await fn("delete-account", t8a);
const { data: orphanTokens } = await rest(`push_tokens?user_id=eq.${capTestId}&select=token`);
check("account deletion purges push tokens", orphanTokens.length === 0, JSON.stringify(orphanTokens));
const t8b = await login("+18685550008");
await fn("complete-profile", t8b, {
  display_name: "Referred Again",
  home_region_id: 12,
  referral_code: (await rest(`users?id=eq.${nikki.id}&select=referral_code`)).data[0].referral_code,
});
const rlogs = await logsFor(nikki.id, "referral_credited");
check(
  "referral_credited notification logged for the referrer",
  rlogs.length === 1 && ["sent", "error", "no_token"].includes(rlogs[0].status),
  JSON.stringify(rlogs),
);

// ------------------------------------------- digests via run-nudges --------
const noSecret = await fn("run-nudges", null, {});
check("run-nudges rejects calls without the cron secret", noSecret.status === 401 || noSecret.status === 403);

// Anika: sync off + already at the 2/week non-transactional cap
await rest(`users?id=eq.${anika.id}`, { method: "PATCH", body: { contact_sync_enabled: false } });
for (let i = 0; i < 2; i++) {
  await rest("notification_log", {
    method: "POST",
    body: { user_id: anika.id, type: "contacts_joined_traders", status: "sent", title: "x", body: "x" },
  });
}
// Nikki: sync off + 3 dismissals → never nudged again
for (let i = 0; i < 3; i++) {
  await rest("events", { method: "POST", body: { user_id: nikki.id, name: "sync_nudge_dismissed", props: {} } });
}

const run1 = await fn("run-nudges", null, {}, { "x-cron-secret": CRON });
check("run-nudges runs with the secret", run1.status === 200, JSON.stringify(run1.data));

const tariqNudge = await logsFor(tariq.id, "sync_nudge");
check(
  "non-synced user gets the sync nudge",
  tariqNudge.length === 1 && ["sent", "no_token", "error"].includes(tariqNudge[0].status),
  JSON.stringify(tariqNudge),
);
check(
  "nudge body carries the monthly vouch count (spec copy)",
  /vouched \d+ traders this month/.test(tariqNudge[0]?.body ?? ""),
  tariqNudge[0]?.body,
);
const anikaNudge = await logsFor(anika.id, "sync_nudge");
check(
  "2/week cap enforced server-side (skipped_cap)",
  anikaNudge.length === 1 && anikaNudge[0].status === "skipped_cap",
  JSON.stringify(anikaNudge),
);
const nikkiNudge = await logsFor(nikki.id, "sync_nudge");
check("3 dismissals stop the nudge entirely", nikkiNudge.length === 0, JSON.stringify(nikkiNudge));

const run2 = await fn("run-nudges", null, {}, { "x-cron-secret": CRON });
check("second run within 14 days re-nudges nobody", run2.status === 200 && (await logsFor(tariq.id, "sync_nudge")).length === 1);

// contacts-joined-traders digest: Tariq now syncs and knows trader James
await rest(`users?id=eq.${tariq.id}`, { method: "PATCH", body: { contact_sync_enabled: true } });
await rest("contact_hashes", {
  method: "POST",
  body: { owner_user_id: tariq.id, phone_hash: sha256("+18685550004") },
  prefer: "resolution=merge-duplicates",
});
await fn("run-nudges", null, {}, { "x-cron-secret": CRON });
const tariqJoined = await logsFor(tariq.id, "contacts_joined_traders");
check(
  "contacts-joined-traders digest fires for synced user",
  tariqJoined.length === 1 && ["sent", "no_token", "error"].includes(tariqJoined[0].status),
  JSON.stringify(tariqJoined),
);

// log privacy: users see only their own rows
const ownLogs = await rest("notification_log?select=user_id", { anon: true, token: t4 });
check(
  "notification_log rows are owner-scoped",
  ownLogs.data.length > 0 && ownLogs.data.every((r) => r.user_id === james.id),
);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures ? 1 : 0);
