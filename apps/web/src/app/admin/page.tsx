"use client";

/**
 * The flag queue — the admin dashboard's front door (spec M9 "Flag queue:
 * view subject, actions, resolution note; audit-logged").
 *
 * Reads `flags` directly under RLS (admins see every row; the write paths
 * are all edge functions), then decorates each one with a preview of what
 * was actually reported — a name and a comment beat a uuid when you're
 * deciding whether to hide somebody's livelihood.
 *
 * Two decisions worth knowing:
 *  - Resolving a flag and acting on its subject are separate buttons on
 *    purpose. "Hide trader" is not "this report is handled", and an admin
 *    who hides a trader still has to say what they concluded.
 *  - The subject preview comes from the same public surfaces everyone else
 *    reads (trader_directory, published vouches, public_profiles). Once a
 *    trader is hidden or a vouch removed, its preview goes quiet — that is
 *    the truth of what the public can now see, so it is shown as such.
 */
import { useCallback, useEffect, useState } from "react";
import type { Tables } from "@vouch/shared";
import { supabase } from "@/lib/supabase";
import { optionalNote, runAdminAction, type AdminActionBody } from "./actions";
import { AuditStrip } from "./audit-strip";
import {
  BUTTON,
  Badge,
  CARD,
  ConfirmButton,
  DANGER,
  Empty,
  Err,
  FIELD,
  GHOST,
  HELPER,
  SectionHeading,
  humanize,
  timeAgo,
} from "./ui";

const RECENT_LIMIT = 10;

type FlagRow = Tables<"flags">;

type Preview =
  | { kind: "trader"; name: string; status: string; trades: string[] }
  | { kind: "vouch"; comment: string | null; voucherName: string }
  | { kind: "user"; name: string }
  | { kind: "missing" };

type Queue = {
  open: FlagRow[];
  recent: FlagRow[];
  names: Record<string, string>;
  previews: Record<string, Preview>;
};

const EMPTY_QUEUE: Queue = { open: [], recent: [], names: {}, previews: {} };

/** What the third button does, per subject type (spec M9 flag-queue verbs). */
const CONTEXT_ACTION: Record<string, string> = {
  vouch: "Remove vouch (quiet)",
  trader: "Hide trader",
  user: "Suspend user",
};

type Panel = { flagId: string; kind: "resolve" | "dismiss" | "context" };

