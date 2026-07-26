"use client";

/**
 * The audit strip that closes the flags page (spec M9 acceptance: "every
 * admin action writes an audit row" — so show the admin that it did).
 *
 * Read straight from `audit_log` under RLS: the table is granted to
 * `authenticated` but its policy is `is_admin()`, so a non-admin session
 * gets zero rows rather than an error. `refreshToken` is bumped by the page
 * after every action so the newest row appears without a manual reload.
 */
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import type { Tables } from "@vouch/shared";
import { HELPER, humanize, shortId, timeAgo } from "./ui";

const RECENT = 10;

type AuditRow = Tables<"audit_log">;

/** Trades are int-keyed, so their id rides in meta rather than subject_id. */
function subjectLabel(row: AuditRow): string {
  const meta = (row.meta ?? {}) as Record<string, unknown>;
  if (row.subject_type === "trade") {
    const from = meta.from_trade_id;
    const into = meta.into_trade_id;
    if (typeof from === "number" && typeof into === "number") {
      return `trade #${from} → #${into}`;
    }
    return typeof meta.trade_id === "number"
      ? `trade #${meta.trade_id}`
      : "trade";
  }
  if (!row.subject_type) return "—";
  return `${row.subject_type} ${shortId(row.subject_id)}`;
}

export function AuditStrip({ refreshToken }: { refreshToken: number }) {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    const { data } = await supabase
      .from("audit_log")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(RECENT);
    const audit = data ?? [];
    setRows(audit);

    const adminIds = [...new Set(audit.map((row) => row.admin_user_id))];
    if (adminIds.length === 0) {
      setNames({});
      return;
    }
    const { data: profiles } = await supabase
      .from("public_profiles")
      .select("id, display_name")
      .in("id", adminIds);
    setNames(
      Object.fromEntries(
        (profiles ?? []).map((p) => [p.id ?? "", p.display_name ?? "Unknown"]),
      ),
    );
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshToken]);

  return (
    <section className="flex flex-col gap-3 border-t border-zinc-200 pt-6 dark:border-zinc-800">
      <h2 className="text-sm font-semibold tracking-tight">
        Recent admin actions
      </h2>
      {rows.length === 0 ? (
        <p className={HELPER}>Nothing audited yet.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {rows.map((row) => (
            <li
              key={row.id}
              className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm text-zinc-600 dark:text-zinc-400"
            >
              <span className="font-medium text-black dark:text-zinc-50">
                {humanize(row.action)}
              </span>
              <span className="font-mono text-xs">{subjectLabel(row)}</span>
              <span>· {names[row.admin_user_id] ?? "Unknown"}</span>
              <span>· {timeAgo(row.created_at)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
