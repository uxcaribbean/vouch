"use client";

/**
 * Taxonomy curation (spec M9 "proposed trades list → approve / rename /
 * merge-into"). Traders can propose a trade when the wizard doesn't list
 * theirs; this page is where those proposals become real taxonomy or get
 * folded into the trade that already covers them.
 *
 * The whole trades table is fetched in one go — it is a curated list of
 * dozens, not a growing dataset — and the three views (proposed, active
 * merge targets, recently merged) are derived from it. `trades` is public
 * read, so no admin-only query is involved; the writes are admin-action.
 *
 * Merging is two-tap because it is irreversible in practice: it re-points
 * every trader_trades and vouches row and drops the ones that would
 * collide.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { optionalNote, runAdminAction } from "../actions";
import {
  BUTTON,
  Badge,
  CARD,
  ConfirmButton,
  Empty,
  Err,
  FIELD,
  GHOST,
  HELPER,
  SOFT,
  SectionHeading,
  formatDate,
} from "../ui";
import { invokeFunction, supabase } from "@/lib/supabase";

const MERGED_LIMIT = 10;
const MAX_TARGET_OPTIONS = 40;
/** How many proposals get an automatic "does this already exist?" check. */
const MAX_SUGGESTIONS = 20;

type Trade = {
  id: number;
  name: string;
  slug: string;
  status: string;
  created_at: string;
  updated_at: string;
  merged_into_id: number | null;
};

type TradeRef = { id: number; slug: string; name: string; probability: number };

/** suggest-trade's answer (see supabase/functions/suggest-trade). */
type SuggestResponse = {
  outcome: "existing" | "new" | "unavailable";
  source: string;
  trade: TradeRef | null;
  closest: TradeRef | null;
};

/**
 * What the row shows once the check comes back. A missing entry means the
 * check is still pending; "quiet" (unavailable, error, nothing close) shows
 * nothing at all — the admin curates exactly as before.
 */
type Suggestion =
  | { kind: "existing"; trade: TradeRef }
  | { kind: "closest"; trade: TradeRef }
  | { kind: "quiet" };

const percent = (probability: number) => Math.round(probability * 100);

function toSuggestion(answer: SuggestResponse | null): Suggestion {
  if (!answer) return { kind: "quiet" };
  if (answer.outcome === "existing" && answer.trade) {
    return { kind: "existing", trade: answer.trade };
  }
  if (answer.outcome === "new" && answer.closest) {
    return { kind: "closest", trade: answer.closest };
  }
  return { kind: "quiet" };
}

