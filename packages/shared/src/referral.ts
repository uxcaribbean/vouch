/**
 * Referral codes: 6 chars from an unambiguous alphabet (no 0/O, 1/I/L),
 * e.g. "JAM4KQ". Generated server-side on signup; validated everywhere.
 */

export const REFERRAL_CODE_LENGTH = 6;

/** 23 letters + 8 digits — excludes I, L, O, 0, 1. */
export const REFERRAL_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

const REFERRAL_CODE_RE = new RegExp(
  `^[${REFERRAL_ALPHABET}]{${REFERRAL_CODE_LENGTH}}$`,
);

/** Uppercases and strips whitespace so user-typed codes compare cleanly. */
export function normalizeReferralCode(input: string): string {
  return input.trim().toUpperCase();
}

export function isValidReferralCode(input: string): boolean {
  return REFERRAL_CODE_RE.test(normalizeReferralCode(input));
}

/**
 * Cryptographically random code. Server-side use (Node 20+/Deno both expose
 * globalThis.crypto); uniqueness is enforced by the DB unique constraint —
 * callers retry on collision.
 */
export function generateReferralCode(): string {
  const bytes = new Uint8Array(REFERRAL_CODE_LENGTH);
  globalThis.crypto.getRandomValues(bytes);
  let code = "";
  for (const b of bytes) {
    code += REFERRAL_ALPHABET[b % REFERRAL_ALPHABET.length];
  }
  return code;
}
