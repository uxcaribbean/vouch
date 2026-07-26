/**
 * Push delivery + the server-side rules that guard it (spec M8).
 *
 * Every caller goes through sendNotification, and every call writes EXACTLY
 * ONE notification_log row — that row is the observable the acceptance suite
 * reads (scripts/acceptance/test-m8.mjs), and the cap below counts its own
 * history, so a missing or duplicated row silently corrupts the next week's
 * decisions.
 *
 * Decision order (contractual):
 *   a. per-type toggle — an explicit `enabled = false` row  -> skipped_pref
 *   b. 2 non-transactional pushes/user/week                 -> skipped_cap
 *      (transactional types are exempt: a trader always hears about a new
 *      vouch, a referrer always hears about their free month)
 *   c. no registered device                                 -> no_token
 *   d. POST to Expo: ok -> sent, anything else -> error
 */
import { serviceClient } from "./supabase.ts";

type Db = ReturnType<typeof serviceClient>;

export type NotificationType =
  | "vouch_received"
  | "referral_credited"
  | "contacts_joined_traders"
  | "sync_nudge";

export type NotificationStatus =
  | "sent"
  | "no_token"
  | "error"
  | "skipped_pref"
  | "skipped_cap";

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const EXPO_TIMEOUT_MS = 5000;

/** Spec M8: hard cap of 2 pushes/user/week, transactional types excepted. */
const WEEKLY_CAP = 2;
const CAP_WINDOW_DAYS = 7;
const TRANSACTIONAL_TYPES: NotificationType[] = [
  "vouch_received",
  "referral_credited",
];

export interface SendNotificationArgs {
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  /** Transactional pushes bypass the weekly cap (never the toggle). */
  transactional?: boolean;
}

export async function sendNotification(
  db: Db,
  args: SendNotificationArgs,
): Promise<NotificationStatus> {
  const {
    userId,
    type,
    title,
    body,
    data = {},
    transactional = false,
  } = args;

  const record = async (status: NotificationStatus) => {
    const { error } = await db.from("notification_log").insert({
      user_id: userId,
      type,
      title,
      body,
      data,
      status,
    });
    if (error) console.error("notification_log insert failed", error);
    return status;
  };

  // -- a: the user's own toggle. Absent row = enabled (no backfill needed).
  const { data: pref } = await db
    .from("notification_prefs")
    .select("enabled")
    .eq("user_id", userId)
    .eq("type", type)
    .maybeSingle();
  if (pref && pref.enabled === false) return await record("skipped_pref");

  // -- b: the weekly cap. Counts only pushes that actually went out, and
  // only non-transactional ones — a week full of vouch notifications must
  // not silence the digests, and vice versa.
  if (!transactional) {
    const since = new Date(
      Date.now() - CAP_WINDOW_DAYS * 24 * 3600 * 1000,
    ).toISOString();
    const { count } = await db
      .from("notification_log")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("status", "sent")
      .not("type", "in", `(${TRANSACTIONAL_TYPES.join(",")})`)
      .gte("created_at", since);
    if ((count ?? 0) >= WEEKLY_CAP) return await record("skipped_cap");
  }

  // -- c: devices.
  const { data: tokens } = await db
    .from("push_tokens")
    .select("token")
    .eq("user_id", userId);
  if (!tokens?.length) return await record("no_token");

  // -- d: one request, one message per registered device. Expo accepts an
  // array body; a partial per-ticket failure still counts as sent (delivery
  // receipts are a hosted-only concern, not a decision this module makes).
  try {
    const res = await fetch(EXPO_PUSH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(
        tokens.map((t) => ({ to: t.token, title, body, data })),
      ),
      signal: AbortSignal.timeout(EXPO_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(
        "expo push rejected",
        res.status,
        await res.text().catch(() => ""),
      );
      return await record("error");
    }
    await res.json().catch(() => null);
    return await record("sent");
  } catch (err) {
    console.error("expo push failed", err);
    return await record("error");
  }
}
