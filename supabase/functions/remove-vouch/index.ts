/**
 * remove-vouch — spec M5.4. A voucher removes their own vouch at any time.
 * Removal decrements public counts (search_traders only counts
 * status='published'); the row is kept, not deleted, for audit/history.
 * An admin-removed vouch is locked — the owner cannot resurrect it.
 */
import { z } from "zod";
import { json, preflight } from "../_shared/http.ts";
import { getAuthUser, serviceClient } from "../_shared/supabase.ts";

const BodySchema = z.object({
  trader_id: z.string().uuid(),
  trade_id: z.number().int().positive(),
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
  const { trader_id, trade_id } = parsed.data;

  const db = serviceClient();

  const { data: existing } = await db
    .from("vouches")
    .select("id, status")
    .eq("voucher_user_id", user.id)
    .eq("trader_id", trader_id)
    .eq("trade_id", trade_id)
    .maybeSingle();

  if (!existing) {
    return json({ error: "vouch_not_found" }, 404);
  }
  if (existing.status === "removed_by_admin") {
    return json({ error: "vouch_locked" }, 403);
  }

  const { error } = await db
    .from("vouches")
    .update({ status: "removed_by_user" })
    .eq("id", existing.id);
  if (error) {
    console.error("vouch removal failed", error);
    return json({ error: "remove_failed" }, 500);
  }

  await db.from("events").insert({
    user_id: user.id,
    name: "vouch_removed",
    props: { trader_id, trade_id },
  });

  return json({ removed: true });
});
