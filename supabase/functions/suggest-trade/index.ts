/**
 * suggest-trade — M12. While a trader types a service they offer ("AC &
 * fridge repair"), tells them whether an existing trade already covers it,
 * so the taxonomy doesn't fill up with near-duplicates. The wizard shows
 * "Did you mean AC Technician?" only on outcome "existing"; on "new" the
 * proposal goes to the admin curation queue as before (closest, when set,
 * rides along as a hint for the admin).
 *
 * Signed-in users only (verify_jwt AND a real user — the anon key is not
 * enough). Order:
 *   a. auth -> 401 unauthorized
 *   b. body validation -> 400 invalid_input
 *   c. exact name / slug / keyword hit -> "existing", answered in code
 *   d. otherwise ask Jev; null (no key, timeout, outage) -> "unavailable"
 *
 * Matches against ACTIVE trades only, so a proposed trade that an admin is
 * curating is never matched against itself.
 */
import { json, preflight } from "../_shared/http.ts";
import { getAuthUser, serviceClient } from "../_shared/supabase.ts";
import { askJev } from "../_shared/typesafe.ts";
import {
  exactTradeMatch,
  suggestTradePolicy,
  suggestTradeQuestions,
  SuggestTradeSchema,
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

  const user = await getAuthUser(req);
  if (!user) return json({ error: "unauthorized" }, 401);

  const parsed = SuggestTradeSchema.safeParse(
    await req.json().catch(() => null),
  );
  if (!parsed.success) return json({ error: "invalid_input" }, 400);
  const service = parsed.data.service;

  const db = serviceClient();
  const { data: tradeRows, error: tradesError } = await db
    .from("trades")
    .select("id, slug, name, keywords")
    .eq("status", "active");
  if (tradesError || !tradeRows) {
    console.error("suggest-trade: trades load failed", tradesError?.message);
    return json({ error: "internal_error" }, 500);
  }
  const trades: TradeForMatching[] = tradeRows;
  const bySlug = new Map(trades.map((t) => [t.slug, t]));
  const resolve = (slug: string, probability: number): ResolvedTrade | null => {
    const t = bySlug.get(slug);
    return t ? { id: t.id, slug: t.slug, name: t.name, probability } : null;
  };

  const exactSlug = exactTradeMatch(service, trades);
  const exactTrade = exactSlug ? resolve(exactSlug, 1) : null;
  if (exactTrade) {
    return json({
      outcome: "existing",
      source: "exact",
      trade: exactTrade,
      closest: null,
    });
  }

  const answer = await askJev({ service }, suggestTradeQuestions(trades), {
    timeoutMs: MODEL_TIMEOUT_MS,
  });
  const decision = suggestTradePolicy(
    answer?.answers.existing?.probabilities ?? null,
  );

  if (decision.outcome === "existing") {
    const trade = resolve(decision.slug, decision.probability);
    if (trade) {
      return json({ outcome: "existing", source: "model", trade, closest: null });
    }
    // The model named a slug we don't list — nothing trustworthy to say.
  } else if (decision.outcome === "new") {
    const closest = decision.closest
      ? resolve(decision.closest.slug, decision.closest.probability)
      : null;
    return json({ outcome: "new", source: "model", trade: null, closest });
  }
  return json({
    outcome: "unavailable",
    source: "fallback",
    trade: null,
    closest: null,
  });
});
