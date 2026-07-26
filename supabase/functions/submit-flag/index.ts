/**
 * submit-flag — spec M9.1. A member reports a factual problem with a trader
 * profile, a vouch, or another member. Reasons are a closed enum (fake
 * profile / impersonation / wrong number / spam / other); "I disagree with
 * this vouch" is deliberately not one of them — this is a positive-only
 * system, there is nothing negative to dispute.
 *
 * flags has no client INSERT policy, so this function is the only writer:
 * the reason enum, the subject-exists check and the rate limit cannot be
 * bypassed from a client.
 *
 * Logic order (contractual — see scripts/acceptance/test-m9.mjs):
 *   a. auth + body validation (unknown reason -> 400 invalid_input)
 *   b. caller must have a completed, non-deleted profile
 *   c. the subject must actually exist -> 404 subject_not_found
 *   d. rate limit: 10 flags/24h/caller -> 429
 *   e. insert, return 201 { flag }
 *   f. flag_submitted event
 */
import { z } from "zod";
import { json, preflight } from "../_shared/http.ts";
import { getAuthUser, serviceClient } from "../_shared/supabase.ts";

const MAX_DETAIL_LENGTH = 500;
const RATE_LIMIT_WINDOW_HOURS = 24;
const RATE_LIMIT_MAX = 10;

/** Which table each subject_type points at (all three are uuid-keyed). */
const SUBJECT_TABLES = {
  trader: "trader_profiles",
  vouch: "vouches",
  user: "users",
} as const;

const BodySchema = z.object({
  subject_type: z.enum(["trader", "vouch", "user"]),
  subject_id: z.string().uuid(),
  // mirrors the flags.reason CHECK constraint
  reason: z.enum([
    "fake_profile",
    "impersonation",
    "wrong_number",
    "spam",
    "other",
  ]),
  detail: z
    .string()
    .trim()
    .max(MAX_DETAIL_LENGTH)
    .optional()
    .transform((v) => (v ? v : null)),
});

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return preflight();
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const user = await getAuthUser(req);
  if (!user) return json({ error: "unauthorized" }, 401);

  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return json(
      { error: "invalid_input", details: parsed.error.flatten() },
      400,
    );
  }
  const { subject_type, subject_id, reason, detail } = parsed.data;

  const db = serviceClient();

  // -- b: caller must be a real, live member --------------------------------
  const { data: caller } = await db
    .from("users")
    .select("id, deleted_at")
    .eq("id", user.id)
    .maybeSingle();
  if (!caller || caller.deleted_at) {
    return json({ error: "profile_incomplete" }, 400);
  }

  // -- c: the subject must exist ---------------------------------------------
  const { data: subject } = await db
    .from(SUBJECT_TABLES[subject_type])
    .select("id")
    .eq("id", subject_id)
    .maybeSingle();
  if (!subject) {
    return json({ error: "subject_not_found" }, 404);
  }

  // -- d: rate limit ----------------------------------------------------------
  const windowStart = new Date(
    Date.now() - RATE_LIMIT_WINDOW_HOURS * 3600 * 1000,
  ).toISOString();
  const { count } = await db
    .from("flags")
    .select("id", { count: "exact", head: true })
    .eq("reporter_user_id", caller.id)
    .gte("created_at", windowStart);
  if ((count ?? 0) >= RATE_LIMIT_MAX) {
    return json({ error: "rate_limited" }, 429);
  }

  // -- e: insert ---------------------------------------------------------------
  const { data: flag, error } = await db
    .from("flags")
    .insert({
      reporter_user_id: caller.id,
      subject_type,
      subject_id,
      reason,
      detail,
    })
    .select()
    .single();
  if (error) {
    console.error("flag insert failed", error);
    return json({ error: "create_failed" }, 500);
  }

  // -- f: event ----------------------------------------------------------------
  await db.from("events").insert({
    user_id: caller.id,
    name: "flag_submitted",
    props: { subject_type, reason },
  });

  return json({ flag }, 201);
});
