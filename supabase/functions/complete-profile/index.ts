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
import { sendNotification } from "../_shared/notify.ts";
import { getAuthUser, serviceClient } from "../_shared/supabase.ts";

const SIGNUP_BONUS_MONTHS = 6;
const REFERRAL_CODE_ATTEMPTS = 5;
const REFERRAL_CAP_PER_YEAR = 24;

function addMonths(dateStr: string, months: number): string {
  const d = new Date(dateStr);
  d.setMonth(d.getMonth() + months);
  return d.toISOString().slice(0, 10);
}

/**
 * Referral crediting (spec M6.3), run once on the freshly-created-profile
 * path only (never on the idempotent existing-profile early return).
 * Order is contractual — see scripts/acceptance/test-m6.mjs:
 *   a. farming defense — a phone number can only ever earn one credit
 *   b. 24-referral-months/year cap
 *   c. credit: +1 month ledger row, mark referrals.credited, extend the
 *      referrer's free_until if they're a trader, push the referrer (M8)
 */
async function creditReferralIfEligible(
  db: ReturnType<typeof serviceClient>,
  args: {
    referrerId: string;
    referralId: string;
    referredUserId: string;
    referredDisplayName: string;
    referredPhoneHash: string;
  },
) {
  const {
    referrerId,
    referralId,
    referredUserId,
    referredDisplayName,
    referredPhoneHash,
  } = args;

  // a. farming defense: this phone already earned a credit on another row.
  const { data: reused } = await db
    .from("referrals")
    .select("id")
    .eq("referred_phone_hash", referredPhoneHash)
    .eq("credited", true)
    .neq("referred_user_id", referredUserId)
    .limit(1)
    .maybeSingle();
  if (reused) {
    await db.from("events").insert({
      user_id: referredUserId,
      name: "referral_blocked",
      props: { reason: "phone_reused", referrer: referrerId },
    });
    return;
  }

  // b. cap: 24 referral-months/user/year.
  const yearAgo = new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString();
  const { count } = await db
    .from("credit_ledger")
    .select("id", { count: "exact", head: true })
    .eq("user_id", referrerId)
    .eq("reason", "referral")
    .gte("created_at", yearAgo);
  if ((count ?? 0) >= REFERRAL_CAP_PER_YEAR) {
    await db.from("events").insert({
      user_id: referredUserId,
      name: "referral_cap_hit",
      props: { referrer: referrerId },
    });
    return;
  }

  // c. credit.
  await db.from("credit_ledger").insert({
    user_id: referrerId,
    months: 1,
    reason: "referral",
    ref_id: referralId,
  });
  await db.from("referrals").update({ credited: true }).eq("id", referralId);

  const { data: referrerTrader } = await db
    .from("trader_profiles")
    .select("id, free_until")
    .eq("user_id", referrerId)
    .maybeSingle();
  if (referrerTrader) {
    await db
      .from("trader_profiles")
      .update({ free_until: addMonths(referrerTrader.free_until, 1) })
      .eq("id", referrerTrader.id);
  }

  // M8: tell the referrer their free time just grew. Transactional, so the
  // weekly cap never eats it. Never allowed to fail the credit above.
  try {
    await sendNotification(db, {
      userId: referrerId,
      type: "referral_credited",
      title: "Your free time just went up ⏫",
      body: `${referredDisplayName} joined with your code — +1 free month.`,
      data: { referred_user_id: referredUserId, referral_id: referralId },
      transactional: true,
    });
  } catch (notifyError) {
    console.error("referral_credited notification failed", notifyError);
  }

  await db.from("events").insert({
    user_id: referredUserId,
    name: "referral_credited",
    props: { referrer: referrerId },
  });
}

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

  // M7: the region is optional. The no-install web flow (spec M7.2) creates
  // minimal accounts — display name only — so an absent region is valid and
  // stored as null. When one IS supplied it must still be a real, enabled
  // child region.
  if (home_region_id !== undefined) {
    const { data: region } = await db
      .from("regions")
      .select("id, enabled, parent_id")
      .eq("id", home_region_id)
      .maybeSingle();
    if (!region?.enabled || region.parent_id === null) {
      return json({ error: "invalid_region" }, 400);
    }
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
        home_region_id: home_region_id ?? null,
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
    const { data: referralRow, error: referralError } = await db
      .from("referrals")
      .insert({
        referrer_user_id: referrerId,
        referred_user_id: user.id,
        referred_phone_hash: phone.hash,
      })
      .select("id")
      .single();
    if (referralError) {
      console.error("referral row insert failed", referralError);
    } else {
      await creditReferralIfEligible(db, {
        referrerId,
        referralId: referralRow.id,
        referredUserId: user.id,
        referredDisplayName: display_name,
        referredPhoneHash: phone.hash,
      });
    }
  }

  await db.from("events").insert({
    user_id: user.id,
    name: "signup",
    props: { source: referrerId ? "referral" : "organic" },
  });

  return json({ profile, created: true }, 201);
});
