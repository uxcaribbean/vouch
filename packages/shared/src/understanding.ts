/**
 * M12 — plain-language understanding, powered by TypeSafe's Jev model.
 *
 * Reviewer-owned contract: the exact questions sent to the model, the
 * thresholds that turn its probabilities into actions, and the behaviour
 * when the service is unavailable all live here as pure functions, so
 * they are unit-tested and identical in every edge function. Edge
 * functions only make the HTTP call and hand the answer (or null) to
 * these policies.
 *
 * Nothing in this module ever receives phone numbers, hashes or contact
 * data (iron rule 2). The model sees: a customer's typed need, a vouch
 * comment, or a trader's typed service name — plus the public taxonomy.
 */
import { z } from "zod";

/** Pinned: every threshold below was tuned against this version (2026-09-29).
 * Move to a new version deliberately, re-running test-m12 first. */
export const JEV_MODEL = "jev-1.13.0";

export const NONE_OF_THESE = "none_of_these";
export const GENUINELY_NEW = "genuinely_new";

export type TradeForMatching = {
  id: number;
  slug: string;
  name: string;
  keywords: string[];
};

export type NoulQuestion = {
  type: "noul";
  instructions: string;
  criteria?: { true?: string; false?: string };
};
export type ChoiceQuestion = {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
};
export type TypeSafeQuestion = NoulQuestion | ChoiceQuestion;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** "  My AC   leaking!! " → "my ac leaking" — the exact-match form. */
export function normalizeNeed(input: string): string {
  return input
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[?!.,;:]+$/g, "")
    .trim();
}

/** One Choice option per active trade: key = slug, description = name + keywords. */
export function tradeCriteria(trades: TradeForMatching[]): Record<string, string> {
  return Object.fromEntries(
    trades.map((t) => [
      t.slug,
      t.keywords.length ? `${t.name} (${t.keywords.join(", ")})` : t.name,
    ]),
  );
}

type Ranked = { slug: string; probability: number };

function ranked(probabilities: Record<string, number>): Ranked[] {
  return Object.entries(probabilities)
    .map(([slug, probability]) => ({ slug, probability }))
    .sort((a, b) => b.probability - a.probability);
}

// ---------------------------------------------------------------------------
// 1. Search by need — "water leaking through the ceiling" → Roofer
// ---------------------------------------------------------------------------

export const InterpretNeedSchema = z.object({
  need: z.string().trim().min(2).max(200),
});

/** Exact name / slug / keyword hit (singular or simple plural) — answered in
 * code, no model call. Returns the trade slug or null. */
export function exactTradeMatch(need: string, trades: TradeForMatching[]): string | null {
  const n = normalizeNeed(need);
  const forms = n.endsWith("s") && n.length > 3 ? [n, n.slice(0, -1)] : [n];
  for (const t of trades) {
    const names = [t.name.toLowerCase(), t.slug, t.slug.replace(/-/g, " "), ...t.keywords.map((k) => k.toLowerCase())];
    if (forms.some((f) => names.includes(f))) return t.slug;
  }
  return null;
}

export function needQuestions(trades: TradeForMatching[]): { trade: ChoiceQuestion } {
  return {
    trade: {
      type: "choice",
      instructions:
        "Which trade or service would a person in Trinidad and Tobago hire for the need described in `need`?",
      criteria: {
        ...tradeCriteria(trades),
        [NONE_OF_THESE]: "No trade or service in this list fits the need.",
      },
    },
  };
}

/** Top trade at or above this → go straight to results. */
export const NEED_CONFIDENT = 0.8;
/** Alternatives shown as "Did you mean…" must reach this. */
export const NEED_ALTERNATIVE_MIN = 0.15;
export const NEED_MAX_ALTERNATIVES = 3;
/** When nothing fits, still offer the best trade if it reaches this. */
export const NEED_HINT_MIN = 0.3;

export type NeedOutcome =
  | { outcome: "confident"; trades: Ranked[] }
  | { outcome: "ambiguous"; trades: Ranked[] }
  | { outcome: "no_match"; trades: Ranked[] }
  | { outcome: "unavailable"; trades: [] };

export function interpretNeedPolicy(probabilities: Record<string, number> | null): NeedOutcome {
  if (!probabilities) return { outcome: "unavailable", trades: [] };
  const all = ranked(probabilities);
  const tradesOnly = all.filter((r) => r.slug !== NONE_OF_THESE);
  const top = all[0];
  if (!top) return { outcome: "unavailable", trades: [] };

  if (top.slug === NONE_OF_THESE) {
    const hint = tradesOnly[0];
    return {
      outcome: "no_match",
      trades: hint && hint.probability >= NEED_HINT_MIN ? [hint] : [],
    };
  }
  if (top.probability >= NEED_CONFIDENT) {
    return { outcome: "confident", trades: [top] };
  }
  return {
    outcome: "ambiguous",
    trades: tradesOnly.filter((r) => r.probability >= NEED_ALTERNATIVE_MIN).slice(0, NEED_MAX_ALTERNATIVES),
  };
}

