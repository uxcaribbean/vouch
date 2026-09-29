/**
 * interpret-need — M12. Turns what a customer typed ("water leaking through
 * the ceiling when rain fall") into the trade they should search ("Roofer").
 *
 * PUBLIC-ish: verify_jwt is on, but the anon key is a valid JWT, so a
 * logged-out visitor can call this. No user is required; when there is one
 * we only record who asked in the analytics event.
 *
 * The questions, thresholds and outcome policy live in
 * packages/shared/src/understanding.ts — this file loads the active
 * taxonomy, calls the model, and resolves slugs to trades. Order:
 *   a. body validation -> 400 invalid_input
 *   b. exact trade name / slug / keyword hit -> answered in code, no model
 *   c. otherwise ask Jev; a null answer (no key, timeout, outage) is
 *      { outcome: "unavailable", source: "fallback" } and the client falls
 *      back to its plain keyword search
 *   d. need_interpreted event — outcome/source/top trade only, NEVER the
 *      search text (people type private things into search boxes)
 *
 * Only ACTIVE trades are ever offered: merged and proposed trades are not
 * something a customer can search for.
 */
import { json, preflight } from "../_shared/http.ts";
import { getAuthUser, serviceClient } from "../_shared/supabase.ts";
import { askJev } from "../_shared/typesafe.ts";
import {
  exactTradeMatch,
  InterpretNeedSchema,
  interpretNeedPolicy,
  needQuestions,
  type TradeForMatching,
} from "../../../packages/shared/src/understanding.ts";

const MODEL_TIMEOUT_MS = 4000;

type ResolvedTrade = {
  id: number;
  slug: string;
  name: string;
  probability: number;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return preflight();
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const parsed = InterpretNeedSchema.safeParse(
    await req.json().catch(() => null),
  );
  if (!parsed.success) return json({ error: "invalid_input" }, 400);
  const need = parsed.data.need;

  const db = serviceClient();
  const user = await getAuthUser(req); // null for anon-key callers

  const { data: tradeRows, error: tradesError } = await db
    .from("trades")
    .select("id, slug, name, keywords")
    .eq("status", "active");
  if (tradesError || !tradeRows) {
    console.error("interpret-need: trades load failed", tradesError?.message);
    return json({ error: "internal_error" }, 500);
  }
  const trades: TradeForMatching[] = tradeRows;
  const bySlug = new Map(trades.map((t) => [t.slug, t]));
  const resolve = (slug: string, probability: number): ResolvedTrade | null => {
    const t = bySlug.get(slug);
    return t ? { id: t.id, slug: t.slug, name: t.name, probability } : null;
  };

  let result: {
    outcome: string;
    source: "exact" | "model" | "fallback";
    model: string | null;
    trades: ResolvedTrade[];
  };

  const exactSlug = exactTradeMatch(need, trades);
  const exactTrade = exactSlug ? resolve(exactSlug, 1) : null;
  if (exactTrade) {
    result = {
      outcome: "confident",
      source: "exact",
      model: null,
      trades: [exactTrade],
    };
  } else {
    const answer = await askJev({ need }, needQuestions(trades), {
      timeoutMs: MODEL_TIMEOUT_MS,
    });
    const probabilities = answer?.answers.trade?.probabilities ?? null;
    const decision = interpretNeedPolicy(probabilities);
    if (!answer || decision.outcome === "unavailable") {
      result = { outcome: "unavailable", source: "fallback", model: null, trades: [] };
    } else {
      const resolved = decision.trades
        .map((r) => resolve(r.slug, r.probability))
        .filter((t): t is ResolvedTrade => t !== null);
      // A "confident"/"ambiguous" answer whose trades all fail to resolve
      // (the model named a slug we don't list) has nothing to show.
      const outcome =
        (decision.outcome === "confident" || decision.outcome === "ambiguous") &&
          resolved.length === 0
          ? "no_match"
          : decision.outcome;
      result = { outcome, source: "model", model: answer.model, trades: resolved };
    }
  }

  // d. analytics — never the raw text. events.user_id is a FK to
  // public.users, and a signed-in caller who has not finished their profile
  // has no such row, so a failed attributed insert is retried anonymously.
  const props = {
    outcome: result.outcome,
    source: result.source,
    top_trade_id: result.trades[0]?.id ?? null,
  };
  try {
    const { error } = await db.from("events").insert({
      user_id: user?.id ?? null,
      name: "need_interpreted",
      props,
    });
    if (error && user) {
      await db.from("events").insert({
        user_id: null,
        name: "need_interpreted",
        props,
      });
    }
  } catch (e) {
    console.error("interpret-need: event insert failed", (e as Error)?.name);
  }

  return json(result, 200);
});
