/**
 * Invite links & prewritten shares — the client half of the M6 growth loop.
 *
 * Iron rule (spec M6.4): NOTHING here sends a message. `create-invite` only
 * mints a token; every outbound message is drafted into WhatsApp / the OS
 * share sheet and a human presses send. Message copy itself lives in
 * `packages/shared/src/invites.ts` — never inline a message string here.
 */
import { buildJoinInviteMessage, joinLinkUrl } from '@vouch/shared';

import { invokeFunction } from '@/lib/supabase';

/**
 * Where the no-install web flow lives (M7 serves `/v/[token]` and `/join`).
 * Overridable per environment via `EXPO_PUBLIC_WEB_BASE_URL`.
 */
export const WEB_BASE_URL = process.env.EXPO_PUBLIC_WEB_BASE_URL ?? 'http://localhost:3000';

export type InviteKind = 'vouch_request' | 'join_invite';

export type CreateInviteResponse = {
  token: string;
  kind: InviteKind;
  /** set for `vouch_request` only */
  trader_id: string | null;
  expires_at: string;
};

/** Mints an invite row + token. Sharing is always the caller's job. */
export async function createInvite(kind: InviteKind) {
  return invokeFunction<CreateInviteResponse>('create-invite', { kind });
}

/** Human copy for `create-invite`'s machine-readable error codes. */
export function inviteErrorCopy(errorCode: string): string {
  if (errorCode === 'rate_limited') {
    return "You've sent a lot of invites today — try again tomorrow.";
  }
  if (errorCode === 'not_a_trader') {
    return 'You need a live listing before you can ask for vouches.';
  }
  return 'Something went wrong preparing your link. Try again.';
}

/** Prewritten "Invite a friend" message (spec M6.2) for a referral code. */
export function buildJoinMessage(referralCode: string): string {
  return buildJoinInviteMessage(joinLinkUrl(WEB_BASE_URL, referralCode));
}

/** `wa.me` deep link that opens a DRAFT — the user still presses send. */
export function whatsAppDraftUrl(e164: string, message: string): string {
  return `https://wa.me/${e164.replace(/\D/g, '')}?text=${encodeURIComponent(message)}`;
}
