/**
 * The resolve-invite response contract (supabase/functions/resolve-invite).
 * Shared by the server page and the client stepper — kept here rather than in
 * packages/shared because M7 is a web-only consumer of an existing endpoint.
 */
export type Trade = { id: number; name: string };

export type ResolvedTrader = {
  trader_id: string;
  display_name: string | null;
  business_name: string | null;
  photo_url: string | null;
  avatar_url: string | null;
  trades: Trade[];
  trade_names: string[];
};

export type Resolution =
  | { valid: false; expired?: boolean }
  | {
      valid: true;
      kind: "vouch_request";
      expires_at: string;
      referral_code: string | null;
      trader: ResolvedTrader;
    }
  | {
      valid: true;
      kind: "join_invite";
      inviter_name: string | null;
      referral_code: string;
    };
