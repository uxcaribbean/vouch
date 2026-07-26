/**
 * admin-action — spec M9 "Admin dashboard". ONE audited chokepoint for
 * every moderation and curation action, so the audit trail can never be
 * partial: each successful action writes exactly one audit_log row, and
 * nothing here is reachable any other way (flags/vouches/trader_profiles/
 * trades/users all refuse client writes on these columns).
 *
 * Actions: resolve_flag, dismiss_flag, remove_vouch, hide_trader,
 * restore_trader, suspend_user, unsuspend_user, approve_trade, merge_trade,
 * adjust_credit.
 *
 * Logic order (contractual — see scripts/acceptance/test-m9.mjs):
 *   a. auth
 *   b. caller must be a live, unsuspended users row with role='admin'
 *      -> 403 not_admin (checked before the body is even looked at)
 *   c. body validation — discriminated union on `action`
 *   d. perform the action; a missing subject is a 404, never a silent no-op
 *   e. exactly ONE audit_log row
 *
 * Deliberately silent: admin removal of a vouch notifies NO ONE (spec M9
 * acceptance — "quiet removal"). Nothing in this function may call
 * sendNotification.
 */
import { z } from "zod";
import { json, preflight } from "../_shared/http.ts";
import { getAuthUser, serviceClient } from "../_shared/supabase.ts";

const MAX_NOTE_LENGTH = 1000;

/** Same month arithmetic as complete-profile's credit paths (M1/M6). */
function addMonths(dateStr: string, months: number): string {
  const d = new Date(dateStr);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

const note = z.string().trim().max(MAX_NOTE_LENGTH).optional();
const uuid = z.string().uuid();
const tradeId = z.number().int().positive();

const ActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("resolve_flag"), flag_id: uuid, resolution_note: note }),
  z.object({ action: z.literal("dismiss_flag"), flag_id: uuid, resolution_note: note }),
  z.object({ action: z.literal("remove_vouch"), vouch_id: uuid, note }),
  z.object({ action: z.literal("hide_trader"), trader_id: uuid, note }),
  z.object({ action: z.literal("restore_trader"), trader_id: uuid, note }),
  z.object({ action: z.literal("suspend_user"), user_id: uuid, note }),
  z.object({ action: z.literal("unsuspend_user"), user_id: uuid, note }),
  z.object({ action: z.literal("approve_trade"), trade_id: tradeId, note }),
  z.object({
    action: z.literal("merge_trade"),
    from_trade_id: tradeId,
    into_trade_id: tradeId,
    note,
  }),
  z.object({
    action: z.literal("adjust_credit"),
    user_id: uuid,
    // negative months are corrections, not a bug — zero is the no-op we reject
    months: z.number().int().refine((m) => m !== 0, "months must not be zero"),
    note,
  }),
]);