export default function FlagsPage() {
  const [queue, setQueue] = useState<Queue>(EMPTY_QUEUE);
  const [loading, setLoading] = useState(true);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [auditToken, setAuditToken] = useState(0);

  const load = useCallback(async () => {
    const [openResult, recentResult] = await Promise.all([
      supabase
        .from("flags")
        .select("*")
        .eq("status", "open")
        .order("created_at", { ascending: true }),
      supabase
        .from("flags")
        .select("*")
        .neq("status", "open")
        .order("updated_at", { ascending: false })
        .limit(RECENT_LIMIT),
    ]);
    const open = openResult.data ?? [];
    const recent = recentResult.data ?? [];
    const flags = [...open, ...recent];

    const subjectIds = (type: string) => [
      ...new Set(
        flags.filter((f) => f.subject_type === type).map((f) => f.subject_id),
      ),
    ];
    const traderIds = subjectIds("trader");
    const vouchIds = subjectIds("vouch");
    const userIds = subjectIds("user");

    const [traders, junctions, trades, vouches] = await Promise.all([
      supabase
        .from("trader_directory")
        .select("trader_id, display_name, business_name, status")
        .in("trader_id", traderIds),
      supabase
        .from("trader_trades")
        .select("trader_id, trade_id")
        .in("trader_id", traderIds),
      supabase.from("trades").select("id, name"),
      supabase
        .from("vouches")
        .select("id, comment, voucher_user_id")
        .in("id", vouchIds),
    ]);

    // Reporters, resolvers, flagged members and the vouchers behind flagged
    // vouches all resolve to names from the same public view.
    const profileIds = [
      ...new Set([
        ...flags.map((f) => f.reporter_user_id),
        ...flags
          .map((f) => f.resolved_by)
          .filter((id): id is string => id !== null),
        ...userIds,
        ...(vouches.data ?? []).map((v) => v.voucher_user_id),
      ]),
    ];
    const { data: profiles } = await supabase
      .from("public_profiles")
      .select("id, display_name")
      .in("id", profileIds);

    const names: Record<string, string> = Object.fromEntries(
      (profiles ?? []).map((p) => [p.id ?? "", p.display_name ?? "Unknown"]),
    );
    const tradeNames: Record<number, string> = Object.fromEntries(
      (trades.data ?? []).map((t) => [t.id, t.name]),
    );
    const tradesByTrader: Record<string, string[]> = {};
    for (const row of junctions.data ?? []) {
      const list = tradesByTrader[row.trader_id] ?? [];
      const name = tradeNames[row.trade_id];
      if (name) list.push(name);
      tradesByTrader[row.trader_id] = list;
    }

    const previews: Record<string, Preview> = {};
    for (const flag of flags) {
      if (flag.subject_type === "trader") {
        const trader = (traders.data ?? []).find(
          (t) => t.trader_id === flag.subject_id,
        );
        previews[flag.id] = trader
          ? {
              kind: "trader",
              name:
                trader.business_name ?? trader.display_name ?? "Unnamed trader",
              status: trader.status ?? "unknown",
              trades: tradesByTrader[flag.subject_id] ?? [],
            }
          : { kind: "missing" };
        continue;
      }
      if (flag.subject_type === "vouch") {
        const vouch = (vouches.data ?? []).find((v) => v.id === flag.subject_id);
        previews[flag.id] = vouch
          ? {
              kind: "vouch",
              comment: vouch.comment,
              voucherName: names[vouch.voucher_user_id] ?? "Unknown",
            }
          : { kind: "missing" };
        continue;
      }
      const name = names[flag.subject_id];
      previews[flag.id] = name ? { kind: "user", name } : { kind: "missing" };
    }

    setQueue({ open, recent, names, previews });
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function openPanel(flagId: string, kind: Panel["kind"]) {
    setPanel({ flagId, kind });
    setNote("");
    setError(null);
  }

  async function submit(flag: FlagRow, kind: Panel["kind"]) {
    const trimmed = optionalNote(note);
    let body: AdminActionBody;
    if (kind === "resolve") {
      body = { action: "resolve_flag", flag_id: flag.id, resolution_note: trimmed };
    } else if (kind === "dismiss") {
      body = { action: "dismiss_flag", flag_id: flag.id, resolution_note: trimmed };
    } else if (flag.subject_type === "vouch") {
      body = { action: "remove_vouch", vouch_id: flag.subject_id, note: trimmed };
    } else if (flag.subject_type === "trader") {
      body = { action: "hide_trader", trader_id: flag.subject_id, note: trimmed };
    } else {
      body = { action: "suspend_user", user_id: flag.subject_id, note: trimmed };
    }

    setBusy(true);
    setError(null);
    const message = await runAdminAction(body);
    setBusy(false);
    if (message) {
      setError(message);
      return;
    }
    setPanel(null);
    setNote("");
    setAuditToken((n) => n + 1);
    await load();
  }

  return (
    <div className="flex flex-col gap-10">
      <SectionHeading
        title="Open reports"
        count={loading ? undefined : queue.open.length}
        hint="Oldest first. Reports are for factual problems — a vouch can't be reported for disagreement."
      />

      {loading ? (
        <p className={HELPER}>Loading…</p>
      ) : queue.open.length === 0 ? (
        <Empty>Nothing to review. The queue is clear.</Empty>
      ) : (
        <ul className="flex flex-col gap-4">
          {queue.open.map((flag) => (
            <li key={flag.id}>
              <article className={`${CARD} flex flex-col gap-4`}>
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <h3 className="text-base font-semibold">
                    {humanize(flag.reason)}
                  </h3>
                  <div className="flex items-center gap-2">
                    <Badge>{flag.subject_type}</Badge>
                    <span className={HELPER}>{timeAgo(flag.created_at)}</span>
                  </div>
                </div>

                {flag.detail && (
                  <p className="text-base leading-6">
                    &ldquo;{flag.detail}&rdquo;
                  </p>
                )}

                <p className={HELPER}>
                  Reported by {queue.names[flag.reporter_user_id] ?? "Unknown"}
                </p>

                <SubjectPreview preview={queue.previews[flag.id]} />

                {panel?.flagId === flag.id ? (
                  <ActionPanel
                    kind={panel.kind}
                    subjectType={flag.subject_type}
                    note={note}
                    onNote={setNote}
                    busy={busy}
                    error={error}
                    onCancel={() => {
                      setPanel(null);
                      setError(null);
                    }}
                    onConfirm={() => void submit(flag, panel.kind)}
                  />
                ) : (
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      className={BUTTON}
                      onClick={() => openPanel(flag.id, "resolve")}
                    >
                      Resolve
                    </button>
                    <button
                      type="button"
                      className={GHOST}
                      onClick={() => openPanel(flag.id, "dismiss")}
                    >
                      Dismiss
                    </button>
                    {CONTEXT_ACTION[flag.subject_type] && (
                      <button
                        type="button"
                        className={DANGER}
                        onClick={() => openPanel(flag.id, "context")}
                      >
                        {CONTEXT_ACTION[flag.subject_type]}
                      </button>
                    )}
                  </div>
                )}
              </article>
            </li>
          ))}
        </ul>
      )}

      <section className="flex flex-col gap-4">
        <SectionHeading
          title="Recently closed"
          hint={`The last ${RECENT_LIMIT} reports that were resolved or dismissed.`}
        />
        {queue.recent.length === 0 ? (
          <Empty>Nothing closed yet.</Empty>
        ) : (
          <ul className="flex flex-col gap-2">
            {queue.recent.map((flag) => (
              <li
                key={flag.id}
                className="flex flex-col gap-1 rounded-lg border border-zinc-200 px-4 py-3 dark:border-zinc-800"
              >
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <Badge>{flag.status}</Badge>
                  <span className="text-base font-medium">
                    {humanize(flag.reason)}
                  </span>
                  <span className={HELPER}>on a {flag.subject_type}</span>
                  <span className={`${HELPER} ml-auto`}>
                    {timeAgo(flag.updated_at)}
                  </span>
                </div>
                <p className={HELPER}>
                  {flag.resolved_by
                    ? `Closed by ${queue.names[flag.resolved_by] ?? "Unknown"}`
                    : "Closed"}
                  {flag.resolution_note ? ` — “${flag.resolution_note}”` : ""}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <AuditStrip refreshToken={auditToken} />
    </div>
  );
}

function SubjectPreview({ preview }: { preview: Preview | undefined }) {
  if (!preview || preview.kind === "missing") {
    return (
      <p className={`${HELPER} rounded-lg bg-zinc-100 px-4 py-3 dark:bg-zinc-900`}>
        Subject isn&rsquo;t publicly visible — already hidden, removed, or
        deleted.
      </p>
    );
  }

  if (preview.kind === "trader") {
    return (
      <div className="flex flex-col gap-1 rounded-lg bg-zinc-100 px-4 py-3 dark:bg-zinc-900">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="text-base font-medium">{preview.name}</span>
          <Badge>{preview.status}</Badge>
        </div>
        <span className={HELPER}>
          {preview.trades.length > 0
            ? preview.trades.join(" · ")
            : "No trades listed"}
        </span>
      </div>
    );
  }

  if (preview.kind === "vouch") {
    return (
      <div className="flex flex-col gap-1 rounded-lg bg-zinc-100 px-4 py-3 dark:bg-zinc-900">
        <span className="text-base leading-6">
          {preview.comment ? `“${preview.comment}”` : "No comment"}
        </span>
        <span className={HELPER}>Vouched by {preview.voucherName}</span>
      </div>
    );
  }

  return (
    <div className="rounded-lg bg-zinc-100 px-4 py-3 dark:bg-zinc-900">
      <span className="text-base font-medium">{preview.name}</span>
    </div>
  );
}

function ActionPanel({
  kind,
  subjectType,
  note,
  onNote,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  kind: Panel["kind"];
  subjectType: string;
  note: string;
  onNote: (value: string) => void;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const destructive = kind === "context";
  const label =
    kind === "resolve"
      ? "Confirm resolve"
      : kind === "dismiss"
        ? "Confirm dismiss"
        : (CONTEXT_ACTION[subjectType] ?? "Confirm");

  return (
    <form
      className="flex flex-col gap-3 rounded-lg border border-zinc-300 p-4 dark:border-zinc-700"
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy && !destructive) onConfirm();
      }}
    >
      <label className="text-sm font-medium">
        {destructive
          ? "Note for the audit log (optional)"
          : "Resolution note (optional)"}
      </label>
      <input
        type="text"
        autoFocus
        maxLength={1000}
        value={note}
        onChange={(event) => onNote(event.target.value)}
        placeholder={
          destructive ? "What you found" : "What you did about it"
        }
        className={FIELD}
      />
      {destructive && (
        <p className={HELPER}>
          {subjectType === "vouch"
            ? "Quiet removal — nobody is notified, and the count drops."
            : subjectType === "trader"
              ? "The profile leaves search and every public list."
              : "They keep their account but can't vouch, invite or sync."}
        </p>
      )}
      <Err>{error}</Err>
      <div className="flex flex-wrap gap-2">
        {destructive ? (
          // Unmounted with the panel, so the two-tap arming never persists.
          <ConfirmButton
            label={busy ? "Working…" : label}
            disabled={busy}
            onConfirm={onConfirm}
          />
        ) : (
          <button type="submit" disabled={busy} className={BUTTON}>
            {busy ? "Working…" : label}
          </button>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={onCancel}
          className={GHOST}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
