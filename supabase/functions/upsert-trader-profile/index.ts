/**
 * upsert-trader-profile — spec M2.1/M2.2.
 * Creates or updates the caller's trader profile, replaces its trade and
 * region sets, and turns free-text services into 'proposed' taxonomy rows
 * that show on the profile immediately and queue for admin curation (M9).
 *
 * free_until on creation = today + every month in the caller's credit
 * ledger (signup bonus 6, plus any referral months earned before turning
 * trader). Referral crediting after creation extends it directly (M6).
 */
import {
  slugifyTrade,
  UpsertTraderProfileSchema,
} from "../../../packages/shared/src/taxonomy.ts";
import { json, preflight } from "../_shared/http.ts";
import { getAuthUser, serviceClient } from "../_shared/supabase.ts";

function addMonths(date: Date, months: number): string {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d.toISOString().slice(0, 10);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return preflight();
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const user = await getAuthUser(req);
  if (!user) return json({ error: "unauthorized" }, 401);

  const parsed = UpsertTraderProfileSchema.safeParse(
    await req.json().catch(() => null),
  );
  if (!parsed.success) {
    return json(
      { error: "invalid_input", details: parsed.error.flatten() },
      400,
    );
  }
  const input = parsed.data;

  const db = serviceClient();

  const { data: member } = await db
    .from("users")
    .select("id, deleted_at")
    .eq("id", user.id)
    .maybeSingle();
  if (!member || member.deleted_at) {
    return json({ error: "profile_incomplete" }, 400);
  }

  // -- resolve taxonomy trades (remap merged → their target) ---------------
  let tradeIds: number[] = [];
  if (input.trade_ids.length) {
    const { data: trades } = await db
      .from("trades")
      .select("id, status, merged_into_id")
      .in("id", input.trade_ids);
    if (!trades || trades.length !== new Set(input.trade_ids).size) {
      return json({ error: "unknown_trade" }, 400);
    }
    tradeIds = trades.map((t) =>
      t.status === "merged" && t.merged_into_id ? t.merged_into_id : t.id,
    );
  }

  // -- create proposed trades for free-text services ------------------------
  for (const name of input.proposed_trades) {
    const slug = slugifyTrade(name);
    if (!slug) return json({ error: "invalid_proposed_trade" }, 400);
    const { data: existing } = await db
      .from("trades")
      .select("id, status, merged_into_id")
      .eq("slug", slug)
      .maybeSingle();
    if (existing) {
      tradeIds.push(
        existing.status === "merged" && existing.merged_into_id
          ? existing.merged_into_id
          : existing.id,
      );
      continue;
    }
    const { data: created, error: proposeError } = await db
      .from("trades")
      .insert({ slug, name, category: "Proposed", status: "proposed" })
      .select("id")
      .single();
    if (proposeError) {
      console.error("propose trade failed", proposeError);
      return json({ error: "propose_trade_failed" }, 500);
    }
    tradeIds.push(created.id);
  }
  tradeIds = [...new Set(tradeIds)];
  if (tradeIds.length === 0) return json({ error: "no_trades" }, 400);

  // -- validate regions ------------------------------------------------------
  const regionIds = [...new Set(input.region_ids)];
  const { data: regions } = await db
    .from("regions")
    .select("id")
    .in("id", regionIds)
    .eq("enabled", true);
  if (!regions || regions.length !== regionIds.length) {
    return json({ error: "invalid_region" }, 400);
  }

  // -- create or update the profile -----------------------------------------
  const { data: existingProfile } = await db
    .from("trader_profiles")
    .select("id, status")
    .eq("user_id", user.id)
    .maybeSingle();
  if (existingProfile && ["suspended", "hidden"].includes(existingProfile.status)) {
    return json({ error: "profile_locked" }, 403);
  }

  const cosmetic = {
    business_name: input.business_name || null,
    bio: input.bio || null,
    photo_url: input.photo_url || null,
    onboarding_complete: true,
  };

  let traderId: string;
  if (existingProfile) {
    const { error } = await db
      .from("trader_profiles")
      .update(cosmetic)
      .eq("id", existingProfile.id);
    if (error) return json({ error: "update_failed" }, 500);
    traderId = existingProfile.id;
  } else {
    const { data: ledger } = await db
      .from("credit_ledger")
      .select("months")
      .eq("user_id", user.id);
    const freeMonths = (ledger ?? []).reduce((sum, row) => sum + row.months, 0);
    const { data: created, error } = await db
      .from("trader_profiles")
      .insert({
        user_id: user.id,
        ...cosmetic,
        free_until: addMonths(new Date(), Math.max(freeMonths, 0)),
      })
      .select("id")
      .single();
    if (error) {
      console.error("trader create failed", error);
      return json({ error: "create_failed" }, 500);
    }
    traderId = created.id;
  }

  // -- replace trade/region sets ---------------------------------------------
  await db.from("trader_trades").delete().eq("trader_id", traderId);
  const { error: tradesError } = await db
    .from("trader_trades")
    .insert(tradeIds.map((trade_id) => ({ trader_id: traderId, trade_id })));
  if (tradesError) return json({ error: "trades_write_failed" }, 500);

  await db.from("trader_regions").delete().eq("trader_id", traderId);
  const { error: regionsError } = await db
    .from("trader_regions")
    .insert(regionIds.map((region_id) => ({ trader_id: traderId, region_id })));
  if (regionsError) return json({ error: "regions_write_failed" }, 500);

  await db.from("events").insert({
    user_id: user.id,
    name: existingProfile ? "trader_profile_updated" : "trader_onboarded",
    props: { trades: tradeIds.length, regions: regionIds.length },
  });

  const { data: profile } = await db
    .from("trader_profiles")
    .select("*, trader_trades(trade_id, trades(id, name, slug, status)), trader_regions(region_id, regions(id, name))")
    .eq("id", traderId)
    .single();

  return json({ profile, created: !existingProfile }, existingProfile ? 200 : 201);
});
