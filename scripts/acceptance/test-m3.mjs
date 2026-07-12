/** M3 acceptance — search correctness + phone exposure, local stack.
 * Fixtures: Keisha (+…0001): trader, plumber(100)+proposed, region 1 (island-wide).
 *           James  (+…0004): trader, plumber(100)+proposed, region 10 (Arima).
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
async function rpc(body, key = ANON) {
  const res = await fetch(`${API}/rest/v1/rpc/search_traders`, {
    method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}
async function rest(path, init = {}) {
  const res = await fetch(`${API}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: init.anon ? ANON : SERVICE,
      Authorization: `Bearer ${init.anon ? ANON : SERVICE}`,
      "Content-Type": "application/json",
    },
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

const names = (r) => (r.data ?? []).map((x) => x.display_name);

// baseline: both fixtures are active plumbers
const all = await rpc({});
check("anon browse-all returns both traders", names(all).length === 2, JSON.stringify(names(all)));

const plumberPOS = await rpc({ p_trade_id: 100, p_region_id: 17 });
check(
  "plumber in Port of Spain → island-wide Keisha only",
  names(plumberPOS).join() === "Keisha Mohammed",
  JSON.stringify(names(plumberPOS)),
);

const plumberArima = await rpc({ p_trade_id: 100, p_region_id: 10 });
check("plumber in Arima → both (island-wide + local)", names(plumberArima).length === 2);

const allTrinidad = await rpc({ p_trade_id: 100, p_region_id: 1 });
check("All-Trinidad region → both", names(allTrinidad).length === 2);

const electricians = await rpc({ p_trade_id: 101 });
check("electrician search → empty", names(electricians).length === 0);

// lapsed: still listed, sorts last, loses phone
const { data: keishaRow } = await rest("trader_profiles?select=id,user_id&order=created_at.asc&limit=1");
const keishaTraderId = keishaRow[0].id;
await rest(`trader_profiles?id=eq.${keishaTraderId}`, { method: "PATCH", body: JSON.stringify({ status: "lapsed" }) });

const withLapsed = await rpc({ p_trade_id: 100, p_region_id: 10 });
check(
  "lapsed trader still listed but sorts last",
  names(withLapsed).length === 2 && names(withLapsed)[1] === "Keisha Mohammed",
  JSON.stringify(names(withLapsed)),
);

const dirLapsed = await rest(`trader_directory?trader_id=eq.${keishaTraderId}&select=display_name,phone_e164,status`, { anon: true });
check(
  "lapsed trader in directory with phone hidden",
  dirLapsed.data?.[0]?.status === "lapsed" && dirLapsed.data[0].phone_e164 === null,
  JSON.stringify(dirLapsed.data),
);

const dirActive = await rest(`trader_directory?status=eq.active&select=display_name,phone_e164`, { anon: true });
check(
  "active trader exposes contact phone to anon",
  dirActive.data?.length === 1 && /^\+1868/.test(dirActive.data[0].phone_e164 ?? ""),
  JSON.stringify(dirActive.data),
);

// hidden: gone from both surfaces
await rest(`trader_profiles?id=eq.${keishaTraderId}`, { method: "PATCH", body: JSON.stringify({ status: "hidden" }) });
const hiddenSearch = await rpc({ p_trade_id: 100, p_region_id: 10 });
const hiddenDir = await rest(`trader_directory?trader_id=eq.${keishaTraderId}&select=trader_id`, { anon: true });
check("hidden trader out of search", names(hiddenSearch).length === 1);
check("hidden trader out of directory view", hiddenDir.data?.length === 0);

// restore
await rest(`trader_profiles?id=eq.${keishaTraderId}`, { method: "PATCH", body: JSON.stringify({ status: "active" }) });

// pagination clamp
const clamped = await rpc({ p_limit: 5000 });
check("limit clamped to 100", clamped.status === 200 && clamped.data.length <= 100);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures ? 1 : 0);
