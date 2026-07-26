/**
 * M1 acceptance test — runs against the local Supabase stack.
 * Standard local demo keys (public, dev-only).
 */
const API = "http://127.0.0.1:54321";
const ANON =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";
const SERVICE =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

let failures = 0;
function check(name, cond, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  " + extra}`);
  if (!cond) failures++;
}

async function auth(path, body, headers = {}) {
  const res = await fetch(`${API}/auth/v1/${path}`, {
    method: "POST",
    headers: { apikey: ANON, "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

async function login(phone) {
  await auth("otp", { phone });
  const { status, data } = await auth("verify", {
    phone,
    token: "123456",
    type: "sms",
  });
  if (status !== 200) throw new Error(`login failed ${phone}: ${JSON.stringify(data)}`);
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

async function rest(path, key, token = key) {
  const res = await fetch(`${API}/rest/v1/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${token}` },
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

// --- user 1: plain signup -------------------------------------------------
const t1 = await login("+18685550001");
const p1 = await fn("complete-profile", t1, {
  display_name: "Keisha Mohammed",
  home_region_id: 17,
});
check("signup creates profile (201)", p1.status === 201, JSON.stringify(p1.data));
check("phone_e164 normalized", p1.data?.profile?.phone_e164 === "+18685550001");
check(
  "phone_hash is sha256 hex",
  /^[0-9a-f]{64}$/.test(p1.data?.profile?.phone_hash ?? ""),
);
const code1 = p1.data?.profile?.referral_code;
check("referral code issued", /^[A-HJ-KM-NP-Z2-9]{6}$/.test(code1 ?? ""), code1);

const again = await fn("complete-profile", t1, {
  display_name: "Someone Else",
  home_region_id: 19,
});
check("idempotent re-call returns existing", again.status === 200 && again.data?.created === false);

// --- user 2: signup with user 1's referral code ---------------------------
const t2 = await login("+18685550002");
const p2 = await fn("complete-profile", t2, {
  display_name: "Andre Baptiste",
  home_region_id: 19,
  referral_code: code1.toLowerCase(), // case-insensitive entry
});
check("referred signup ok", p2.status === 201, JSON.stringify(p2.data));
check(
  "referred_by set",
  p2.data?.profile?.referred_by_user_id === p1.data?.profile?.id,
);
const u2id = p2.data?.profile?.id;

// --- user 3: bad inputs ----------------------------------------------------
const t3 = await login("+18685550003");
const bad1 = await fn("complete-profile", t3, {
  display_name: "Test Three",
  home_region_id: 17,
  referral_code: "ZZZZZ9",
});
check("invalid referral code rejected", bad1.status === 400 && bad1.data?.error === "invalid_referral_code");
const bad2 = await fn("complete-profile", t3, {
  display_name: "Test Three",
  home_region_id: 2, // Tobago: disabled
});
check("disabled region rejected", bad2.status === 400 && bad2.data?.error === "invalid_region");
const bad3 = await fn("complete-profile", t3, {
  display_name: "T",
  home_region_id: 17,
});
check("too-short name rejected", bad3.status === 400 && bad3.data?.error === "invalid_input");

// --- server-side state checks (service role) --------------------------------
const ledger = await rest(
  `credit_ledger?user_id=eq.${p1.data.profile.id}&reason=eq.signup_bonus&select=months,reason`,
  SERVICE,
);
check(
  "signup bonus +6 exactly once",
  ledger.data?.length === 1 && ledger.data[0].months === 6,
  JSON.stringify(ledger.data),
);

const refs = await rest(
  `referrals?referred_user_id=eq.${u2id}&select=referrer_user_id,credited`,
  SERVICE,
);
check(
  "referrals row created and credited (M6 live)",
  refs.data?.length === 1 && refs.data[0].credited === true,
);
const refLedger = await rest(
  `credit_ledger?user_id=eq.${p1.data.profile.id}&reason=eq.referral&select=months`,
  SERVICE,
);
check(
  "referrer earned +1 referral month",
  refLedger.data?.length === 1 && refLedger.data[0].months === 1,
);

const events = await rest(
  `events?name=eq.signup&select=user_id,props&order=id.asc`,
  SERVICE,
);
check(
  "signup events tracked with source",
  events.data?.length === 2 &&
    events.data[0].props.source === "organic" &&
    events.data[1].props.source === "referral",
  JSON.stringify(events.data),
);

// --- RLS spot checks ---------------------------------------------------------
const anonRegions = await rest("regions?select=id&limit=1", ANON);
check("anon can read regions", anonRegions.status === 200 && anonRegions.data?.length === 1);
const anonUsers = await rest("users?select=*", ANON);
check(
  "anon cannot read users table",
  anonUsers.status !== 200 || (Array.isArray(anonUsers.data) && anonUsers.data.length === 0),
  JSON.stringify(anonUsers.data)?.slice(0, 120),
);
const anonProfiles = await rest(
  `public_profiles?id=eq.${u2id}&select=display_name`,
  ANON,
);
check(
  "anon reads display names via public_profiles",
  anonProfiles.data?.[0]?.display_name === "Andre Baptiste",
);
const ownRow = await rest("users?select=id,phone_e164", ANON, t1);
check(
  "authed user sees exactly own row",
  ownRow.data?.length === 1 && ownRow.data[0].phone_e164 === "+18685550001",
);

// --- deletion (user 2) -------------------------------------------------------
const del = await fn("delete-account", t2);
check("delete-account succeeds", del.status === 200 && del.data?.deleted === true, JSON.stringify(del.data));

const gone = await rest(
  `users?id=eq.${u2id}&select=display_name,phone_e164,phone_hash,deleted_at`,
  SERVICE,
);
check(
  "profile anonymized, PII gone",
  gone.data?.[0]?.display_name === "A former member" &&
    gone.data[0].phone_e164 === null &&
    gone.data[0].phone_hash === null &&
    gone.data[0].deleted_at !== null,
  JSON.stringify(gone.data),
);

const authGone = await fetch(`${API}/auth/v1/admin/users/${u2id}`, {
  headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
});
check("auth record hard-deleted", authGone.status === 404);

const relogin = await auth("otp", { phone: "+18685550002" });
check("freed phone can start fresh signup", relogin.status === 200, JSON.stringify(relogin.data));

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures ? 1 : 0);
