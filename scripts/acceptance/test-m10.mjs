/** M10 (lifecycle) acceptance — the provider-independent billing core.
 * Reviewer-authored contract. Provider checkout/webhook integration waits
 * on founder decisions (spec §7); this file pins the state machine that
 * the webhook will drive: lapse, warn (T-30/7/1), reactivate.
 *
 * run-billing-lifecycle is cron-guarded like run-nudges (x-cron-secret,
 * local default 'local-dev-cron-secret'). Access rule: free_until >= today
 * OR a subscriptions row with status in (active, cancelled) whose
 * current_period_end is in the future.
 *
 * Runs after test-m11.mjs (Anika is admin; James + Keisha are traders).
 */
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
const dayOffset = (days) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
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
const runJob = () => fn("run-billing-lifecycle", null, {}, { "x-cron-secret": CRON });
const setFreeUntil = (traderId, date) =>
  rest(`trader_profiles?id=eq.${traderId}`, { method: "PATCH", body: { free_until: date } });
const traderRow = async (traderId) =>
  (await rest(`trader_profiles?id=eq.${traderId}&select=status,free_until`)).data[0];
const billingLogs = async (userId) =>
  (await rest(`notification_log?user_id=eq.${userId}&type=eq.billing&select=status,body,data&order=created_at.asc`)).data ?? [];

// ---------------------------------------------------------------- setup ----
// Dedupe key is (threshold, for_date) on ANY billing log row, so the
// toggle test (James) and the sent-warning tests (Keisha) use different
// traders to keep their dedupe keys disjoint.
const t4 = await login("+18685550004");
const { data: dir } = await rest("trader_directory?select=trader_id,user_id,display_name", { anon: true });
const jamesT = dir.find((d) => d.display_name === "James Testman");
const keishaT = dir.find((d) => d.display_name === "Keisha Mohammed");
const tAdmin = await login("+18685550002");

// ------------------------------------------------------------ cron guard ----
const noSecret = await fn("run-billing-lifecycle", null, {});
check("job rejects calls without the cron secret", noSecret.status === 401 || noSecret.status === 403);

// ------------------------------------- toggle first (James, T-30 window) ----
await rest("notification_prefs", {
  anon: true,
  token: t4,
  method: "POST",
  body: { user_id: jamesT.user_id, type: "billing", enabled: false },
});
await setFreeUntil(jamesT.trader_id, dayOffset(30));
await runJob();
const afterToggle = await billingLogs(jamesT.user_id);
check(
  "billing toggle off → skipped_pref (logged, never pushed)",
  afterToggle.length === 1 && afterToggle[0].status === "skipped_pref",
  JSON.stringify(afterToggle),
);
await runJob();
check(
  "skipped warnings don't re-log daily (dedupe on threshold+date)",
  (await billingLogs(jamesT.user_id)).length === 1,
);
await rest("notification_prefs", {
  anon: true,
  token: t4,
  method: "POST",
  body: { user_id: jamesT.user_id, type: "billing", enabled: true },
});

// ------------------------------------------------ warnings (Keisha) --------
for (const threshold of [30, 7, 1]) {
  await setFreeUntil(keishaT.trader_id, dayOffset(threshold));
  const run = await runJob();
  check(`T-${threshold}: job runs`, run.status === 200, JSON.stringify(run.data));
  const logs = await billingLogs(keishaT.user_id);
  const hit = logs.filter((l) => l.data?.threshold === threshold);
  check(
    `T-${threshold}: exactly one warning logged`,
    hit.length === 1 && ["sent", "no_token", "error"].includes(hit[0].status),
    JSON.stringify(logs),
  );
  const again = await runJob();
  const logsAfter = await billingLogs(keishaT.user_id);
  check(
    `T-${threshold}: second run same day does not duplicate`,
    again.status === 200 &&
      logsAfter.filter((l) => l.data?.threshold === threshold).length === 1,
  );
}
check(
  "warnings are date-stamped (re-arm when free_until moves)",
  (await billingLogs(keishaT.user_id)).every((l) => !!l.data?.for_date),
);
await setFreeUntil(keishaT.trader_id, dayOffset(180)); // restore Keisha

