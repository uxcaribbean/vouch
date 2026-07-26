/**
 * resolve-invite — spec M7 (this function ships in M6 because the web page
 * lands in M7). PUBLIC: verify_jwt=false in config.toml — this is the one
 * endpoint anon hits before any auth, resolving a `/v/{token}` link into
 * display data. Never returns inviter phone or any hash — only
 * already-public directory data (or the inviter's shareable referral code
 * for join_invite, which is public by design).
 *
 * Garbage/missing/expired tokens all resolve gracefully as
 * { valid: false, ... } — never a 4xx, since anon share links get clicked
 * by all kinds of stale/copy-pasted input.
 */
import { InviteTokenSchema } from "../../../packages/shared/src/invites.ts";
import { json, preflight } from "../_shared/http.ts";
import { serviceClient } from "../_shared/supabase.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return preflight();
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const body = await req.json().catch(() => null);
  const parsedToken = InviteTokenSchema.safeParse(
    (body as { token?: unknown } | null)?.token,
  );
  if (!parsedToken.success) return json({ valid: false });
  const token = parsedToken.data;

  const db = serviceClient();

  const { data: invite } = await db
    .from("invites")
    .select("kind, trader_id, expires_at, inviter_user_id")
    .eq("token", token)
    .maybeSingle();
  if (!invite) return json({ valid: false });

  if (new Date(invite.expires_at).getTime() <= Date.now()) {
    return json({ valid: false, expired: true });
  }

  if (invite.kind === "vouch_request") {
    const { data: trader } = await db
      .from("trader_profiles")
      .select("id, status, business_name, photo_url, user_id")
      .eq("id", invite.trader_id)
      .maybeSingle();
    if (!trader || !["active", "lapsed"].includes(trader.status)) {
      return json({ valid: false });
    }

    const { data: owner } = await db
      .from("users")
      .select("display_name, avatar_url")
      .eq("id", trader.user_id)
      .maybeSingle();

    const { data: tradeRows } = await db
      .from("trader_trades")
      .select("trades(name)")
      .eq("trader_id", trader.id);
    const tradeNames = (tradeRows ?? [])
      .map((r) => (r as { trades: { name: string } | null }).trades?.name)
      .filter((name): name is string => !!name);

    return json({
      valid: true,
      kind: "vouch_request",
      expires_at: invite.expires_at,
      trader: {
        trader_id: trader.id,
        display_name: owner?.display_name ?? null,
        business_name: trader.business_name,
        photo_url: trader.photo_url,
        avatar_url: owner?.avatar_url ?? null,
        trade_names: tradeNames,
      },
    });
  }

  // join_invite — inviter's display name + shareable referral code.
  const { data: inviter } = await db
    .from("users")
    .select("display_name, referral_code")
    .eq("id", invite.inviter_user_id)
    .maybeSingle();
  if (!inviter) return json({ valid: false });

  return json({
    valid: true,
    kind: "join_invite",
    inviter_name: inviter.display_name,
    referral_code: inviter.referral_code,
  });
});
