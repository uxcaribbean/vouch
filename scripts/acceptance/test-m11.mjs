/** M11 acceptance — the north-star metrics (spec M11).
 * Reviewer-authored contract for admin_metrics(): one JSON object, four
 * blocks, computed from the EVENTS log (immutable) not mutable rows, and
 * admin-gated. The suite recomputes each expectation independently from
 * the raw events via the service role and compares.
 *
 * Runs after test-m9.mjs (Anika Ram is the admin by then).
 */
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
  return d.access_token;
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
async function events(name, extra = "") {
  const r = await fetch(
    `${API}/rest/v1/events?name=eq.${name}${extra}&select=props,created_at`,
    { headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } },
  );
  return r.json();
}

const tAdmin = await login("+18685550002"); // Anika — admin since test-m9
const tPlain = await login("+18685550003");

// seed search events incl. a legacy one without friend_results_count
const seedUser = (await (await fetch(`${API}/rest/v1/users?display_name=eq.Tariq Ali&select=id`, {
  headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
})).json())[0];
for (const props of [
  { trade_id: 100, region_id: 17, results_count: 3, friend_results_count: 2 },
  { trade_id: 100, region_id: 13, results_count: 2, friend_results_count: 0 },
  { trade_id: 101, region_id: null, results_count: 0 }, // legacy shape
]) {
  await fetch(`${API}/rest/v1/events`, {
    method: "POST",
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json" },
    body: JSON.stringify({ user_id: seedUser.id, name: "search_performed", props }),
  });
}

// ------------------------------------------------------------ gating -------
const denied = await rpc("admin_metrics", {}, tPlain);
check("non-admin denied metrics", denied.status >= 400, JSON.stringify(denied.data).slice(0, 120));
const anonDenied = await rpc("admin_metrics", {});
check("anon denied metrics", anonDenied.status >= 400);

const res = await rpc("admin_metrics", {}, tAdmin);
check("admin gets metrics (200)", res.status === 200, JSON.stringify(res.data).slice(0, 200));
const m = res.data;
check(
  "all four north-star blocks present",
  !!m?.friend_search_share && !!m?.viral_factor && !!m?.vouch_conversion && !!m?.trader_activation,
  JSON.stringify(Object.keys(m ?? {})),
);

// ---------------------------------------- 1. friend-search share -----------
const searches = await events("search_performed");
const withKey = searches.filter((e) => e.props && "friend_results_count" in e.props);
const withFriend = withKey.filter((e) => (e.props.friend_results_count ?? 0) > 0);
check(
  "friend share counts only events carrying the key",
  m.friend_search_share.searches === withKey.length &&
    m.friend_search_share.with_friend_result === withFriend.length,
  `rpc=${JSON.stringify(m.friend_search_share)} expected=${withKey.length}/${withFriend.length}`,
);
check(
  "friend share ratio consistent",
  withKey.length === 0
    ? m.friend_search_share.share === null
    : Math.abs(m.friend_search_share.share - withFriend.length / withKey.length) < 1e-9,
);

// ---------------------------------------- 2. viral factor ------------------
const signups = await events("signup");
const referral = signups.filter((e) => e.props?.source === "referral");
check(
  "viral factor matches the events math",
  m.viral_factor.total_signups === signups.length &&
    m.viral_factor.referral_signups === referral.length &&
    Math.abs(m.viral_factor.factor - referral.length / signups.length) < 1e-9,
  JSON.stringify(m.viral_factor),
);

// ---------------------------------------- 3. vouch conversion --------------
const opened = await events("invite_link_opened");
const created = await events("vouch_created");
const weblink = created.filter((e) => e.props?.source === "weblink");
check(
  "vouch conversion = weblink vouches / links opened",
  m.vouch_conversion.links_opened === opened.length &&
    m.vouch_conversion.weblink_vouches === weblink.length &&
    (opened.length === 0
      ? m.vouch_conversion.rate === null
      : Math.abs(m.vouch_conversion.rate - weblink.length / opened.length) < 1e-9),
  JSON.stringify(m.vouch_conversion),
);

// ---------------------------------------- 4. trader activation -------------
// All local fixtures are younger than 14 days → zero eligible, null rate.
check(
  "trader activation null-safe on young data",
  m.trader_activation.eligible_traders === 0 &&
    m.trader_activation.activated === 0 &&
    m.trader_activation.rate === null,
  JSON.stringify(m.trader_activation),
);

// no NaN/undefined smuggled through JSON
check("payload is clean JSON (no NaN/undefined)", !JSON.stringify(m).match(/NaN|undefined/));

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures ? 1 : 0);