// ---------------------------------------------------------------- lapse ----
await setFreeUntil(jamesT.trader_id, dayOffset(-1));
const lapseRun = await runJob();
check("expired free period lapses the trader", lapseRun.status === 200 && (await traderRow(jamesT.trader_id)).status === "lapsed");
const { data: lapsedDir } = await rest(
  `trader_directory?trader_id=eq.${jamesT.trader_id}&select=status,phone_e164`,
  { anon: true },
);
check(
  "lapsed trader stays listed but loses contact (M2/M3 behavior holds)",
  lapsedDir[0]?.status === "lapsed" && lapsedDir[0]?.phone_e164 === null,
);
const { data: lapseEvents } = await rest("events?name=eq.trader_lapsed&select=id");
check("lapse tracked as an event", lapseEvents.length >= 1);
const lapseAgain = await runJob();
check("already-lapsed trader is not re-lapsed", lapseAgain.status === 200 && lapseAgain.data?.lapsed === 0, JSON.stringify(lapseAgain.data));

// ------------------------------------------------- reactivation: credit ----
await fn("admin-action", tAdmin, {
  action: "adjust_credit",
  user_id: jamesT.user_id,
  months: 1,
  note: "lifecycle test goodwill",
});
await runJob();
check(
  "admin credit reactivates on next job run (closes the M9 loop)",
  (await traderRow(jamesT.trader_id)).status === "active",
);

// -------------------------------------------- reactivation: subscription ----
await setFreeUntil(jamesT.trader_id, dayOffset(-3));
await runJob();
check("lapsed again once credit window passes", (await traderRow(jamesT.trader_id)).status === "lapsed");

await rest("subscriptions", {
  method: "POST",
  body: {
    user_id: jamesT.user_id,
    provider: "manual",
    provider_ref: "test-sub-1",
    status: "active",
    current_period_end: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
  },
});
await runJob();
check("active subscription reactivates the trader", (await traderRow(jamesT.trader_id)).status === "active");

// cancelled-but-paid keeps access until the period ends
await rest(`subscriptions?provider_ref=eq.test-sub-1`, { method: "PATCH", body: { status: "cancelled" } });
await runJob();
check("cancelled subscription honors the paid period", (await traderRow(jamesT.trader_id)).status === "active");

await rest(`subscriptions?provider_ref=eq.test-sub-1`, {
  method: "PATCH",
  body: { current_period_end: new Date(Date.now() - 3600_000).toISOString() },
});
await runJob();
check("expired period → lapses (trial→paid→cancelled→lapsed complete)", (await traderRow(jamesT.trader_id)).status === "lapsed");

// -------------------------------------------------------- RLS on subs ----
const { data: ownSubs } = await rest("subscriptions?select=provider_ref", { anon: true, token: t4 });
check("owner reads own subscription", ownSubs.some((s) => s.provider_ref === "test-sub-1"));
const t3 = await login("+18685550003");
const { data: strangerSubs } = await rest("subscriptions?select=provider_ref", { anon: true, token: t3 });
check("strangers see no one else's subscriptions", strangerSubs.length === 0);
const clientWrite = await rest("subscriptions", {
  anon: true,
  token: t4,
  method: "POST",
  body: { user_id: jamesT.user_id, provider: "manual", provider_ref: "hax", status: "active", current_period_end: new Date().toISOString() },
});
check("clients cannot write subscriptions", clientWrite.status >= 400);

// hygiene: hidden/suspended traders are untouched by the job
await rest(`trader_profiles?id=eq.${jamesT.trader_id}`, { method: "PATCH", body: { status: "hidden" } });
await runJob();
check("job never resurrects hidden/suspended traders", (await traderRow(jamesT.trader_id)).status === "hidden");
await rest(`trader_profiles?id=eq.${jamesT.trader_id}`, { method: "PATCH", body: { status: "active" } });
await setFreeUntil(jamesT.trader_id, dayOffset(180));

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures ? 1 : 0);
