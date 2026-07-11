/**
 * Phone normalization & hashing — the identity contract for the whole product.
 *
 * Every phone number, wherever it enters the system (signup, contact sync,
 * web vouch flow, edge functions), goes through `normalizePhone` and, when
 * matched against the social graph, `hashPhone`. Mobile, web, and Deno edge
 * functions all import THIS implementation; never reimplement it.
 *
 * Contract:
 *  - normalizePhone(input) → E.164 string (e.g. "+18685551234") or null if
 *    the input is not a valid phone number.
 *  - hashPhone(e164) → sha256 of the FULL E.164 string INCLUDING the leading
 *    "+", UTF-8 encoded, as lowercase hex. Changing this breaks every stored
 *    contact_hashes row, so it never changes.
 */
import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";

/** Launch market is Trinidad & Tobago (+1 868). */
export const DEFAULT_REGION: CountryCode = "TT";

/** Trinidad & Tobago area code within the NANP. */
const TT_AREA_CODE = "868";

/**
 * Normalize any user- or device-supplied phone string to E.164.
 *
 * Accepts local formats ("868-555-1234", "5551234", "(868) 555-1234"),
 * NANP forms with or without the leading 1/+1, and full international
 * numbers. Already-international numbers keep their own country code —
 * we never force +1868 onto them.
 *
 * Validation is possible-length (`isPossible`), NOT carrier-pattern
 * (`isValid`): pattern metadata lags real allocations and rejects whole
 * exchanges (e.g. NANP 555), which would silently break contact matching.
 * OTP delivery is the true validity gate for identity numbers.
 *
 * Returns null for anything that can't be a phone number.
 */
export function normalizePhone(
  input: string,
  defaultRegion: CountryCode = DEFAULT_REGION,
): string | null {
  const raw = input?.trim();
  if (!raw) return null;

  const parsed = parsePhoneNumberFromString(raw, defaultRegion);
  if (parsed?.isPossible()) return parsed.number;

  // TT numbers are often written as the bare 7-digit subscriber number
  // ("5551234"). libphonenumber can't resolve those because the NANP
  // national number includes the area code, so prepend 868 and retry.
  // Only applies when the input carries no country/area information.
  if (defaultRegion === "TT" && !raw.startsWith("+")) {
    const digits = raw.replace(/\D/g, "");
    if (digits.length === 7) {
      const retried = parsePhoneNumberFromString(TT_AREA_CODE + digits, "TT");
      if (retried?.isPossible()) return retried.number;
    }
  }

  return null;
}

/**
 * sha256 of the full E.164 string (including "+"), lowercase hex.
 * This is the only hash the server ever stores for contact matching.
 */
export function hashPhone(e164: string): string {
  return bytesToHex(sha256(utf8ToBytes(e164)));
}

/** Normalize then hash in one step. Null if the input isn't a valid number. */
export function normalizeAndHash(
  input: string,
  defaultRegion: CountryCode = DEFAULT_REGION,
): { e164: string; hash: string } | null {
  const e164 = normalizePhone(input, defaultRegion);
  if (!e164) return null;
  return { e164, hash: hashPhone(e164) };
}

/**
 * Contact-sync helper: raw device numbers → deduped list of hashes.
 * Invalid numbers are dropped silently; raw numbers never leave the caller.
 */
export function hashContactList(
  rawNumbers: string[],
  defaultRegion: CountryCode = DEFAULT_REGION,
): string[] {
  const hashes = new Set<string>();
  for (const raw of rawNumbers) {
    const result = normalizeAndHash(raw, defaultRegion);
    if (result) hashes.add(result.hash);
  }
  return [...hashes];
}
