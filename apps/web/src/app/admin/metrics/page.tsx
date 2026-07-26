"use client";

/**
 * The north-star dashboard (spec M11). One rpc, four tiles, one Refresh
 * button.
 *
 * `admin_metrics()` computes everything from the append-only `events` log
 * rather than from mutable rows, so last month's number stays last month's
 * number even after a vouch is removed or a profile edited. The three
 * event-based blocks cover a rolling 30 days; trader activation is an
 * all-time cohort question and says so on the tile.
 *
 * Unlike admin_ring_report(), this rpc raises for non-admins instead of
 * returning nothing — an all-zero metrics object would read as real data.
 */
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import {
  BUTTON,
  CARD,
  Err,
  HELPER,
  SectionHeading,
} from "../ui";
import {
  formatRatio,
  parseMetrics,
  toTiles,
  type AdminMetrics,
  type Tile,
} from "./metrics";

export default function MetricsPage() {
  const [metrics, setMetrics] = useState<AdminMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error: rpcError } = await supabase.rpc("admin_metrics");
    setLoading(false);
    if (rpcError) {
      setError("Couldn't load the metrics. Try again in a moment.");
      return;
    }
    const parsed = parseMetrics(data);
    if (!parsed) {
      setError("The metrics response wasn't in the expected shape.");
      return;
    }
    setError(null);
    setMetrics(parsed);
    setRefreshedAt(new Date().toLocaleTimeString());
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex flex-col gap-6">
      <SectionHeading
        title="North-star metrics"
        hint="Rolling 30 days for searches, signups and vouch links. Trader activation is an all-time cohort."
      />

      <Err>{error}</Err>

      {loading && !metrics ? (
        <p className={HELPER}>Loading…</p>
      ) : metrics ? (
        <ul className="grid gap-4 sm:grid-cols-2">
          {toTiles(metrics).map((tile) => (
            <li key={tile.key}>
              <StatTile tile={tile} />
            </li>
          ))}
        </ul>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={loading}
          onClick={() => void load()}
          className={BUTTON}
        >
          {loading ? "Refreshing…" : "Refresh"}
        </button>
        {refreshedAt && <span className={HELPER}>Read at {refreshedAt}.</span>}
      </div>
    </div>
  );
}

function StatTile({ tile }: { tile: Tile }) {
  const target = tile.target;
  const met = target !== undefined && tile.ratio !== null && tile.ratio >= target;

  return (
    <article className={`${CARD} flex h-full flex-col gap-3`}>
      <h3 className="text-sm font-medium text-zinc-600 dark:text-zinc-400">
        {tile.title}
      </h3>

      <p className="text-4xl font-semibold tracking-tight tabular-nums">
        {formatRatio(tile.ratio)}
      </p>

      <p className="text-sm tabular-nums text-zinc-600 dark:text-zinc-400">
        <span className="font-medium text-black dark:text-zinc-50">
          {tile.numerator}
        </span>{" "}
        {tile.numeratorLabel} /{" "}
        <span className="font-medium text-black dark:text-zinc-50">
          {tile.denominator}
        </span>{" "}
        {tile.denominatorLabel}
      </p>

      {target !== undefined && (
        <p className="text-sm font-medium">
          North-star target ≈ {Math.round(target * 100)}%
          {tile.ratio === null
            ? " — no data yet."
            : met
              ? " — passing."
              : " — not there yet."}
        </p>
      )}

      <p className={`${HELPER} mt-auto leading-6`}>{tile.explanation}</p>
    </article>
  );
}
