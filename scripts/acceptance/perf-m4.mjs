/** M4 perf: authed search_traders P95 with friend-matching active.
 * Spec §6 budget: P95 < 500ms @ 10k traders / 1M contact hashes.
 * Prereq: perf-seed.sql then perf-seed-m4.sql applied.
 */
const API = "http://127.0.0.1:54321";
const ANON =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";

async function auth(path, body) {
  const res = await fetch(`${API}/auth/v1/${path}`, {
    method: "POST",
    headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}
await auth("otp", { phone: "+18685550005" });
const { access_token } = await auth("verify", {
  phone: "+18685550005",
  token: "123456",
  type: "sms",
});
if (!access_token) {
  console.error("viewer login failed");
  process.exit(1);
}

const trades = [100, 101, 108, 200, 302, null];
const regions = [17, 13, 1, null];
const variants = [{}, { p_friends_only: true }];

const timings = [];
let friendRows = 0;
for (let i = 0; i < 90; i++) {
  const body = {
    p_trade_id: trades[i % trades.length],
    p_region_id: regions[i % regions.length],
    ...variants[i % variants.length],
  };
  const start = performance.now();
  const res = await fetch(`${API}/rest/v1/rpc/search_traders`, {
    method: "POST",
    headers: {
      apikey: ANON,
      Authorization: `Bearer ${access_token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  timings.push(performance.now() - start);
  if (!res.ok) {
    console.error("FAIL", res.status, JSON.stringify(data).slice(0, 200));
    process.exit(1);
  }
  friendRows += data.filter((r) => r.friend_vouch_count > 0).length;
}
timings.sort((a, b) => a - b);
const pick = (q) =>
  timings[Math.min(timings.length - 1, Math.floor(q * timings.length))].toFixed(1);
console.log(`n=${timings.length} friend_hits_total=${friendRows}`);
console.log(`p50=${pick(0.5)}ms p95=${pick(0.95)}ms max=${timings[timings.length - 1].toFixed(1)}ms`);
if (friendRows === 0) {
  console.error("SEED PROBLEM: no friend matches surfaced — measurement is not exercising the join");
  process.exit(1);
}
console.log(Number(pick(0.95)) < 500 ? "P95 TARGET MET" : "P95 TARGET MISSED");
process.exit(Number(pick(0.95)) < 500 ? 0 : 1);
