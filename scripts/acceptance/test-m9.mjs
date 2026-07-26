/** M9 acceptance — trust, safety & admin. Reviewer-authored contract.
 *
 * Admin surface: submit-flag (validated user reports), admin-action (one
 * audited chokepoint: resolve_flag/dismiss_flag/remove_vouch/hide_trader/
 * restore_trader/suspend_user/unsuspend_user/approve_trade/merge_trade/
 * adjust_credit), admin-lookup, admin_ring_report(). is_admin() gates all
 * of it. EVERY admin action writes exactly one audit_log row.
 *
 * Runs after test-m8.mjs. Admin fixture: Anika Ram gets role='admin'.
 * Error codes: unauthorized, invalid_input, not_admin, flag_not_found,
 * subject_not_found, rate_limited, account_suspended (in write paths).
 */
import { createHash } from "node:crypto";

const API = "http://127.0.0.1:54321";
const ANON =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";
const SERVICE =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

let failures = 0;
const check = (n, c, x = "") => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${c ? "" : "  " + x}`);
  if (!c) failures++;
};
const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const addMonths = (d, m) => {
  const x = new Date(d);
  x.setUTCMonth(x.getUTCMonth() + m);
  return x.toISOString().slice(0, 10);
};

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
async function fn(name, token, body = {}) {
  const r = await fetch(`${API}/functions/v1/${name}`, {
    method: "POST",
    headers: {
      apikey: ANON,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return { status: r.status, data: await r.json().catch(() => null) };
}
async function rest(path, { anon = false, token = null, method = "GET", body = null } = {}) {
  const key = anon ? ANON : SERVICE;
  const r = await fetch(`${API}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${token ?? key}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : null,
  });
  return { status: r.status, data: r.status === 204 ? null : await r.json().catch(() => null) };
}
async function rpc(name, body = {}, token = null) {
  const r = await fetch(`${API}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: ANON,
      Authorization: `Bearer ${token ?? ANON}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return { status: r.status, data: await r.json().catch(() => null) };
}
const auditCount = async () =>
  ((await rest("audit_log?select=id")).data ?? []).length;

// ---------------------------------------------------------------- setup ----
const t3 = await login("+18685550003"); // Tariq — reporter
const t9 = await login("+18685550009"); // Web Voucher — suspension target
const { data: users } = await rest("users?select=id,display_name");
const U = (n) => users.find((u) => u.display_name === n);
const anika = U("Anika Ram");
const tariq = U("Tariq Ali");
const webVoucher = U("Web Voucher");
await rest(`users?id=eq.${anika.id}`, { method: "PATCH", body: { role: "admin" } });
const tAdmin = await login("+18685550002");
const { data: dir } = await rest("trader_directory?select=trader_id,user_id,display_name", { anon: true });
const jamesT = dir.find((d) => d.display_name === "James Testman");
const keishaT = dir.find((d) => d.display_name === "Keisha Mohammed");

// --------------------------------------------------------------- flags ----
const flag = await fn("submit-flag", t3, {
  subject_type: "trader",
  subject_id: jamesT.trader_id,
  reason: "wrong_number",
  detail: "The listed number rings someone else.",
});
check("user files a report (201)", flag.status === 201, JSON.stringify(flag.data));
const badReason = await fn("submit-flag", t3, {
  subject_type: "trader",
  subject_id: jamesT.trader_id,
  reason: "i_disagree",
});
check("invalid reason rejected", badReason.status === 400);
const ghostSubject = await fn("submit-flag", t3, {
  subject_type: "vouch",
  subject_id: "00000000-0000-0000-0000-000000000000",
  reason: "spam",
});
check("nonexistent subject rejected", ghostSubject.status === 404 && ghostSubject.data?.error === "subject_not_found");
const { data: ownFlags } = await rest("flags?select=reporter_user_id", { anon: true, token: t3 });
check("reporter sees only own flags", ownFlags.length >= 1 && ownFlags.every((f) => f.reporter_user_id === tariq.id));
const { data: anonFlags } = await rest("flags?select=id", { anon: true });
check("anon sees no flags", !anonFlags?.length);

// ------------------------------------------------------- admin gating ------
const notAdmin = await fn("admin-action", t3, { action: "dismiss_flag", flag_id: flag.data.flag.id });
check("non-admin denied admin-action", notAdmin.status === 403 && notAdmin.data?.error === "not_admin");
const notAdminLookup = await fn("admin-lookup", t3, { query: "Keisha" });
check("non-admin denied lookup", notAdminLookup.status === 403);
const notAdminRing = await rpc("admin_ring_report", {}, t3);
check("non-admin gets empty/denied ring report", notAdminRing.status !== 200 || (notAdminRing.data ?? []).length === 0);

// ------------------------------------------- quiet vouch removal -----------
const { data: targetVouch } = await rest(
  `vouches?trader_id=eq.${jamesT.trader_id}&status=eq.published&select=id&limit=1`,
);
const { data: notifBefore } = await rest("notification_log?select=id");
const { data: countBefore } = await rest(
  `vouches?trader_id=eq.${jamesT.trader_id}&status=eq.published&select=id`,
);
let a0 = await auditCount();
const removal = await fn("admin-action", tAdmin, {
  action: "remove_vouch",
  vouch_id: targetVouch[0].id,
  note: "flagged, confirmed fake",
});
check("admin removes a vouch", removal.status === 200, JSON.stringify(removal.data));
const { data: countAfter } = await rest(
  `vouches?trader_id=eq.${jamesT.trader_id}&status=eq.published&select=id`,
);
check("removal decrements published count", countAfter.length === countBefore.length - 1);
const { data: notifAfter } = await rest("notification_log?select=id");
check("removal is QUIET — zero notifications", notifAfter.length === notifBefore.length);
check("removal audited", (await auditCount()) === a0 + 1);

// ------------------------------------------------- flag resolution ---------
const resolved = await fn("admin-action", tAdmin, {
  action: "resolve_flag",
  flag_id: flag.data.flag.id,
  resolution_note: "number corrected with trader",
});
check("flag resolved with note", resolved.status === 200);
const { data: flagRow } = await rest(`flags?id=eq.${flag.data.flag.id}&select=status,resolved_by,resolution_note`);
check(
  "flag row carries resolver + note",
  flagRow[0].status === "resolved" && flagRow[0].resolved_by === anika.id && /corrected/.test(flagRow[0].resolution_note),
);

// ------------------------------------------------- hide / restore ----------
await fn("admin-action", tAdmin, { action: "hide_trader", trader_id: keishaT.trader_id, note: "test hide" });
const hiddenSearch = await rpc("search_traders", { p_trade_id: 100 });
check("hidden trader vanishes from search", !hiddenSearch.data.some((r) => r.trader_id === keishaT.trader_id));
await fn("admin-action", tAdmin, { action: "restore_trader", trader_id: keishaT.trader_id });
const restoredSearch = await rpc("search_traders", { p_trade_id: 100 });
check("restore brings the trader back", restoredSearch.data.some((r) => r.trader_id === keishaT.trader_id));

// ------------------------------------------------- user suspension ---------
await fn("admin-action", tAdmin, { action: "suspend_user", user_id: webVoucher.id, note: "ring suspect" });
const suspendedVouch = await fn("upsert-vouch", t9, {
  trader_id: keishaT.trader_id,
  trade_id: 100,
  comment: "should be blocked",
});
check(
  "suspended user cannot vouch (account_suspended)",
  suspendedVouch.status === 403 && suspendedVouch.data?.error === "account_suspended",
  JSON.stringify(suspendedVouch.data),
);
const suspendedInvite = await fn("create-invite", t9, { kind: "join_invite" });
check("suspended user cannot create invites", suspendedInvite.status === 403);
await fn("admin-action", tAdmin, { action: "unsuspend_user", user_id: webVoucher.id });

// ------------------------------------------- taxonomy: approve + merge -----
const { data: drone } = await rest("trades?slug=eq.drone-roof-inspection&select=id,status");
await fn("admin-action", tAdmin, { action: "approve_trade", trade_id: drone[0].id });
const { data: droneAfter } = await rest(`trades?id=eq.${drone[0].id}&select=status`);
check("proposed trade approved to active", droneAfter[0].status === "active");

const { data: bassoon } = await rest("trades?slug=eq.bassoon-tuning&select=id");
const { data: jamesTradesBefore } = await rest(
  `trader_trades?trader_id=eq.${jamesT.trader_id}&select=trade_id`,
);
const merge = await fn("admin-action", tAdmin, {
  action: "merge_trade",
  from_trade_id: bassoon[0].id,
  into_trade_id: 100,
});
check("merge succeeds on conflict-heavy fixtures", merge.status === 200, JSON.stringify(merge.data));
const { data: bassoonAfter } = await rest(`trades?id=eq.${bassoon[0].id}&select=status,merged_into_id`);
check("merged trade marked with target", bassoonAfter[0].status === "merged" && bassoonAfter[0].merged_into_id === 100);
const { data: orphanTT } = await rest(`trader_trades?trade_id=eq.${bassoon[0].id}&select=trader_id`);
const { data: orphanV } = await rest(`vouches?trade_id=eq.${bassoon[0].id}&select=id`);
check("no trader_trades rows left on the merged trade", orphanTT.length === 0);
check("no vouches left on the merged trade", orphanV.length === 0);
const { data: jamesTradesAfter } = await rest(
  `trader_trades?trader_id=eq.${jamesT.trader_id}&select=trade_id`,
);
check(
  "dedup: James (had both) keeps exactly one plumber row",
  jamesTradesAfter.filter((t) => t.trade_id === 100).length === 1 &&
    jamesTradesAfter.length === jamesTradesBefore.length - 1,
);

// ------------------------------------------------- credit adjustment -------
const { data: ktBefore } = await rest(`trader_profiles?id=eq.${keishaT.trader_id}&select=free_until`);
await fn("admin-action", tAdmin, {
  action: "adjust_credit",
  user_id: keishaT.user_id,
  months: 2,
  note: "goodwill",
});
const { data: adminLedger } = await rest(
  `credit_ledger?user_id=eq.${keishaT.user_id}&reason=eq.admin&select=months`,
);
check("admin credit lands in the ledger", adminLedger.length === 1 && adminLedger[0].months === 2);
const { data: ktAfter } = await rest(`trader_profiles?id=eq.${keishaT.trader_id}&select=free_until`);
check("trader free_until extended by the adjustment", ktAfter[0].free_until === addMonths(ktBefore[0].free_until, 2));

// ------------------------------------------------- lookup + ring -----------
const lookup = await fn("admin-lookup", tAdmin, { query: "868-555-0001" });
check(
  "lookup by phone finds the member",
  lookup.status === 200 && JSON.stringify(lookup.data).includes("Keisha Mohammed"),
);
check(
  "lookup output never contains private block hashes",
  !JSON.stringify(lookup.data).includes(sha256("+18685550001")),
);
const ring = await rpc("admin_ring_report", {}, tAdmin);
check("admin ring report returns rows structure", ring.status === 200 && Array.isArray(ring.data));

// ------------------------------------------------- audit completeness ------
// actions performed above: remove_vouch, resolve_flag, hide, restore,
// suspend, unsuspend, approve_trade, merge_trade, adjust_credit = 9
check("every admin action audited (9 rows)", (await auditCount()) === a0 + 9, `delta=${(await auditCount()) - a0}`);
const { data: auditRead } = await rest("audit_log?select=id", { anon: true, token: t3 });
check("audit log invisible to non-admins", !auditRead?.length);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures ? 1 : 0);
