"use client";

/**
 * Member lookup (spec M9 "User/trader lookup by phone or name; credit
 * adjustments"). This is the screen someone opens with a person on the
 * phone: type the number they're calling from, see who they are, fix their
 * free months or lift a suspension.
 *
 * All of it comes from the admin-lookup edge function, which decides
 * phone-vs-name itself (shared normalizePhone, so "868-555-0001",
 * "555-0001" and "+18685550001" all land on the same member) and returns an
 * explicit, hash-free column list — no phone_hash, no contact hashes, and
 * nothing from private_blocks, which stay invisible even to admins.
 */
import { useCallback, useEffect, useState } from "react";
import { invokeFunction, supabase } from "@/lib/supabase";
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
  SectionHeading,
  formatDate,
} from "../ui";

/** The admin-lookup response contract (supabase/functions/admin-lookup). */
type LookupUser = {
  id: string;
  display_name: string;
  phone_e164: string | null;
  role: string;
  home_region_id: number | null;
  contact_sync_enabled: boolean;
  referral_code: string;
  suspended_at: string | null;
  deleted_at: string | null;
  created_at: string;
};

type LookupResult = {
  user: LookupUser;
  trader: { id: string; status: string; free_until: string } | null;
  counts: { vouches_given: number; vouches_received: number };
};

type LookupResponse = { matched_by: "phone" | "name"; results: LookupResult[] };

