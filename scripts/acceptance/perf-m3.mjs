/** M3 perf: search_traders P95 through PostgREST, anon role, 10k traders. */
const API = "http://127.0.0.1:54321";
const ANON =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";

const trades = [100, 101, 108, 200, 302, 400, 500, 600, null];
const regions = [17, 13, 19, 23, 1, null];

const timings = [];
let rows = 0;
for (let i = 0; i < 90; i++) {
  const body = {
    p_trade_id: trades[i % trades.length],
    p_region_id: regions[i % regions.length],
  };
  const start = performance.now();
  const res = await fetch(`${API}/rest/v1/rpc/search_traders`, {
    method: "POST",
    headers: {
      apikey: ANON,
      Authorization: `Bearer ${ANON}`,
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
  rows += data.length;
}
timings.sort((a, b) => a - b);
const pick = (q) => timings[Math.min(timings.length - 1, Math.floor(q * timings.length))].toFixed(1);
console.log(`n=${timings.length} avg_rows=${(rows / timings.length).toFixed(1)}`);
console.log(`p50=${pick(0.5)}ms p95=${pick(0.95)}ms max=${timings[timings.length - 1].toFixed(1)}ms`);
console.log(Number(pick(0.95)) < 500 ? "P95 TARGET MET" : "P95 TARGET MISSED");