/** What the audit row records once the action has actually happened. */
type Audited = {
  subject_type: string;
  subject_id: string | null;
  note: string | null;
  meta: Record<string, unknown>;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return preflight();
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  // -- a: auth ---------------------------------------------------------------
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
  const parsed = ActionSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return json(
      { error: "invalid_input", details: parsed.error.flatten() },
      400,
    );
  }
  const body = parsed.data;

  // -- d: perform ------------------------------------------------------------
  let audited: Audited;
  let result: Record<string, unknown> = {};

  switch (body.action) {
    case "resolve_flag":
    case "dismiss_flag": {
      const { data: flag } = await db
        .from("flags")
        .select("id")
        .eq("id", body.flag_id)
        .maybeSingle();
      if (!flag) return json({ error: "flag_not_found" }, 404);

      const status = body.action === "resolve_flag" ? "resolved" : "dismissed";
      const { data: updated, error } = await db
        .from("flags")
        .update({
          status,
          resolved_by: admin.id,
          resolution_note: body.resolution_note ?? null,
        })
        .eq("id", flag.id)
        .select()
        .single();
      if (error) {
        console.error("flag update failed", error);
        return json({ error: "action_failed" }, 500);
      }

      result = { flag: updated };
      audited = {
        subject_type: "flag",
        subject_id: flag.id,
        note: body.resolution_note ?? null,
        meta: { status },
      };
      break;
    }

    case "remove_vouch": {
      const { data: vouch } = await db
        .from("vouches")
        .select("id, trader_id, trade_id, voucher_user_id")
        .eq("id", body.vouch_id)
        .maybeSingle();
      if (!vouch) return json({ error: "vouch_not_found" }, 404);

      // QUIET: status flip only. No push, no event addressed at anyone —
      // the vouch simply stops counting (spec M9 acceptance).
      const { error } = await db
        .from("vouches")
        .update({ status: "removed_by_admin" })
        .eq("id", vouch.id);
      if (error) {
        console.error("vouch removal failed", error);
        return json({ error: "action_failed" }, 500);
      }

      result = { removed: true };
      audited = {
        subject_type: "vouch",
        subject_id: vouch.id,
        note: body.note ?? null,
        meta: { trader_id: vouch.trader_id, trade_id: vouch.trade_id },
      };
      break;
    }

    case "hide_trader":
    case "restore_trader": {
      const { data: trader } = await db
        .from("trader_profiles")
        .select("id, status")
        .eq("id", body.trader_id)
        .maybeSingle();
      if (!trader) return json({ error: "trader_not_found" }, 404);

      const status = body.action === "hide_trader" ? "hidden" : "active";
      const { error } = await db
        .from("trader_profiles")
        .update({ status })
        .eq("id", trader.id);
      if (error) {
        console.error("trader status update failed", error);
        return json({ error: "action_failed" }, 500);
      }

      result = { trader_id: trader.id, status };
      audited = {
        subject_type: "trader",
        subject_id: trader.id,
        note: body.note ?? null,
        meta: { from: trader.status, to: status },
      };
      break;
    }

    case "suspend_user":
    case "unsuspend_user": {
      const { data: target } = await db
        .from("users")
        .select("id, suspended_at")
        .eq("id", body.user_id)
        .maybeSingle();
      if (!target) return json({ error: "user_not_found" }, 404);

      const suspendedAt =
        body.action === "suspend_user" ? new Date().toISOString() : null;
      const { error } = await db
        .from("users")
        .update({ suspended_at: suspendedAt })
        .eq("id", target.id);
      if (error) {
        console.error("user suspension update failed", error);
        return json({ error: "action_failed" }, 500);
      }

      result = { user_id: target.id, suspended_at: suspendedAt };
      audited = {
        subject_type: "user",
        subject_id: target.id,
        note: body.note ?? null,
        meta: { suspended: suspendedAt !== null },
      };
      break;
    }

    case "approve_trade": {
      const { data: trade } = await db
        .from("trades")
        .select("id, status")
        .eq("id", body.trade_id)
        .maybeSingle();
      if (!trade) return json({ error: "trade_not_found" }, 404);

      const { error } = await db
        .from("trades")
        .update({ status: "active" })
        .eq("id", trade.id);
      if (error) {
        console.error("trade approval failed", error);
        return json({ error: "action_failed" }, 500);
      }

      result = { trade_id: trade.id, status: "active" };
      // trades are int-keyed; audit_log.subject_id is uuid, so the id rides
      // in meta.
      audited = {
        subject_type: "trade",
        subject_id: null,
        note: body.note ?? null,
        meta: { trade_id: trade.id, from: trade.status, to: "active" },
      };
      break;
    }

    case "merge_trade": {
      if (body.from_trade_id === body.into_trade_id) {
        return json({ error: "same_trade" }, 400);
      }
      const { data: trades } = await db
        .from("trades")
        .select("id, status")
        .in("id", [body.from_trade_id, body.into_trade_id]);
      const from = trades?.find((t) => t.id === body.from_trade_id);
      const into = trades?.find((t) => t.id === body.into_trade_id);
      if (!from || !into) return json({ error: "trade_not_found" }, 404);
      if (into.status !== "active") {
        return json({ error: "merge_target_not_active" }, 400);
      }

      // One definer function so the conflict-dedup and the re-point cannot
      // be observed half-done (see the migration for why rows are dropped).
      const { error } = await db.rpc("admin_merge_trade", {
        p_from: from.id,
        p_into: into.id,
      });
      if (error) {
        console.error("trade merge failed", error);
        return json({ error: "action_failed" }, 500);
      }

      result = { from_trade_id: from.id, into_trade_id: into.id };
      audited = {
        subject_type: "trade",
        subject_id: null,
        note: body.note ?? null,
        meta: { from_trade_id: from.id, into_trade_id: into.id },
      };
      break;
    }

    case "adjust_credit": {
      const { data: target } = await db
        .from("users")
        .select("id")
        .eq("id", body.user_id)
        .maybeSingle();
      if (!target) return json({ error: "user_not_found" }, 404);

      const { data: ledgerRow, error } = await db
        .from("credit_ledger")
        .insert({ user_id: target.id, months: body.months, reason: "admin" })
        .select("id")
        .single();
      if (error) {
        console.error("credit adjustment failed", error);
        return json({ error: "action_failed" }, 500);
      }

      // A trader's free time moves with the ledger (same rule as M6's
      // referral credit); a non-trader just banks the months.
      const { data: trader } = await db
        .from("trader_profiles")
        .select("id, free_until")
        .eq("user_id", target.id)
        .maybeSingle();
      let freeUntil: string | null = null;
      if (trader) {
        freeUntil = addMonths(trader.free_until, body.months);
        await db
          .from("trader_profiles")
          .update({ free_until: freeUntil })
          .eq("id", trader.id);
      }

      result = {
        user_id: target.id,
        months: body.months,
        free_until: freeUntil,
      };
      audited = {
        subject_type: "user",
        subject_id: target.id,
        note: body.note ?? null,
        meta: {
          months: body.months,
          credit_ledger_id: ledgerRow.id,
          free_until: freeUntil,
        },
      };
      break;
    }
  }

  // -- e: exactly one audit row ----------------------------------------------
  const { error: auditError } = await db.from("audit_log").insert({
    admin_user_id: admin.id,
    action: body.action,
    subject_type: audited.subject_type,
    subject_id: audited.subject_id,
    note: audited.note,
    meta: audited.meta,
  });
  if (auditError) {
    // The action already happened; losing the audit row would be worse than
    // a noisy log, so surface it rather than swallow it.
    console.error("audit_log insert failed", auditError);
    return json({ error: "audit_failed" }, 500);
  }

  return json({ ok: true, action: body.action, ...result }, 200);
});
