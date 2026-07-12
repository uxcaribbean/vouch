/** Gives James Testman the trader listing test-m3.mjs expects
 * (plumber + one proposed trade, Arima only). Run after test-m2.mjs. */
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

await auth("otp", { phone: "+18685550004" });
const { access_token } = await auth("verify", {
  phone: "+18685550004",
  token: "123456",
  type: "sms",
});
const res = await fetch(`${API}/functions/v1/upsert-trader-profile`, {
  method: "POST",
  headers: {
    apikey: ANON,
    Authorization: `Bearer ${access_token}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    trade_ids: [100],
    proposed_trades: ["bassoon tuning"],
    region_ids: [10],
  }),
});
if (!res.ok) {
  console.error("fixture failed", res.status, await res.text());
  process.exit(1);
}
console.log("fixture: James Testman is a plumber in Arima");
