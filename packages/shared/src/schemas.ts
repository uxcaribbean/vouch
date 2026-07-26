/**
 * Shared zod schemas — the single source of truth for API payloads.
 * Mobile, web, and edge functions all validate against these.
 * Grows module by module; never edit a shipped schema incompatibly.
 */
import { z } from "zod";
import { normalizePhone } from "./phone.ts";
import { isValidReferralCode, normalizeReferralCode } from "./referral.ts";

/** A phone number in any format the user might type; transforms to E.164. */
export const PhoneInputSchema = z
  .string()
  .trim()
  .min(1, "Enter a phone number")
  .transform((value, ctx) => {
    const e164 = normalizePhone(value);
    if (!e164) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "That doesn't look like a valid phone number",
      });
      return z.NEVER;
    }
    return e164;
  });

export const ReferralCodeSchema = z
  .string()
  .transform(normalizeReferralCode)
  .refine(isValidReferralCode, "That code doesn't look right");

export const DisplayNameSchema = z
  .string()
  .trim()
  .min(2, "Name is too short")
  .max(50, "Name is too long");

/** M1 — payload for completing a new user's profile after OTP.
 * home_region_id optional since M7: the no-install web flow creates
 * minimal accounts (display name only, spec M7.2); mobile still collects
 * a region in its own UI. */
export const CompleteProfileSchema = z.object({
  display_name: DisplayNameSchema,
  home_region_id: z.number().int().positive().optional(),
  referral_code: ReferralCodeSchema.optional(),
});
export type CompleteProfileInput = z.infer<typeof CompleteProfileSchema>;

/** M4 — contact sync upload: hashes only, batched by the client. */
export const ContactHashSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "not a sha256 hex hash");

export const ContactSyncBatchSchema = z.object({
  hashes: z.array(ContactHashSchema).max(500),
  /** true on the first batch of a sync run: server clears old rows first. */
  replace: z.boolean(),
});
export type ContactSyncBatch = z.infer<typeof ContactSyncBatchSchema>;