export default function LookupPage() {
  const [query, setQuery] = useState("");
  const [lastQuery, setLastQuery] = useState<string | null>(null);
  const [response, setResponse] = useState<LookupResponse | null>(null);
  const [regions, setRegions] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const { data } = await supabase.from("regions").select("id, name");
      setRegions(Object.fromEntries((data ?? []).map((r) => [r.id, r.name])));
    })();
  }, []);

  const search = useCallback(async (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    const { data, errorCode } = await invokeFunction<LookupResponse>(
      "admin-lookup",
      { query: trimmed },
    );
    setBusy(false);
    if (errorCode || !data) {
      setError(
        errorCode === "not_admin"
          ? "This account no longer has admin access."
          : errorCode === "invalid_input"
            ? "Type a name or a phone number."
            : "Lookup failed. Try again in a moment.",
      );
      return;
    }
    setLastQuery(trimmed);
    setResponse(data);
  }, []);

  return (
    <div className="flex flex-col gap-8">
      <SectionHeading
        title="Lookup"
        hint="Search by phone number or part of a name. Ten results max."
      />

      <form
        className="flex flex-wrap gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void search(query);
        }}
      >
        <input
          type="search"
          autoFocus
          placeholder="868-555-0001 or Keisha"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className={`${FIELD} sm:max-w-sm`}
        />
        <button type="submit" disabled={busy} className={BUTTON}>
          {busy ? "Searching…" : "Search"}
        </button>
      </form>

      <Err>{error}</Err>

      {response && (
        <div className="flex flex-col gap-4">
          <p className={HELPER}>
            {response.results.length} result
            {response.results.length === 1 ? "" : "s"} matched by{" "}
            {response.matched_by}.
          </p>
          {response.results.length === 0 ? (
            <Empty>Nobody matches that.</Empty>
          ) : (
            <ul className="flex flex-col gap-4">
              {response.results.map((result) => (
                <li key={result.user.id}>
                  <MemberCard
                    result={result}
                    regionName={
                      result.user.home_region_id
                        ? (regions[result.user.home_region_id] ?? "—")
                        : "—"
                    }
                    onDone={() => {
                      if (lastQuery) void search(lastQuery);
                    }}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function MemberCard({
  result,
  regionName,
  onDone,
}: {
  result: LookupResult;
  regionName: string;
  onDone: () => void;
}) {
  const { user, trader, counts } = result;
  const [months, setMonths] = useState(1);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function adjustCredit() {
    if (months === 0) return;
    setBusy(true);
    setError(null);
    setDone(null);
    const message = await runAdminAction({
      action: "adjust_credit",
      user_id: user.id,
      months,
      note: optionalNote(note),
    });
    setBusy(false);
    if (message) {
      setError(message);
      return;
    }
    setDone(
      `${months > 0 ? "Added" : "Removed"} ${Math.abs(months)} month${
        Math.abs(months) === 1 ? "" : "s"
      }.`,
    );
    setNote("");
    onDone();
  }

  async function toggleSuspension() {
    setBusy(true);
    setError(null);
    setDone(null);
    const message = await runAdminAction(
      user.suspended_at
        ? { action: "unsuspend_user", user_id: user.id, note: optionalNote(note) }
        : { action: "suspend_user", user_id: user.id, note: optionalNote(note) },
    );
    setBusy(false);
    if (message) {
      setError(message);
      return;
    }
    setNote("");
    onDone();
  }

  return (
    <article className={`${CARD} flex flex-col gap-5`}>
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-baseline gap-2">
          <h3 className="text-lg font-semibold tracking-tight">
            {user.display_name}
          </h3>
          {user.suspended_at && <Badge tone="alert">suspended</Badge>}
          {user.deleted_at && <Badge tone="alert">deleted</Badge>}
          {user.role === "admin" && <Badge>admin</Badge>}
        </div>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
          <Stat label="Phone" value={user.phone_e164 ?? "—"} />
          <Stat label="Region" value={regionName} />
          <Stat label="Joined" value={formatDate(user.created_at)} />
          <Stat label="Referral code" value={user.referral_code} />
        </dl>
      </div>

      {trader ? (
        <div className="flex flex-col gap-2 rounded-lg bg-zinc-100 px-4 py-3 dark:bg-zinc-900">
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="text-base font-medium">Trader profile</span>
            <Badge>{trader.status}</Badge>
          </div>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
            <Stat label="Free until" value={formatDate(trader.free_until)} />
            <Stat label="Vouches received" value={counts.vouches_received} />
            <Stat label="Vouches given" value={counts.vouches_given} />
          </dl>
        </div>
      ) : (
        <p className={HELPER}>
          Not a trader — {counts.vouches_given} vouch
          {counts.vouches_given === 1 ? "" : "es"} given.
        </p>
      )}

      <div className="flex flex-col gap-3 border-t border-zinc-200 pt-4 dark:border-zinc-800">
        <span className="text-sm font-medium">Adjust free months</span>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            aria-label="One month less"
            disabled={busy}
            onClick={() => setMonths((m) => Math.max(-12, m - 1))}
            className={`${GHOST} w-11 px-0 text-lg`}
          >
            −
          </button>
          <span
            aria-live="polite"
            className="min-w-16 text-center text-lg font-medium tabular-nums"
          >
            {months > 0 ? `+${months}` : months}
          </span>
          <button
            type="button"
            aria-label="One month more"
            disabled={busy}
            onClick={() => setMonths((m) => Math.min(12, m + 1))}
            className={`${GHOST} w-11 px-0 text-lg`}
          >
            +
          </button>
          <input
            type="text"
            maxLength={1000}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Reason (optional)"
            className={`${FIELD} sm:max-w-xs`}
          />
          <button
            type="button"
            disabled={busy || months === 0}
            onClick={() => void adjustCredit()}
            className={BUTTON}
          >
            {busy ? "Working…" : "Apply credit"}
          </button>
        </div>
        <p className={HELPER}>
          Lands in the credit ledger as an admin adjustment. A trader&rsquo;s
          free_until moves with it; anyone else banks the months until they
          list.
        </p>

        <div className="flex flex-wrap items-center gap-2">
          <ConfirmButton
            label={
              busy
                ? "Working…"
                : user.suspended_at
                  ? "Lift suspension"
                  : "Suspend member"
            }
            disabled={busy}
            onConfirm={() => void toggleSuspension()}
            className={user.suspended_at ? GHOST : undefined}
          />
          <span className={HELPER}>
            {user.suspended_at
              ? `Suspended ${formatDate(user.suspended_at)}.`
              : "Suspension blocks vouching, invites and contact sync."}
          </span>
        </div>

        <Err>{error}</Err>
        {done && (
          <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
            {done}
          </p>
        )}
      </div>
    </article>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex flex-col">
      <dt className={HELPER}>{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}
