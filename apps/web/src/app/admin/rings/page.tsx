"use client";

/**
 * Ring detection report (spec M9: "Basic ring detection report (read-only
 * SQL view, reviewed manually) ... No auto-punishment in MVP").
 *
 * The whole page is one call to `admin_ring_report()`, which flags traders
 * with three or more vouchers whose accounts are under 48h old and who have
 * never vouched for anyone else. That pattern is suspicious, not proof — a
 * trader who onboards their crew on a Saturday looks identical to a ring —
 * so the page reports and stops. Acting on a row means going to Lookup and
 * deciding as a human.
 */
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { BUTTON, Empty, Err, HELPER, SectionHeading } from "../ui";

type RingRow = {
  trader_id: string;
  trader_name: string;
  new_voucher_count: number;
};

export default function RingsPage() {
  const [rows, setRows] = useState<RingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error: rpcError } = await supabase.rpc("admin_ring_report");
    setLoading(false);
    if (rpcError) {
      setError("Couldn't load the report. Try again in a moment.");
      return;
    }
    setError(null);
    setRows(data ?? []);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex flex-col gap-6">
      <SectionHeading
        title="Ring report"
        count={loading ? undefined : rows.length}
        hint="Traders with 3+ vouchers whose accounts are under 48 hours old and who have vouched for nobody else."
      />

      <p className="rounded-lg border border-zinc-300 px-4 py-3 text-sm dark:border-zinc-700">
        Manual review only — no auto-punishment (MVP).
      </p>

      <Err>{error}</Err>

      {loading ? (
        <p className={HELPER}>Loading…</p>
      ) : rows.length === 0 ? (
        <Empty>No clusters worth a look.</Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-base">
            <thead>
              <tr className="border-b border-zinc-200 dark:border-zinc-800">
                <th scope="col" className="py-2 pr-4 font-medium">
                  Trader
                </th>
                <th scope="col" className="py-2 font-medium">
                  New vouchers
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.trader_id}
                  className="border-b border-zinc-100 dark:border-zinc-900"
                >
                  <td className="py-2 pr-4">{row.trader_name}</td>
                  <td className="py-2 tabular-nums">{row.new_voucher_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div>
        <button type="button" onClick={() => void load()} className={BUTTON}>
          Refresh
        </button>
      </div>
    </div>
  );
}
