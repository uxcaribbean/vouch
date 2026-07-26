/**
 * Invites & referral shares — M6. The growth loop is user-initiated only:
 * these helpers build tokens, links, and prewritten messages; a human
 * always presses send (spec M6.4 — the backend never messages anyone).
 */
import { z } from "zod";

export const INVITE_TOKEN_LENGTH = 32;
export const INVITE_EXPIRY_DAYS = 30;

const TOKEN_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** URL-safe random token, ≥16 chars per spec §3 (we use 32). Server-side. */
export function generateInviteToken(): string {
  const bytes = new Uint8Array(INVITE_TOKEN_LENGTH);
  globalThis.crypto.getRandomValues(bytes);
  let token = "";
  for (const b of bytes) token += TOKEN_ALPHABET[b % TOKEN_ALPHABET.length];
  return token;
}

export const InviteTokenSchema = z
  .string()
  .min(16)
  .max(64)
  .regex(/^[A-Za-z0-9\-_]+$/, "not a url-safe token");

export const CreateInviteSchema = z.object({
  kind: z.enum(["vouch_request", "join_invite"]),
});
export type CreateInviteInput = z.infer<typeof CreateInviteSchema>;

/** `${base}/v/{token}` — the no-install vouch page (M7). */
export function vouchLinkUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/v/${token}`;
}

/** `${base}/join?code=X` — app/store landing with the referral code. */
export function joinLinkUrl(baseUrl: string, referralCode: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/join?code=${encodeURIComponent(referralCode)}`;
}

/** Spec M6.1 prewritten vouch-request message. */
export function buildVouchRequestMessage(args: {
  tradeName: string;
  link: string;
  referralCode: string;
}): string {
  return (
    `I'm on VOUCH as a ${args.tradeName}. If you've used my work, a vouch ` +
    `takes 30 seconds: ${args.link}. If you offer a service yourself, join ` +
    `free with my code ${args.referralCode}.`
  );
}

/** Spec M6.2 prewritten join-invite message. */
export function buildJoinInviteMessage(link: string): string {
  return (
    `Find trades & services vouched by people you actually know. ` +
    `Join free: ${link}`
  );
}
