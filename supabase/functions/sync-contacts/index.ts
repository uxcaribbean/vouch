/**
 * sync-contacts — spec M4. The privacy boundary for contact-graph matching:
 * clients upload sha256(E.164) fingerprints only, never raw numbers or
 * names. `ContactSyncBatchSchema` (packages/shared) is the only shape this
 * function accepts — anything else, including a raw phone number, is a 400
 * invalid_input. No other endpoint may write contact_hashes (clients keep
 * their read/delete-only grants from M1).
 *
 * Logic order (contractual — see scripts/acceptance/test-m4.mjs):
 *   a. auth + body validation (the schema IS the privacy boundary)
 *   b. caller must have a completed, non-deleted profile
 *   c. light rate limit on 'contact_sync' events (defense, spec §6 — not
 *      exercised by the acceptance suite)
 *   d. total-size sanity cap (current + incoming <= 25000)
 *   e. replace:true wipes the caller's rows first; then upsert the batch
 *      on-conflict-do-nothing (replace:false batches may overlap)
 *   f. replace:true flips users.contact_sync_enabled on first sync, with a
 *      one-time 'contact_sync_enabled' event on the false -> true transition
 *   g. always record a 'contact_sync' event
 *   h. respond with the caller's current total row count
 */
import { ContactSyncBatchSchema } from "../../../packages/shared/src/schemas.ts";
import { json, preflight } from "../_shared/http.ts";
import { getAuthUser, serviceClient } from "../_shared/supabase.ts";

const MAX_TOTAL_HASHES = 25000;
const RATE_LIMIT_WINDOW_HOURS = 1;
const RATE_LIMIT_MAX_SYNCS = 30;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return preflight();
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const user = await getAuthUser(req);
  if (!user) return json({ error: "unauthorized" }, 401);

  const parsed = ContactSyncBatchSchema.safeParse(
    await req.json().catch(() => null),
  );
  if (!parsed.success) {
    return json(
      { error: "invalid_input", details: parsed.error.flatten() },
      400,
    );
  }
  const { hashes, replace } = parsed.data;

  const db = serviceClient();

  // -- b: caller must be a real, live member --------------------------------
  const { data: caller } = await db
    .from("users")
    .select("id, deleted_at, contact_sync_enabled")
    .eq("id", user.id)
    .maybeSingle();
  if (!caller || caller.deleted_at) {
    return json({ error: "profile_incomplete" }, 400);
  }

  // -- c: light rate limit ----------------------------------------------------
  const windowStart = new Date(
    Date.now() - RATE_LIMIT_WINDOW_HOURS * 3600 * 1000,
  ).toISOString();
  const { count: recentSyncs } = await db
    .from("events")
    .select("id", { count: "exact", head: true })
    .eq("user_id", caller.id)
    .eq("name", "contact_sync")
    .gte("created_at", windowStart);
  if ((recentSyncs ?? 0) > RATE_LIMIT_MAX_SYNCS) {
    return json({ error: "rate_limited" }, 429);
  }

  // -- d: total-size sanity cap -------------------------------------------------
  const { count: existingCount } = await db
    .from("contact_hashes")
    .select("owner_user_id", { count: "exact", head: true })
    .eq("owner_user_id", caller.id);
  const base = replace ? 0 : (existingCount ?? 0);
  if (base + hashes.length > MAX_TOTAL_HASHES) {
    return json({ error: "too_many_hashes" }, 400);
  }

  // -- e: replace wipes first, then upsert (on-conflict-do-nothing) -----------
  if (replace) {
    const { error: delError } = await db
      .from("contact_hashes")
      .delete()
      .eq("owner_user_id", caller.id);
    if (delError) {
      console.error("contact_hashes wipe failed", delError);
      return json({ error: "sync_failed" }, 500);
    }
  }

  if (hashes.length > 0) {
    const { error: insError } = await db.from("contact_hashes").upsert(
      hashes.map((phone_hash) => ({ owner_user_id: caller.id, phone_hash })),
      { onConflict: "owner_user_id,phone_hash", ignoreDuplicates: true },
    );
    if (insError) {
      console.error("contact_hashes upsert failed", insError);
      return json({ error: "sync_failed" }, 500);
    }
  }

  // -- f: flip contact_sync_enabled on the false -> true transition only -------
  if (replace && !caller.contact_sync_enabled) {
    await db
      .from("users")
      .update({ contact_sync_enabled: true })
      .eq("id", caller.id);
    await db.from("events").insert({
      user_id: caller.id,
      name: "contact_sync_enabled",
      props: { hash_count: hashes.length },
    });
  }

  // -- g: always record the sync event -----------------------------------------
  await db.from("events").insert({
    user_id: caller.id,
    name: "contact_sync",
    props: { batch: hashes.length, replace },
  });

  // -- h: respond with the caller's current total -------------------------------
  const { count: stored } = await db
    .from("contact_hashes")
    .select("owner_user_id", { count: "exact", head: true })
    .eq("owner_user_id", caller.id);

  return json({ stored: stored ?? 0 }, 200);
});
