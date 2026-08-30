/**
 * run-billing-lifecycle — the provider-independent core of M10. No payment
 * provider is wired up yet (spec §7: WiPay/PowerTranz/Stripe is a founder
 * decision); this job is the state machine the eventual webhook will drive,
 * pinned by scripts/acceptance/test-m10.mjs:
 *
 *   LAPSE       active trader, no access left           -> status 'lapsed'
 *   WARN        active trader, free-period access only,
 *               T-30/T-7/T-1 days                       -> push (deduped)
 *   REACTIVATE  lapsed trader, access restored           -> status 'active'
 *
 * "Access" is `trader_profiles.free_until >= today` OR a subscriptions row
 * with status in ('active','cancelled') whose current_period_end is still
 * in the future — cancelling stops renewal but honors the period already
 * paid for (trial -> paid -> cancelled -> lapsed, spec M10 acceptance).
 *
 * Cron-guarded exactly like run-nudges: verify_jwt is off (no user session
 * exists), and the guard is the shared secret in x-cron-secret. The hosted
 * project MUST set CRON_SECRET; the local fallback exists so the
 * acceptance suite can drive this offline.
 *
 * Never touches 'hidden'/'suspended' traders — those are admin-only states
 * (M9) and out of scope for billing entirely.
 */
import { sendNotification } from "../_shared/notify.ts";
import { json, preflight } from "../_shared/http.ts";
import { serviceClient } from "../_shared/supabase.ts";

const LOCAL_DEV_CRON_SECRET = "local-dev-cron-secret";
const WARN_THRESHOLDS = [30, 7, 1];

type Db = ReturnType<typeof serviceClient>;
type TraderRow = { id: string; user_id: string; status: string; free_until: string };
type SubRow = { user_id: string; status: string; current_period_end: string };

/** UTC whole-day difference between two 'YYYY-MM-DD' strings (b - a). */
function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  const msA = Date.UTC(ay, am - 1, ad);
  const msB = Date.UTC(by, bm - 1, bd);
  return Math.round((msB - msA) / 86_400_000);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return preflight();
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const secret = Deno.env.get("CRON_SECRET") ?? LOCAL_DEV_CRON_SECRET;
  if (req.headers.get("x-cron-secret") !== secret) {
    return json({ error: "unauthorized" }, 401);
  }

  const db = serviceClient();
  const today = new Date().toISOString().slice(0, 10);

  // -- a: candidates — active/lapsed traders with a live (non-deleted) owner.
  const { data: traderRows } = await db
    .from("trader_profiles")
    .select("id, user_id, status, free_until")
    .in("status", ["active", "lapsed"]);
  const candidates: TraderRow[] = traderRows ?? [];
  if (!candidates.length) {
    return json({ lapsed: 0, warned: 0, reactivated: 0 });
  }

  const ownerIds = [...new Set(candidates.map((t) => t.user_id))];
  const { data: owners } = await db
    .from("users")
    .select("id")
    .in("id", ownerIds)
    .is("deleted_at", null);
  const liveOwnerIds = new Set((owners ?? []).map((o) => o.id));
  const live = candidates.filter((t) => liveOwnerIds.has(t.user_id));

  // -- b: subscriptions for those owners, fetched once.
  const { data: subRows } = await db
    .from("subscriptions")
    .select("user_id, status, current_period_end")
    .in("user_id", ownerIds);
  const subsByUser = new Map<string, SubRow[]>();
  for (const s of (subRows as SubRow[] | null) ?? []) {
    subsByUser.set(s.user_id, [...(subsByUser.get(s.user_id) ?? []), s]);
  }

  const now = Date.now();
  const hasSubAccess = (userId: string) =>
    (subsByUser.get(userId) ?? []).some(
      (s) =>
        (s.status === "active" || s.status === "cancelled") &&
        new Date(s.current_period_end).getTime() > now,
    );
  // ISO date strings compare lexicographically the same as chronologically.
  const hasFreeAccess = (trader: TraderRow) => trader.free_until >= today;
  const hasAccess = (trader: TraderRow) =>
    hasFreeAccess(trader) || hasSubAccess(trader.user_id);

  let lapsed = 0;
  let warned = 0;
  let reactivated = 0;

  for (const trader of live) {
    if (trader.status === "active" && !hasAccess(trader)) {
      // -- d: LAPSE --------------------------------------------------------
      const { error } = await db
        .from("trader_profiles")
        .update({ status: "lapsed" })
        .eq("id", trader.id);
      if (error) {
        console.error("lapse update failed", error);
        continue;
      }
      await db.from("events").insert({
        user_id: trader.user_id,
        name: "trader_lapsed",
        props: { trader_id: trader.id },
      });
      await sendNotification(db, {
        userId: trader.user_id,
        type: "billing",
        transactional: true,
        title: "Your free period has ended",
        body:
          "Your listing is now inactive — it comes back the moment you " +
          "have credit or a subscription. Billing options are coming soon.",
        data: { kind: "lapsed", for_date: trader.free_until },
      });
      lapsed++;
    } else if (
      trader.status === "active" &&
      hasFreeAccess(trader) &&
      !hasSubAccess(trader.user_id)
    ) {
      // -- e: WARN — free-period access only, T-30/T-7/T-1. Traders with
      // subscription access get no free-period warnings at all.
      const daysLeft = daysBetween(today, trader.free_until);
      if (!WARN_THRESHOLDS.includes(daysLeft)) continue;

      // Dedupe on (threshold, for_date) — ANY prior log row for this user
      // counts, including a skipped one: a skipped decision was still a
      // decision, and free_until moving re-arms the key naturally.
      const { data: existing } = await db
        .from("notification_log")
        .select("id")
        .eq("user_id", trader.user_id)
        .eq("type", "billing")
        .eq("data->>threshold", String(daysLeft))
        .eq("data->>for_date", trader.free_until)
        .limit(1)
        .maybeSingle();
      if (existing) continue;

      await sendNotification(db, {
        userId: trader.user_id,
        type: "billing",
        transactional: true,
        title: "Your free period ends soon",
        body:
          `Your free time ends on ${trader.free_until} — ${daysLeft} ` +
          `day${daysLeft === 1 ? "" : "s"} away. Billing options are coming soon.`,
        data: { threshold: daysLeft, for_date: trader.free_until },
      });
      warned++;
    } else if (trader.status === "lapsed" && hasAccess(trader)) {
      // -- f: REACTIVATE — closes the loop where adjust_credit (M9) or a
      // subscription extends access but nothing un-lapses the trader.
      const { error } = await db
        .from("trader_profiles")
        .update({ status: "active" })
        .eq("id", trader.id);
      if (error) {
        console.error("reactivate update failed", error);
        continue;
      }
      await db.from("events").insert({
        user_id: trader.user_id,
        name: "trader_reactivated",
        props: { trader_id: trader.id },
      });
      reactivated++;
    }
  }

  // -- g
  return json({ lapsed, warned, reactivated });
});
