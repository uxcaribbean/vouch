/** M7 acceptance — the no-install web vouch flow's server contract.
 * Reviewer-authored; the implementation must satisfy THIS file.
 *
 * Simulates the cold visitor end to end at the API level: resolve a
 * vouch-request token → OTP login → minimal account (display name ONLY,
 * spec M7.2) → publish a vouch with source 'weblink' through the M5 gate.
 * The web page itself is verified in the browser; this file pins the
 * contracts it depends on.
 *
 * Runs after test-m6.mjs. Fresh test number: +18685550009.
 */
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
async function rest(path, { anon = false, token = null } = {}) {
  const key = anon ? ANON : SERVICE;
  const res = await fetch(`${API}/rest/v1/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${token ?? key}` },
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

// ---------------------------------------------------------------- setup ----
const t4 = await login("+18685550004"); // James — trader
const invite = await fn("create-invite", t4, { kind: "vouch_request" });
const vToken = invite.data?.token;
const { data: jamesRows } = await rest(
  "users?display_name=eq.James Testman&select=id,referral_code",
);
const james = jamesRows[0];

// ------------------------------------------------- resolve contract (M7.1) --
const { data: openedBefore } = await rest(
  "events?name=eq.invite_link_opened&select=id",
);
const resolved = await fn("resolve-invite", null, { token: vToken });
check(
  "resolve returns trades as {id,name} pairs",
  resolved.data?.valid === true &&
    Array.isArray(resolved.data?.trader?.trades) &&
    resolved.data.trader.trades.some((t) => t.id === 100 && t.name === "Plumber"),
  JSON.stringify(resolved.data?.trader?.trades),
);
check(
  "resolve keeps trade_names (back-compat)",
  Array.isArray(resolved.data?.trader?.trade_names),
);
check(
  "resolve includes the inviter's referral code for the join CTA",
  resolved.data?.referral_code === james.referral_code,
);
check(
  "resolve never exposes a phone",
  !JSON.stringify(resolved.data).includes("phone"),
);
const { data: openedAfter } = await rest(
  "events?name=eq.invite_link_opened&select=id,props",
);
check(
  "invite_link_opened tracked server-side (M11 must-track)",
  openedAfter.length === openedBefore.length + 1,
);
check(
  "opened event never logs the bearer token",
  !JSON.stringify(openedAfter).includes(vToken),
);

// ----------------------------------- cold visitor: minimal account (M7.2) --
const t9 = await login("+18685550009");
const minimal = await fn("complete-profile", t9, { display_name: "Web Voucher" });
check(
  "minimal account: display name only, no region (201)",
  minimal.status === 201 && minimal.data?.profile?.home_region_id === null,
  JSON.stringify(minimal.data),
);

// -------------------------------------- weblink vouch through the gate ------
const webVouch = await fn("upsert-vouch", t9, {
  trader_id: resolved.data.trader.trader_id,
  trade_id: 100,
  comment: "Vouched from the web link — took a minute.",
  invite_token: vToken,
  source: "weblink",
});
check("weblink vouch publishes through gate (b)", webVouch.status === 201, JSON.stringify(webVouch.data));
check("vouch row carries source weblink", webVouch.data?.vouch?.source === "weblink");

const badSource = await fn("upsert-vouch", t9, {
  trader_id: resolved.data.trader.trader_id,
  trade_id: 100,
  invite_token: vToken,
  source: "sms",
});
check("unknown source rejected", badSource.status === 400 && badSource.data?.error === "invalid_input");

// Ria's M6 vouch was created without a source param — default must be 'app'.
const { data: riaVouch } = await rest(
  "vouches?comment=eq.Quick and tidy work.&select=source",
);
check("source defaults to app when omitted", riaVouch?.[0]?.source === "app");

// -------------------------------------------- continuity + integrity -------
const { data: ownRows } = await rest("vouches?select=status,source", {
  anon: true,
  token: t9,
});
check(
  "web-created user sees their vouch (same account on mobile later)",
  ownRows.some((v) => v.source === "weblink" && v.status === "published"),
);
const { data: publicNames } = await rest(
  `public_profiles?display_name=eq.Web Voucher&select=display_name`,
  { anon: true },
);
check("web voucher's name resolves on the public list", publicNames.length === 1);

const { data: rawCount } = await rest(
  `vouches?trader_id=eq.${resolved.data.trader.trader_id}&status=eq.published&select=id`,
);
const searchRes = await fetch(`${API}/rest/v1/rpc/search_traders`, {
  method: "POST",
  headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, "Content-Type": "application/json" },
  body: JSON.stringify({ p_trade_id: 100 }),
});
const searchData = await searchRes.json();
const jamesCard = searchData.find((r) => r.trader_id === resolved.data.trader.trader_id);
check(
  "weblink vouch counts in search like any other",
  jamesCard?.vouch_count === rawCount.length,
  `card=${jamesCard?.vouch_count} raw=${rawCount.length}`,
);
const nullRegionSearch = await fetch(`${API}/rest/v1/rpc/search_traders`, {
  method: "POST",
  headers: { apikey: ANON, Authorization: `Bearer ${(await auth("verify", { phone: "+18685550009", token: "123456", type: "sms" })).access_token ?? ANON}`, "Content-Type": "application/json" },
  body: JSON.stringify({}),
});
check("null-region user searches fine", nullRegionSearch.status === 200);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures ? 1 : 0);
