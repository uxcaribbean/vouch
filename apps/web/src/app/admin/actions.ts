/**
 * The client half of the admin-action contract (supabase/functions/
 * admin-action). One chokepoint on the server means one chokepoint here:
 * every mutating control on every admin screen goes through
 * `runAdminAction`, so error copy and the audit trail can't diverge screen
 * by screen.
 *
 * The union below mirrors the function's zod schema exactly — if it ever
 * drifts, the server answers `invalid_input` rather than doing something
 * surprising.
 */
import { invokeFunction } from "@/lib/supabase";

export type AdminActionBody =
  | { action: "resolve_flag"; flag_id: string; resolution_note?: string }
  | { action: "dismiss_flag"; flag_id: string; resolution_note?: string }
  | { action: "remove_vouch"; vouch_id: string; note?: string }
  | { action: "hide_trader"; trader_id: string; note?: string }
  | { action: "restore_trader"; trader_id: string; note?: string }
  | { action: "suspend_user"; user_id: string; note?: string }
  | { action: "unsuspend_user"; user_id: string; note?: string }
  | { action: "approve_trade"; trade_id: number; note?: string }
  | {
      action: "merge_trade";
      from_trade_id: number;
      into_trade_id: number;
      note?: string;
    }
  | { action: "adjust_credit"; user_id: string; months: number; note?: string };

const MESSAGES: Record<string, string> = {
  unauthorized: "Your session expired — sign out and back in.",
  not_admin: "This account no longer has admin access.",
  invalid_input: "The server rejected that input. Check the fields and retry.",
  flag_not_found: "That report is no longer there — refresh the queue.",
  subject_not_found: "The subject of that report no longer exists.",
  vouch_not_found: "That vouch no longer exists.",
  trader_not_found: "That trader profile no longer exists.",
  user_not_found: "That member no longer exists.",
  trade_not_found: "That trade no longer exists.",
  same_trade: "A trade can't be merged into itself.",
  merge_target_not_active: "You can only merge into an active trade.",
  // The action happened but its audit row didn't — never silently fine.
  audit_failed: "The action ran but its audit row failed. Tell an engineer.",
};

/** Returns null on success, or a human sentence to show next to the control. */
export async function runAdminAction(
  body: AdminActionBody,
): Promise<string | null> {
  const { errorCode } = await invokeFunction("admin-action", { ...body });
  if (!errorCode) return null;
  return MESSAGES[errorCode] ?? "That didn't go through. Try again in a moment.";
}

/** Trim to undefined so optional notes are omitted, not sent as "". */
export function optionalNote(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
