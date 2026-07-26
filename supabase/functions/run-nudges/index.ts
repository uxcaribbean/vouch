/**
 * run-nudges — the scheduled half of M8. Cron hits this (daily is fine; the
 * per-type cooldowns below do the real pacing) and it emits the two digest
 * pushes the spec defines:
 *
 *   sync_nudge              non-synced members: "Members near you have
 *                           vouched {n} traders this month …" — at most one
 *                           every 14 days, and never again after 3 dismissals
 *   contacts_joined_traders synced members: "{n} people in your contacts
 *                           joined as traders recently — vouch for them?"
 *                           — at most one a week
 *
 * Both go out through sendNotification as NON-transactional, so the 2/week
 * hard cap applies on top of the cooldowns here.
 *
 * verify_jwt is off (cron has no user session); the guard is the shared
 * secret in x-cron-secret. The hosted project MUST set CRON_SECRET — the
 * local fallback exists so the acceptance suite can drive this offline.
 */
import { json, preflight } from "../_shared/http.ts";
import { sendNotification } from "../_shared/notify.ts";
import { serviceClient } from "../_shared/supabase.ts";

const LOCAL_DEV_CRON_SECRET = "local-dev-cron-secret";
/** Belt and braces against a runaway job; one batch per run. */
const CANDIDATE_LIMIT = 500;
const SYNC_NUDGE_COOLDOWN_DAYS = 14;
const SYNC_NUDGE_MAX_DISMISSALS = 3;
const VOUCH_ACTIVITY_DAYS = 30;
const JOINED_TRADERS_COOLDOWN_DAYS = 7;
const JOINED_TRADERS_WINDOW_DAYS = 7;

const daysAgo = (days: number) =>
  new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return preflight();
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const secret = Deno.env.get("CRON_SECRET") ?? LOCAL_DEV_CRON_SECRET;
  if (req.headers.get("x-cron-secret") !== secret) {
    return json({ error: "unauthorized" }, 401);
  }

  const db = serviceClient();

  const sync_nudges = await runSyncNudges(db);
  const contacts_joined = await runContactsJoined(db);

  return json({ sync_nudges, contacts_joined });
});

/**
 * a. sync_nudge — the "you're missing the whole point of the app" nudge.
 * The number is real social proof: distinct traders vouched in the last 30
 * days, product-wide (spec M8 copy — the wording is pinned by the
 * acceptance suite, don't paraphrase it).
 */
async function runSyncNudges(db: ReturnType<typeof serviceClient>) {
  const { data: recentVouches } = await db
    .from("vouches")
    .select("trader_id")
    .eq("status", "published")
    .gte("created_at", daysAgo(VOUCH_ACTIVITY_DAYS));
  const tradersVouched = new Set(
    (recentVouches ?? []).map((v) => v.trader_id),
  ).size;

  const { data: candidates } = await db
    .from("users")
    .select("id")
    .eq("contact_sync_enabled", false)
    .is("deleted_at", null)
    .limit(CANDIDATE_LIMIT);

  let written = 0;
  for (const candidate of candidates ?? []) {
    // one nudge per fortnight — ANY log row counts, including the ones that
    // recorded a skip: a skipped decision was still a decision about them.
    const { count: recent } = await db
      .from("notification_log")
      .select("id", { count: "exact", head: true })
      .eq("user_id", candidate.id)
      .eq("type", "sync_nudge")
      .gte("created_at", daysAgo(SYNC_NUDGE_COOLDOWN_DAYS));
    if ((recent ?? 0) > 0) continue;

    // three dismissals = they've answered. No push, and no log row either:
    // they are out of this campaign entirely, not merely skipped this week.
    const { count: dismissals } = await db
      .from("events")
      .select("id", { count: "exact", head: true })
      .eq("user_id", candidate.id)
      .eq("name", "sync_nudge_dismissed");
    if ((dismissals ?? 0) >= SYNC_NUDGE_MAX_DISMISSALS) continue;

    await sendNotification(db, {
      userId: candidate.id,
      type: "sync_nudge",
      title: "See who your contacts vouch for",
      body:
        `Members near you have vouched ${tradersVouched} traders this month` +
        ` — sync contacts to see who *you* know.`,
      data: {},
    });
    written++;
  }
  return written;
}

/**
 * b. contacts_joined_traders — the reverse prompt as a push: people the
 * member actually knows have just joined as traders and have no vouch from
 * them yet. Mirrors the contacts_on_vouch() SQL (M4) but batched: the
 * trader side is fetched once, then intersected per candidate in memory.
 */
async function runContactsJoined(db: ReturnType<typeof serviceClient>) {
  const { data: newTraders } = await db
    .from("trader_profiles")
    .select("id, user_id")
    .in("status", ["active", "lapsed"])
    .eq("onboarding_complete", true)
    .gt("created_at", daysAgo(JOINED_TRADERS_WINDOW_DAYS));
  if (!newTraders?.length) return 0;

  const { data: owners } = await db
    .from("users")
    .select("id, phone_hash")
    .in("id", newTraders.map((t) => t.user_id))
    .is("deleted_at", null);

  // phone_hash -> traders reachable through that number
  const byHash = new Map<string, { id: string; user_id: string }[]>();
  for (const trader of newTraders) {
    const hash = owners?.find((o) => o.id === trader.user_id)?.phone_hash;
    if (!hash) continue;
    byHash.set(hash, [...(byHash.get(hash) ?? []), trader]);
  }
  if (byHash.size === 0) return 0;

  const { data: candidates } = await db
    .from("users")
    .select("id")
    .eq("contact_sync_enabled", true)
    .is("deleted_at", null)
    .limit(CANDIDATE_LIMIT);

  let written = 0;
  for (const candidate of candidates ?? []) {
    const { data: hashes } = await db
      .from("contact_hashes")
      .select("phone_hash")
      .eq("owner_user_id", candidate.id)
      .in("phone_hash", [...byHash.keys()]);
    if (!hashes?.length) continue;

    const { data: vouched } = await db
      .from("vouches")
      .select("trader_id")
      .eq("voucher_user_id", candidate.id)
      .eq("status", "published");
    const alreadyVouched = new Set((vouched ?? []).map((v) => v.trader_id));

    // never nudge someone to vouch for themselves, or for a trader they
    // already vouched for (mirrors contacts_on_vouch(), M4).
    const traderIds = new Set<string>();
    for (const { phone_hash } of hashes) {
      for (const trader of byHash.get(phone_hash) ?? []) {
        if (trader.user_id === candidate.id) continue;
        if (alreadyVouched.has(trader.id)) continue;
        traderIds.add(trader.id);
      }
    }
    if (traderIds.size === 0) continue;

    const { count: recent } = await db
      .from("notification_log")
      .select("id", { count: "exact", head: true })
      .eq("user_id", candidate.id)
      .eq("type", "contacts_joined_traders")
      .gte("created_at", daysAgo(JOINED_TRADERS_COOLDOWN_DAYS));
    if ((recent ?? 0) > 0) continue;

    const n = traderIds.size;
    await sendNotification(db, {
      userId: candidate.id,
      type: "contacts_joined_traders",
      title: "People you know joined as traders",
      body:
        `${n} ${n === 1 ? "person" : "people"} in your contacts joined as` +
        ` traders recently — vouch for them?`,
      data: { count: n },
    });
    written++;
  }
  return written;
}
