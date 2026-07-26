/** M2 acceptance test — trader profiles, against the local stack. */
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
  return { status: res.status, data: await res.json().catch(() => null) };
}
async function login(phone) {
  await auth("otp", { phone });
  const { data } = await auth("verify", { phone, token: "123456", type: "sms" });
  if (!data?.access_token) throw new Error(`login failed ${phone}`);
  return data.access_token;
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
async function rest(path, key, token = key, init = {}) {
  const res = await fetch(`${API}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  return {
    status: res.status,
    data: await res.json().catch(() => null),
  };
}
function addMonths(date, months) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d.toISOString().slice(0, 10);
}

const t1 = await login("+18685550001"); // Keisha (M1 test user, +6 ledger)
const t4 = await login("+18685550004"); // James Testman (browser test user)

// --- create ------------------------------------------------------------------
const create = await fn("upsert-trader-profile", t1, {
  business_name: "Keisha's Fix-It",
  bio: "Plumbing and AC work around town. Quick response.",
  trade_ids: [100, 108],
  proposed_trades: ["Drone Roof Inspection"],
  region_ids: [17, 13],
});
check("create returns 201", create.status === 201, JSON.stringify(create.data));
const prof = create.data?.profile;
// free_until = today + the sum of every month in the creator's ledger
// (6 signup + any referral months already earned — M6 credits at signup).
const { data: ledgerRows } = await rest(
  `credit_ledger?user_id=eq.${prof?.user_id}&select=months`,
  SERVICE,
);
const ledgerMonths = (ledgerRows ?? []).reduce((s, r) => s + r.months, 0);
check(
  `free_until = today + ledger months (${ledgerMonths})`,
  prof?.free_until === addMonths(new Date(), ledgerMonths),
  prof?.free_until,
);
check("3 trades attached", prof?.trader_trades?.length === 3);
check(
  "proposed trade created & attached",
  prof?.trader_trades?.some((t) => t.trades?.status === "proposed" && t.trades?.slug === "drone-roof-inspection"),
);
check("2 regions attached", prof?.trader_regions?.length === 2);
check("onboarding_complete set", prof?.onboarding_complete === true);

// --- update replaces sets, keeps free_until -----------------------------------
const update = await fn("upsert-trader-profile", t1, {
  bio: "Now island-wide.",
  trade_ids: [100],
  proposed_trades: [],
  region_ids: [1],
});
check("update returns 200/not created", update.status === 200 && update.data?.created === false);
const prof2 = update.data?.profile;
check("trades replaced (1)", prof2?.trader_trades?.length === 1);
check("regions replaced with All Trinidad", prof2?.trader_regions?.length === 1 && prof2?.trader_regions[0]?.region_id === 1);
check("free_until unchanged on update", prof2?.free_until === prof?.free_until);
check("business_name cleared when omitted", prof2?.business_name === null);

// --- proposed-trade dedup -------------------------------------------------------
await fn("upsert-trader-profile", t1, {
  trade_ids: [100],
  proposed_trades: ["Drone Roof Inspection"],
  region_ids: [1],
});
const dupes = await rest("trades?slug=eq.drone-roof-inspection&select=id", SERVICE);
check("re-proposing same service reuses the row", dupes.data?.length === 1);

// --- validation ----------------------------------------------------------------
const tooMany = await fn("upsert-trader-profile", t4, {
  trade_ids: [100, 101, 102, 103, 104, 105],
  region_ids: [17],
});
check("6 trades rejected", tooMany.status === 400 && tooMany.data?.error === "invalid_input");
const badRegion = await fn("upsert-trader-profile", t4, {
  trade_ids: [100],
  region_ids: [2],
});
check("disabled region (Tobago) rejected", badRegion.status === 400 && badRegion.data?.error === "invalid_region");
const noTrades = await fn("upsert-trader-profile", t4, {
  trade_ids: [],
  proposed_trades: [],
  region_ids: [17],
});
check("zero services rejected", noTrades.status === 400);
const ghostTrade = await fn("upsert-trader-profile", t4, {
  trade_ids: [99999],
  region_ids: [17],
});
check("unknown trade id rejected", ghostTrade.status === 400 && ghostTrade.data?.error === "unknown_trade");

// --- public read + status visibility ---------------------------------------------
const anonRead = await rest(`trader_profiles?id=eq.${prof.id}&select=id,status,free_until`, ANON);
check("anon sees active trader", anonRead.data?.length === 1);

await rest(`trader_profiles?id=eq.${prof.id}`, SERVICE, SERVICE, {
  method: "PATCH",
  body: JSON.stringify({ status: "hidden" }),
});
const anonHidden = await rest(`trader_profiles?id=eq.${prof.id}&select=id`, ANON);
check("anon cannot see hidden trader", anonHidden.data?.length === 0);
const ownerHidden = await rest(`trader_profiles?id=eq.${prof.id}&select=id`, ANON, t1);
check("owner still sees own hidden profile", ownerHidden.data?.length === 1);

const locked = await fn("upsert-trader-profile", t1, {
  trade_ids: [100],
  region_ids: [1],
});
check("hidden profile is locked for edits", locked.status === 403 && locked.data?.error === "profile_locked");

await rest(`trader_profiles?id=eq.${prof.id}`, SERVICE, SERVICE, {
  method: "PATCH",
  body: JSON.stringify({ status: "lapsed" }),
});
const anonLapsed = await rest(`trader_profiles?id=eq.${prof.id}&select=id,visible`, ANON);
check("lapsed trader still listed, visible=false", anonLapsed.data?.length === 1 && anonLapsed.data[0].visible === false);

await rest(`trader_profiles?id=eq.${prof.id}`, SERVICE, SERVICE, {
  method: "PATCH",
  body: JSON.stringify({ status: "active" }),
});

// --- RLS: other users can't touch it ----------------------------------------------
const beforeAttack = await rest(`trader_profiles?id=eq.${prof.id}&select=bio`, SERVICE);
await rest(`trader_profiles?id=eq.${prof.id}`, ANON, t4, {
  method: "PATCH",
  body: JSON.stringify({ bio: "hacked" }),
});
const afterAttack = await rest(`trader_profiles?id=eq.${prof.id}&select=bio`, SERVICE);
check(
  "stranger PATCH is a no-op",
  afterAttack.data?.[0]?.bio === beforeAttack.data?.[0]?.bio &&
    afterAttack.data?.[0]?.bio !== "hacked",
  JSON.stringify(afterAttack.data),
);
const junctionAttack = await rest("trader_trades", ANON, t4, {
  method: "POST",
  body: JSON.stringify({ trader_id: prof.id, trade_id: 101 }),
});
check("stranger cannot write junctions", junctionAttack.status >= 400);

// --- events -----------------------------------------------------------------------
const events = await rest("events?name=eq.trader_onboarded&select=id", SERVICE);
check("trader_onboarded tracked once", events.data?.length === 1);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures ? 1 : 0);
