/**
 * upsert-vouch — spec M5. Creates, edits, or republishes a vouch. Never a
 * duplicate row: (voucher, trader, trade) is unique, so this endpoint is an
 * upsert keyed on that triple.
 *
 * The zod schema here is intentionally local to this function (not in
 * packages/shared) — M5 does not touch the shared package's API contract
 * beyond the generated database types.
 *
 * Logic order (contractual — see scripts/acceptance/test-m5.mjs):
 *   a. auth + body validation
 *   b. caller must have a completed, non-deleted profile
 *   c. trader must exist and be listed (active|lapsed)
 *   d. no self-vouching
 *   e. trade must be one the trader actually offers
 *   f. branch on any existing (voucher, trader, trade) row:
 *        - removed_by_admin -> locked, no resurrection
 *        - published        -> pure comment edit, no gate/rate-limit
 *        - removed_by_user  -> republish behind the gate (no rate limit)
 *        - none             -> create behind the gate AND the rate limit
 *   g. the anti-gaming gate (contact hash | invite token | prior contact ≥7d)
 *   h. the <24h/5-vouch rate limit, create only
 *   i. vouch_created event, create only
 */
import { z } from "zod";
import { json, preflight } from "../_shared/http.ts";
import { getAuthUser, serviceClient } from "../_shared/supabase.ts";

const MAX_COMMENT_LENGTH = 400;
const GATE_PRIOR_CONTACT_DAYS = 7;
const NEW_ACCOUNT_HOURS = 24;
const NEW_ACCOUNT_VOUCH_CAP = 5;

const BodySchema = z.object({
  trader_id: z.string().uuid(),
  trade_id: z.number().int().positive(),
  comment: z
    .string()
    .trim()
    .max(MAX_COMMENT_LENGTH)
    .optional()
    .transform((v) => (v ? v : null)),
  // M6/M7: a vouch-request invite token scoped to this trader satisfies
  // gate (b) below. Invalid/expired/mismatched/join tokens just don't.
  invite_token: z.string().trim().min(1).optional(),
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
  const { trader_id, trade_id, comment, invite_token } = parsed.data;

  const db = serviceClient();

  // -- b: caller must be a real, live member --------------------------------
  const { data: caller } = await db
    .from("users")
    .select("id, created_at, deleted_at")
    .eq("id", user.id)
    .maybeSingle();
  if (!caller || caller.deleted_at) {
    return json({ error: "profile_incomplete" }, 400);
  }

  // -- c: trader must exist and be listed ------------------------------------
  const { data: trader } = await db
    .from("trader_profiles")
    .select("id, status, user_id")
    .eq("id", trader_id)
    .maybeSingle();
  if (!trader || !["active", "lapsed"].includes(trader.status)) {
    return json({ error: "trader_not_found" }, 404);
  }

  // -- d: no self-vouching ----------------------------------------------------
  if (trader.user_id === caller.id) {
    return json({ error: "self_vouch" }, 403);
  }

  // -- e: trade must be one the trader actually offers ------------------------
  const { data: offer } = await db
    .from("trader_trades")
    .select("trade_id")
    .eq("trader_id", trader_id)
    .eq("trade_id", trade_id)
    .maybeSingle();
  if (!offer) {
    return json({ error: "trade_not_offered" }, 400);
  }

  // trader's owner phone hash — needed by gate (1) below.
  const { data: traderOwner } = await db
    .from("users")
    .select("phone_hash")
    .eq("id", trader.user_id)
    .maybeSingle();

  async function gatePasses(): Promise<boolean> {
    // (1) contact-hash: voucher already has the trader's number saved.
    if (traderOwner?.phone_hash) {
      const { data: contact } = await db
        .from("contact_hashes")
        .select("owner_user_id")
        .eq("owner_user_id", caller!.id)
        .eq("phone_hash", traderOwner.phone_hash)
        .maybeSingle();
      if (contact) return true;
    }

    // (2) invite_token: a valid, unexpired vouch_request token scoped to
    // this trader (M6/M7). Invalid/expired/mismatched/join tokens simply
    // don't satisfy the gate — no special error surfaced to the caller.
    if (invite_token) {
      const { data: invite } = await db
        .from("invites")
        .select("id")
        .eq("token", invite_token)
        .eq("kind", "vouch_request")
        .eq("trader_id", trader_id)
        .gt("expires_at", new Date().toISOString())
        .maybeSingle();
      if (invite) return true;
    }

    // (3) prior in-app contact ≥7 days ago (call/WhatsApp tap on this trader).
    const cutoff = new Date(
      Date.now() - GATE_PRIOR_CONTACT_DAYS * 24 * 3600 * 1000,
    ).toISOString();
    const { data: priorContact } = await db
      .from("events")
      .select("id")
      .eq("user_id", caller!.id)
      .eq("name", "contact_tapped")
      .eq("props->>trader_id", trader_id)
      .lte("created_at", cutoff)
      .limit(1)
      .maybeSingle();
    if (priorContact) return true;

    return false;
  }

  // -- f: branch on any existing (voucher, trader, trade) row -----------------
  const { data: existing } = await db
    .from("vouches")
    .select("id, status")
    .eq("voucher_user_id", caller.id)
    .eq("trader_id", trader_id)
    .eq("trade_id", trade_id)
    .maybeSingle();

  if (existing?.status === "removed_by_admin") {
    return json({ error: "vouch_locked" }, 403);
  }

  if (existing?.status === "published") {
    // pure comment edit — no gate, no rate limit.
    const { data: updated, error } = await db
      .from("vouches")
      .update({ comment })
      .eq("id", existing.id)
      .select()
      .single();
    if (error) {
      console.error("vouch edit failed", error);
      return json({ error: "update_failed" }, 500);
    }
    return json({ vouch: updated, created: false }, 200);
  }

  if (existing?.status === "removed_by_user") {
    // republish — gated, but never rate-limited.
    if (!(await gatePasses())) {
      return json({ error: "gate_not_met" }, 403);
    }
    const { data: updated, error } = await db
      .from("vouches")
      .update({ comment, status: "published" })
      .eq("id", existing.id)
      .select()
      .single();
    if (error) {
      console.error("vouch republish failed", error);
      return json({ error: "update_failed" }, 500);
    }
    return json({ vouch: updated, created: false }, 200);
  }

  // -- no existing row: create, behind gate AND rate limit ---------------------
  if (!(await gatePasses())) {
    return json({ error: "gate_not_met" }, 403);
  }

  const accountAgeMs = Date.now() - new Date(caller.created_at).getTime();
  if (accountAgeMs < NEW_ACCOUNT_HOURS * 3600 * 1000) {
    const { count } = await db
      .from("vouches")
      .select("id", { count: "exact", head: true })
      .eq("voucher_user_id", caller.id);
    if ((count ?? 0) >= NEW_ACCOUNT_VOUCH_CAP) {
      return json({ error: "rate_limited" }, 429);
    }
  }

  const { data: created, error } = await db
    .from("vouches")
    .insert({
      voucher_user_id: caller.id,
      trader_id,
      trade_id,
      comment,
      source: "app",
    })
    .select()
    .single();
  if (error) {
    console.error("vouch create failed", error);
    return json({ error: "create_failed" }, 500);
  }

  await db.from("events").insert({
    user_id: caller.id,
    name: "vouch_created",
    props: { trader_id, trade_id, source: "app" },
  });

  return json({ vouch: created, created: true }, 201);
});