export default function TaxonomyPage() {
  const [trades, setTrades] = useState<Trade[]>([]);
  const [loading, setLoading] = useState(true);
  const [mergingId, setMergingId] = useState<number | null>(null);
  // Lifted out of MergePanel so "Use as merge target" can pre-select a trade
  // whether or not that row's picker is already open.
  const [mergeTarget, setMergeTarget] = useState<number | null>(null);
  const [suggestions, setSuggestions] = useState<Record<number, Suggestion>>({});
  // Proposals already sent for checking — a reload after approve/merge must
  // not re-ask (and re-bill) the model for the rows that are still here.
  const requested = useRef<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data } = await supabase
      .from("trades")
      .select("id, name, slug, status, created_at, updated_at, merged_into_id")
      .order("name", { ascending: true });
    setTrades(data ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const proposed = useMemo(
    () =>
      trades
        .filter((t) => t.status === "proposed")
        .sort((a, b) => a.created_at.localeCompare(b.created_at)),
    [trades],
  );
  const active = useMemo(
    () => trades.filter((t) => t.status === "active"),
    [trades],
  );
  const merged = useMemo(
    () =>
      trades
        .filter((t) => t.status === "merged")
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
        .slice(0, MERGED_LIMIT),
    [trades],
  );
  // Ask suggest-trade about each proposal (oldest first, capped), all in
  // parallel. No cancellation: results are keyed by trade id, so a late answer
  // for a row that has since gone is simply never rendered.
  useEffect(() => {
    const todo = proposed
      .slice(0, MAX_SUGGESTIONS)
      .filter((trade) => !requested.current.has(trade.id));
    for (const trade of todo) requested.current.add(trade.id);
    for (const trade of todo) {
      void invokeFunction<SuggestResponse>("suggest-trade", {
        service: trade.name,
      })
        .then(({ data }) => toSuggestion(data))
        .catch((): Suggestion => ({ kind: "quiet" }))
        .then((suggestion) =>
          setSuggestions((current) => ({ ...current, [trade.id]: suggestion })),
        );
    }
  }, [proposed]);
  const checking = useMemo(
    () => new Set(proposed.slice(0, MAX_SUGGESTIONS).map((t) => t.id)),
    [proposed],
  );
  const nameById = useMemo(
    () => Object.fromEntries(trades.map((t) => [t.id, t.name])),
    [trades],
  );

  async function approve(trade: Trade) {
    setBusy(true);
    setError(null);
    const message = await runAdminAction({
      action: "approve_trade",
      trade_id: trade.id,
    });
    setBusy(false);
    if (message) {
      setError(message);
      return;
    }
    await load();
  }

  async function merge(from: Trade, intoId: number, note: string) {
    setBusy(true);
    setError(null);
    const message = await runAdminAction({
      action: "merge_trade",
      from_trade_id: from.id,
      into_trade_id: intoId,
      note: optionalNote(note),
    });
    setBusy(false);
    if (message) {
      setError(message);
      return;
    }
    setMergingId(null);
    setMergeTarget(null);
    await load();
  }

  return (
    <div className="flex flex-col gap-10">
      <SectionHeading
        title="Proposed trades"
        count={loading ? undefined : proposed.length}
        hint="Approve what the taxonomy is missing; merge what it already covers under another name."
      />

      {loading ? (
        <p className={HELPER}>Loading…</p>
      ) : proposed.length === 0 ? (
        <Empty>No proposals waiting.</Empty>
      ) : (
        <ul className="flex flex-col gap-4">
          {proposed.map((trade) => (
            <li key={trade.id}>
              <article className={`${CARD} flex flex-col gap-4`}>
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <h3 className="text-base font-semibold">{trade.name}</h3>
                  <span className={HELPER}>
                    proposed {formatDate(trade.created_at)}
                  </span>
                </div>
                <p className={`${HELPER} font-mono`}>{trade.slug}</p>

                <SuggestionLine
                  suggestion={suggestions[trade.id]}
                  checking={checking.has(trade.id)}
                  disabled={busy}
                  onUse={(targetId) => {
                    setMergingId(trade.id);
                    setMergeTarget(targetId);
                    setError(null);
                  }}
                />

                {mergingId === trade.id ? (
                  <MergePanel
                    from={trade}
                    options={active}
                    target={mergeTarget}
                    onTarget={setMergeTarget}
                    busy={busy}
                    error={error}
                    onCancel={() => {
                      setMergingId(null);
                      setMergeTarget(null);
                      setError(null);
                    }}
                    onMerge={(intoId, note) => void merge(trade, intoId, note)}
                  />
                ) : (
                  <div className="flex flex-col gap-2">
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        disabled={busy}
                        className={BUTTON}
                        onClick={() => void approve(trade)}
                      >
                        Approve
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        className={GHOST}
                        onClick={() => {
                          setMergingId(trade.id);
                          setMergeTarget(null);
                          setError(null);
                        }}
                      >
                        Merge into…
                      </button>
                    </div>
                    {mergingId === null && <Err>{error}</Err>}
                  </div>
                )}
              </article>
            </li>
          ))}
        </ul>
      )}

      <section className="flex flex-col gap-4">
        <SectionHeading
          title="Recently merged"
          hint="Merged trades keep their row so old slugs can still point at the target."
        />
        {merged.length === 0 ? (
          <Empty>Nothing merged yet.</Empty>
        ) : (
          <ul className="flex flex-col gap-2">
            {merged.map((trade) => (
              <li
                key={trade.id}
                className="flex flex-wrap items-baseline gap-x-2 gap-y-1 rounded-lg border border-zinc-200 px-4 py-3 dark:border-zinc-800"
              >
                <Badge>merged</Badge>
                <span className="text-base font-medium">{trade.name}</span>
                <span className={HELPER}>
                  → {trade.merged_into_id
                    ? (nameById[trade.merged_into_id] ??
                      `#${trade.merged_into_id}`)
                    : "—"}
                </span>
                <span className={`${HELPER} ml-auto`}>
                  {formatDate(trade.updated_at)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/**
 * Searchable target picker. A plain <select> over 40-odd trades is fine on a
 * phone; the filter box exists for when the taxonomy grows past that.
 */
function MergePanel({
  from,
  options,
  target,
  onTarget,
  busy,
  error,
  onCancel,
  onMerge,
}: {
  from: Trade;
  options: Trade[];
  target: number | null;
  onTarget: (id: number | null) => void;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onMerge: (intoId: number, note: string) => void;
}) {
  const [filter, setFilter] = useState("");
  const [note, setNote] = useState("");
  // A suggestion can pre-select a target before the panel mounts; in that case
  // don't pop the keyboard onto the search box.
  const [startedWithTarget] = useState(target !== null);

  const matches = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const found = options
      .filter(
        (t) =>
          t.id !== from.id &&
          (needle === "" ||
            t.name.toLowerCase().includes(needle) ||
            t.slug.includes(needle)),
      )
      .slice(0, MAX_TARGET_OPTIONS);
    // The chosen target must always be an option, or the <select> would show
    // "Choose a trade…" while a merge is armed for something else.
    const chosen = options.find((t) => t.id === target);
    return chosen && !found.some((t) => t.id === chosen.id)
      ? [chosen, ...found]
      : found;
  }, [options, filter, from.id, target]);

  const targetName = options.find((t) => t.id === target)?.name;

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-zinc-300 p-4 dark:border-zinc-700">
      <label htmlFor={`filter-${from.id}`} className="text-sm font-medium">
        Merge &ldquo;{from.name}&rdquo; into
      </label>
      <input
        id={`filter-${from.id}`}
        type="search"
        autoFocus={!startedWithTarget}
        placeholder="Search active trades"
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
        className={FIELD}
      />
      <select
        aria-label="Merge target"
        value={target ?? ""}
        onChange={(event) =>
          onTarget(event.target.value ? Number(event.target.value) : null)
        }
        className={FIELD}
      >
        <option value="">Choose a trade…</option>
        {matches.map((trade) => (
          <option key={trade.id} value={trade.id}>
            {trade.name}
          </option>
        ))}
      </select>
      <input
        type="text"
        maxLength={1000}
        value={note}
        onChange={(event) => setNote(event.target.value)}
        placeholder="Note for the audit log (optional)"
        className={FIELD}
      />
      <p className={HELPER}>
        Every trader and vouch on &ldquo;{from.name}&rdquo; moves across.
        Duplicates are dropped. This can&rsquo;t be undone from here.
      </p>
      <Err>{error}</Err>
      <div className="flex flex-wrap gap-2">
        <ConfirmButton
          // Re-mounted per target so a change of target disarms the two-tap.
          key={target ?? "none"}
          label={
            busy
              ? "Merging…"
              : targetName
                ? `Merge into ${targetName}`
                : "Choose a target first"
          }
          disabled={busy || targetName === undefined}
          onConfirm={() => {
            if (target !== null) onMerge(target, note);
          }}
        />
        <button
          type="button"
          disabled={busy}
          onClick={onCancel}
          className={GHOST}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * The model's read on a proposal. Loud only when it is confident the trade
 * already exists (and then offers the one-tap shortcut into the merge picker);
 * a near-miss is a muted aside; anything else stays out of the way.
 */
function SuggestionLine({
  suggestion,
  checking,
  disabled,
  onUse,
}: {
  suggestion: Suggestion | undefined;
  checking: boolean;
  disabled: boolean;
  onUse: (targetId: number) => void;
}) {
  if (!suggestion) {
    return checking ? <p className={HELPER}>Checking…</p> : null;
  }
  if (suggestion.kind === "existing") {
    const { trade } = suggestion;
    return (
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-lg bg-zinc-100 px-4 py-3 dark:bg-zinc-900">
        <p className="text-base">
          Suggested: merge into {trade.name} ({percent(trade.probability)}%)
        </p>
        <button
          type="button"
          disabled={disabled}
          className={SOFT}
          onClick={() => onUse(trade.id)}
        >
          Use as merge target
        </button>
      </div>
    );
  }
  if (suggestion.kind === "closest") {
    const { trade } = suggestion;
    return (
      <p className={HELPER}>
        Probably new — closest is {trade.name} ({percent(trade.probability)}%)
      </p>
    );
  }
  return null;
}
