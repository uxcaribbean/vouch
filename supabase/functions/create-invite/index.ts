/**
 * create-invite — spec M6.1/M6.2. Mints a bearer-capability invite token
 * for either a vouch-request (trader asking their contacts to vouch) or a
 * generic join-invite (anyone inviting anyone). The backend never sends
 * anything anywhere — this only returns a token; sharing is always the
 * client's job via the OS share sheet / WhatsApp deep link (spec M6.4).
 *
 * Logic order (contractual — see scripts/acceptance/test-m6.mjs):
 *   a. auth + body validation
 *   b. caller must have a completed profile
 *   c. kind='vouch_request' requires an active|lapsed trader_profiles row
 *      owned by the caller (trader_id is that row); kind='join_invite'
 *      carries no trader_id
 *   d. rate limit: 20 invites/24h/caller
 *   e. insert with a fresh token, retrying once on a (practically
 *      impossible) unique-token collision
 *   f. invite_created event
 */
import {
  CreateInviteSchema,
  generateInviteToken,
  INVITE_EXPIRY_DAYS,
} from "../../../packages/shared/src/invites.ts";
import { json, preflight } from "../_shared/http.ts";
import { getAuthUser, serviceClient } from "../_shared/supabase.ts";

const RATE_LIMIT_WINDOW_HOURS = 24;
const RATE_LIMIT_MAX = 20;
const INSERT_ATTEMPTS = 2; // one retry on a unique token collision

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return preflight();
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const user = await getAuthUser(req);
  if (!user) return json({ error: "unauthorized" }, 401);

  const parsed = CreateInviteSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return json(
      { error: "invalid_input", details: parsed.error.flatten() },
      400,
    );
  }
  const { kind } = parsed.data;

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

  // -- c: vouch_request requires an active|lapsed trader profile -------------
  let traderId: string | null = null;
  if (kind === "vouch_request") {
    const { data: trader } = await db
      .from("trader_profiles")
      .select("id, status")
      .eq("user_id", caller.id)
      .maybeSingle();
    if (!trader || !["active", "lapsed"].includes(trader.status)) {
      return json({ error: "not_a_trader" }, 400);
    }
    traderId = trader.id;
  }

  // -- d: rate limit -----------------------------------------------------------
  const windowStart = new Date(
    Date.now() - RATE_LIMIT_WINDOW_HOURS * 3600 * 1000,
  ).toISOString();
  const { count } = await db
    .from("invites")
    .select("id", { count: "exact", head: true })
    .eq("inviter_user_id", caller.id)
    .gte("created_at", windowStart);
  if ((count ?? 0) >= RATE_LIMIT_MAX) {
    return json({ error: "rate_limited" }, 429);
  }

  // -- e: insert, retry once on token collision --------------------------------
  const expiresAt = new Date(
    Date.now() + INVITE_EXPIRY_DAYS * 24 * 3600 * 1000,
  ).toISOString();

  let invite: { token: string; kind: string; trader_id: string | null; expires_at: string } | null =
    null;
  for (let attempt = 0; attempt < INSERT_ATTEMPTS; attempt++) {
    const { data, error } = await db
      .from("invites")
      .insert({
        inviter_user_id: caller.id,
        kind,
        trader_id: traderId,
        token: generateInviteToken(),
        expires_at: expiresAt,
      })
      .select("token, kind, trader_id, expires_at")
      .single();
    if (!error) {
      invite = data;
      break;
    }
    if (error.code === "23505" && error.message.includes("token")) {
      continue; // astronomically rare collision — roll a new token
    }
    console.error("invite create failed", error);
    return json({ error: "create_failed" }, 500);
  }
  if (!invite) return json({ error: "token_exhausted" }, 500);

  // -- f: event ------------------------------------------------------------------
  await db.from("events").insert({
    user_id: caller.id,
    name: "invite_created",
    props: { kind },
  });

  return json(
    {
      token: invite.token,
      kind: invite.kind,
      trader_id: invite.trader_id,
      expires_at: invite.expires_at,
    },
    201,
  );
});
