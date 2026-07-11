/**
 * complete-profile — turns a freshly OTP-verified auth user into a full
 * member (spec M1.1/M1.2): users row, phone hash, referral code, +6 month
 * signup bonus, optional referred-by linkage. Idempotent: calling again
 * returns the existing profile.
 */
import { normalizeAndHash } from "../../../packages/shared/src/phone.ts";
import { generateReferralCode } from "../../../packages/shared/src/referral.ts";
import { CompleteProfileSchema } from "../../../packages/shared/src/schemas.ts";
import { json, preflight } from "../_shared/http.ts";
import { getAuthUser, serviceClient } from "../_shared/supabase.ts";

const SIGNUP_BONUS_MONTHS = 6;
const REFERRAL_CODE_ATTEMPTS = 5;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return preflight();
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const user = await getAuthUser(req);
  if (!user) return json({ error: "unauthorized" }, 401);
  if (!user.phone) return json({ error: "no_phone_on_account" }, 400);

  const body = await req.json().catch(() => null);
  const parsed = CompleteProfileSchema.safeParse(body);
  if (!parsed.success) {
    return json(
      { error: "invalid_input", details: parsed.error.flatten() },
      400,
    );
  }
  const { display_name, home_region_id, referral_code } = parsed.data;

  const db = serviceClient();

  const { data: existing } = await db
    .from("users")
    .select()
    .eq("id", user.id)
    .maybeSingle();
  if (existing) return json({ profile: existing, created: false });

  // auth.users stores the phone E.164 without the "+"
  const phone = normalizeAndHash(`+${user.phone.replace(/^\+/, "")}`);
  if (!phone) return json({ error: "invalid_phone" }, 400);

  const { data: region } = await db
    .from("regions")
    .select("id, enabled, parent_id")
    .eq("id", home_region_id)
    .maybeSingle();
  if (!region?.enabled || region.parent_id === null) {
    return json({ error: "invalid_region" }, 400);
  }

  // Resolve the referrer up front so a typo'd code fails loudly, not silently.
  let referrerId: string | null = null;
  if (referral_code) {
    const { data: referrer } = await db
      .from("users")
      .select("id")
      .eq("referral_code", referral_code)
      .is("deleted_at", null)
      .maybeSingle();
    if (!referrer) return json({ error: "invalid_referral_code" }, 400);
    referrerId = referrer.id;
  }

  let profile: Record<string, unknown> | null = null;
  for (let attempt = 0; attempt < REFERRAL_CODE_ATTEMPTS; attempt++) {
    const { data, error } = await db
      .from("users")
      .insert({
        id: user.id,
        phone_e164: phone.e164,
        phone_hash: phone.hash,
        display_name,
        home_region_id,
        referral_code: generateReferralCode(),
        referred_by_user_id: referrerId,
      })
      .select()
      .single();
    if (!error) {
      profile = data;
      break;
    }
    if (error.code === "23505" && error.message.includes("referral_code")) {
      continue; // astronomically rare collision — roll a new code
    }
    if (error.code === "23505" && error.message.includes("users_pkey")) {
      // double-tap race: the other request won, return its result
      const { data: raced } = await db
        .from("users")
        .select()
        .eq("id", user.id)
        .single();
      return json({ profile: raced, created: false });
    }
    console.error("profile insert failed", error);
    return json({ error: "profile_create_failed" }, 500);
  }
  if (!profile) return json({ error: "referral_code_exhausted" }, 500);

  await db.from("credit_ledger").insert({
    user_id: user.id,
    months: SIGNUP_BONUS_MONTHS,
    reason: "signup_bonus",
  });

  if (referrerId) {
    // crediting the referrer happens in M6; this just records the edge
    await db.from("referrals").insert({
      referrer_user_id: referrerId,
      referred_user_id: user.id,
    });
  }

  await db.from("events").insert({
    user_id: user.id,
    name: "signup",
    props: { source: referrerId ? "referral" : "organic" },
  });

  return json({ profile, created: true }, 201);
});