// ---------------------------------------------------------------------------
// 2. Vouch-comment guard — keeps "positive-only" true for free text too
// ---------------------------------------------------------------------------

export const COMMENT_QUESTIONS: Record<keyof CommentScores, NoulQuestion> = {
  praise: {
    type: "noul",
    instructions: "Does `comment` recommend or praise the trader's work?",
    criteria: {
      true: "The comment speaks well of the trader or their work",
      false: "It does not speak well of them",
    },
  },
  complaint: {
    type: "noul",
    instructions:
      "Does `comment` contain any complaint or criticism of the trader, even a small one?",
    criteria: {
      true: "Some part criticises the trader, their work, price or conduct",
      false: "No criticism at all",
    },
  },
  promotes_other: {
    type: "noul",
    instructions:
      "Does `comment` advertise or give contact details for someone other than the trader being vouched for?",
  },
};

/** State sent alongside COMMENT_QUESTIONS. */
export function commentState(tradeName: string, comment: string) {
  return { trader_trade: tradeName, comment };
}

/** At or above: refuse the comment (the voucher can edit it or drop it). */
export const COMMENT_BLOCK = 0.85;
/** At or above (but below block): publish, and queue an automatic flag. */
export const COMMENT_REVIEW = 0.5;

export type CommentScores = {
  praise: number;
  complaint: number;
  promotes_other: number;
};

export type CommentVerdict =
  | { action: "publish"; check: "passed" }
  | { action: "publish"; check: "flagged"; reason: string }
  | { action: "publish"; check: "unchecked" }
  | { action: "reject"; code: "comment_not_positive" | "comment_promotes_other" };

/** Fail-open by design: a service outage must never stop a real vouch. */
export function commentVerdict(scores: CommentScores | null): CommentVerdict {
  if (!scores) return { action: "publish", check: "unchecked" };
  if (scores.complaint >= COMMENT_BLOCK) return { action: "reject", code: "comment_not_positive" };
  if (scores.promotes_other >= COMMENT_BLOCK) return { action: "reject", code: "comment_promotes_other" };
  if (scores.complaint >= COMMENT_REVIEW) {
    return { action: "publish", check: "flagged", reason: "may contain a complaint" };
  }
  if (scores.promotes_other >= COMMENT_REVIEW) {
    return { action: "publish", check: "flagged", reason: "may advertise someone else" };
  }
  return { action: "publish", check: "passed" };
}

// ---------------------------------------------------------------------------
// 3. New-service matching — "AC & fridge repair" → AC Technician?
// ---------------------------------------------------------------------------

export const SuggestTradeSchema = z.object({
  service: z.string().trim().min(2).max(60),
});

export function suggestTradeQuestions(trades: TradeForMatching[]): { existing: ChoiceQuestion } {
  return {
    existing: {
      type: "choice",
      instructions:
        "A trader typed `service` as a service they offer. Is it the same service as one already listed? Pick the listed trade only if a customer searching for that trade would want this trader.",
      criteria: {
        ...tradeCriteria(trades),
        [GENUINELY_NEW]: "Not the same as any listed trade — a genuinely different service.",
      },
    },
  };
}

/** Only this sure do we say "Did you mean…?" to the trader. */
export const SUGGEST_CONFIDENT = 0.9;
/** Below-threshold matches still shown to admins as a hint from here. */
export const SUGGEST_HINT_MIN = 0.3;

export type SuggestOutcome =
  | { outcome: "existing"; slug: string; probability: number }
  | { outcome: "new"; closest: Ranked | null }
  | { outcome: "unavailable" };

export function suggestTradePolicy(probabilities: Record<string, number> | null): SuggestOutcome {
  if (!probabilities) return { outcome: "unavailable" };
  const all = ranked(probabilities);
  const top = all[0];
  if (!top) return { outcome: "unavailable" };
  const bestTrade = all.find((r) => r.slug !== GENUINELY_NEW) ?? null;
  if (top.slug !== GENUINELY_NEW && top.probability >= SUGGEST_CONFIDENT) {
    return { outcome: "existing", slug: top.slug, probability: top.probability };
  }
  return {
    outcome: "new",
    closest: bestTrade && bestTrade.probability >= SUGGEST_HINT_MIN ? bestTrade : null,
  };
}
