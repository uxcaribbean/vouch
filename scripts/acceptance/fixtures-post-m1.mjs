/** Creates the second demo member (James Testman) that later suites use.
 * Run after test-m1.mjs on a fresh database. */
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
const res = await fetch(`${API}/functions/v1/complete-profile`, {
  method: "POST",
  headers: {
    apikey: ANON,
    Authorization: `Bearer ${access_token}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ display_name: "James Testman", home_region_id: 10 }),
});
if (!res.ok && res.status !== 200) {
  console.error("fixture failed", res.status, await res.text());
  process.exit(1);
}
console.log("fixture: James Testman (+18685550004, Arima) ready");
