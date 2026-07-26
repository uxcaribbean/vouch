/**
 * admin-lookup — spec M9 "User/trader lookup by phone or name". Read-only
 * support tool: find the member behind a phone number or a partial name,
 * see whether they're a trader, how their free time stands, and how much
 * of the graph they account for.
 *
 * PRIVACY BOUNDARY (spec M9.2): the response is built from an explicit
 * column list, never `select()`. It must never carry `phone_hash`,
 * `contact_hashes`, or anything from `private_blocks` — a trader's private
 * block list is invisible to everyone including admins, and phone
 * fingerprints are the matching secret of the whole product. The acceptance
 * suite greps the response for a known hash.
 *
 * Logic order (contractual — see scripts/acceptance/test-m9.mjs):
 *   a. auth
 *   b. admin gate -> 403 not_admin
 *   c. body validation
 *   d. a query that normalizes to E.164 is a phone lookup; otherwise it's a
 *      case-insensitive display-name contains-search (max 10 results)
 *   e. decorate each hit with its trader profile and vouch counts
 */
import { z } from "zod";
import { normalizePhone } from "../../../packages/shared/src/phone.ts";
import { json, preflight } from "../_shared/http.ts";
import { getAuthUser, serviceClient } from "../_shared/supabase.ts";

const MAX_RESULTS = 10;

const BodySchema = z.object({
  query: z.string().trim().min(1).max(120),
});

/** Explicit, hash-free projection of users. Never widen this carelessly. */
const USER_COLUMNS =
  "id, display_name, phone_e164, role, home_region_id, contact_sync_enabled, referral_code, suspended_at, deleted_at, created_at";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return preflight();
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const user = await getAuthUser(req);
  if (!user) return json({ error: "unauthorized" }, 401);

  const db = serviceClient();

  // -- b: admin gate ---------------------------------------------------------
  const { data: admin } = await db
    .from("users")
    .select("id, role, suspended_at, deleted_at")
    .eq("id", user.id)
    .maybeSingle();
  if (!admin || admin.role !== "admin" || admin.suspended_at || admin.deleted_at) {
    return json({ error: "not_admin" }, 403);
  }

  // -- c: body ---------------------------------------------------------------
  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return json(
      { error: "invalid_input", details: parsed.error.flatten() },
      400,
    );
  }
  const { query } = parsed.data;

  // -- d: phone or name ------------------------------------------------------
  // Shared normalizePhone, never a local variant (iron rule 1) — so
  // "868-555-0001", "5550001" and "+18685550001" all find the same member.
  const e164 = normalizePhone(query);
  const matchedBy = e164 ? "phone" : "name";

  const base = db.from("users").select(USER_COLUMNS).limit(MAX_RESULTS);
  const { data: hits, error } = e164
    ? await base.eq("phone_e164", e164)
    : await base.ilike("display_name", `%${query}%`);
  if (error) {
    console.error("lookup failed", error);
    return json({ error: "lookup_failed" }, 500);
  }

  // -- e: decorate -----------------------------------------------------------
  const results = await Promise.all(
    (hits ?? []).map(async (u) => {
      const [{ data: trader }, given] = await Promise.all([
        db
          .from("trader_profiles")
          .select("id, status, free_until")
          .eq("user_id", u.id)
          .maybeSingle(),
        db
          .from("vouches")
          .select("id", { count: "exact", head: true })
          .eq("voucher_user_id", u.id)
          .eq("status", "published"),
      ]);

      let receivedCount = 0;
      if (trader?.id) {
        const { count } = await db
          .from("vouches")
          .select("id", { count: "exact", head: true })
          .eq("trader_id", trader.id)
          .eq("status", "published");
        receivedCount = count ?? 0;
      }

      return {
        user: u,
        trader: trader ?? null,
        counts: {
          vouches_given: given.count ?? 0,
          vouches_received: receivedCount,
        },
      };
    }),
  );

  return json({ matched_by: matchedBy, results }, 200);
});
