import { describe, expect, it } from "vitest";
import {
  commentVerdict,
  exactTradeMatch,
  GENUINELY_NEW,
  interpretNeedPolicy,
  needQuestions,
  NONE_OF_THESE,
  normalizeNeed,
  suggestTradePolicy,
  suggestTradeQuestions,
  tradeCriteria,
  type TradeForMatching,
} from "../src/understanding";

const TRADES: TradeForMatching[] = [
  { id: 100, slug: "plumber", name: "Plumber", keywords: ["pipes", "leak"] },
  { id: 105, slug: "roofer", name: "Roofer", keywords: ["roof", "galvanize"] },
  { id: 108, slug: "ac-technician", name: "AC Technician", keywords: ["ac", "aircon", "fridge"] },
  { id: 109, slug: "appliance-repair", name: "Appliance Repair", keywords: ["fridge", "stove"] },
];

describe("normalizeNeed", () => {
  it("lowercases, collapses spaces, strips trailing punctuation", () => {
    expect(normalizeNeed("  My AC   leaking!! ")).toBe("my ac leaking");
    expect(normalizeNeed("Plumber?")).toBe("plumber");
  });
});

describe("exactTradeMatch — answered in code, no model call", () => {
  it.each([
    ["Plumber", "plumber"],
    ["plumbers", "plumber"],
    ["AC technician", "ac-technician"],
    ["ac-technician", "ac-technician"],
    ["aircon", "ac-technician"],
    ["Galvanize", "roofer"],
  ])("%s → %s", (need, slug) => {
    expect(exactTradeMatch(need, TRADES)).toBe(slug);
  });

  it("a sentence is not an exact match", () => {
    expect(exactTradeMatch("water leaking through the ceiling", TRADES)).toBeNull();
  });

  it("ambiguous keyword returns the first listed trade deterministically", () => {
    expect(exactTradeMatch("fridge", TRADES)).toBe("ac-technician");
  });
});

describe("question builders", () => {
  it("offers every trade plus none_of_these for needs", () => {
    const q = needQuestions(TRADES).trade;
    expect(q.type).toBe("choice");
    expect(Object.keys(q.criteria)).toEqual([...TRADES.map((t) => t.slug), NONE_OF_THESE]);
    expect(q.criteria.plumber).toBe("Plumber (pipes, leak)");
  });

  it("offers every trade plus genuinely_new for suggestions", () => {
    const q = suggestTradeQuestions(TRADES).existing;
    expect(Object.keys(q.criteria)).toContain(GENUINELY_NEW);
    expect(Object.keys(q.criteria)).toHaveLength(TRADES.length + 1);
  });

  it("tradeCriteria omits empty keyword lists", () => {
    expect(tradeCriteria([{ id: 1, slug: "x", name: "X", keywords: [] }])).toEqual({ x: "X" });
  });
});

describe("interpretNeedPolicy", () => {
  it("outage → unavailable", () => {
    expect(interpretNeedPolicy(null)).toEqual({ outcome: "unavailable", trades: [] });
  });

  it("confident top trade → straight to results", () => {
    const r = interpretNeedPolicy({ roofer: 0.97, plumber: 0.02, [NONE_OF_THESE]: 0.01 });
    expect(r).toEqual({ outcome: "confident", trades: [{ slug: "roofer", probability: 0.97 }] });
  });

  it("split decision → ambiguous with alternatives, none_of_these excluded", () => {
    const r = interpretNeedPolicy({
      "appliance-repair": 0.57,
      "ac-technician": 0.4,
      plumber: 0.02,
      [NONE_OF_THESE]: 0.01,
    });
    expect(r.outcome).toBe("ambiguous");
    expect(r.trades.map((t) => t.slug)).toEqual(["appliance-repair", "ac-technician"]);
  });

  it("caps alternatives at three", () => {
    const r = interpretNeedPolicy({ a: 0.3, b: 0.25, c: 0.2, d: 0.2, [NONE_OF_THESE]: 0.05 });
    expect(r.trades).toHaveLength(3);
  });

  it("nothing fits → no_match, with a hint only when strong enough", () => {
    expect(interpretNeedPolicy({ [NONE_OF_THESE]: 0.55, "pet-grooming": 0.45 })).toEqual({
      outcome: "no_match",
      trades: [{ slug: "pet-grooming", probability: 0.45 }],
    });
    expect(interpretNeedPolicy({ [NONE_OF_THESE]: 0.99, plumber: 0.01 })).toEqual({
      outcome: "no_match",
      trades: [],
    });
  });

  it("empty distribution → unavailable", () => {
    expect(interpretNeedPolicy({}).outcome).toBe("unavailable");
  });
});

describe("commentVerdict — fail-open, positive-only", () => {
  const s = (praise: number, complaint: number, promotes_other: number) => ({
    praise,
    complaint,
    promotes_other,
  });

  it("outage publishes unchecked", () => {
    expect(commentVerdict(null)).toEqual({ action: "publish", check: "unchecked" });
  });
  it("clear praise passes", () => {
    expect(commentVerdict(s(0.98, 0.02, 0.03))).toEqual({ action: "publish", check: "passed" });
  });
  it("clear complaint is refused", () => {
    expect(commentVerdict(s(0.17, 0.99, 0.02))).toEqual({
      action: "reject",
      code: "comment_not_positive",
    });
  });
  it("complaint outranks promotion when both are high", () => {
    expect(commentVerdict(s(0.1, 0.9, 0.95))).toMatchObject({ code: "comment_not_positive" });
  });
  it("clear advertising is refused", () => {
    expect(commentVerdict(s(0.97, 0.03, 0.98))).toEqual({
      action: "reject",
      code: "comment_promotes_other",
    });
  });
  it("borderline complaint publishes but is flagged for review", () => {
    expect(commentVerdict(s(0.6, 0.6, 0.02))).toEqual({
      action: "publish",
      check: "flagged",
      reason: "may contain a complaint",
    });
  });
  it("borderline promotion publishes but is flagged for review", () => {
    expect(commentVerdict(s(0.9, 0.1, 0.6))).toMatchObject({ check: "flagged", reason: "may advertise someone else" });
  });
});

describe("suggestTradePolicy", () => {
  it("outage → unavailable", () => {
    expect(suggestTradePolicy(null)).toEqual({ outcome: "unavailable" });
  });
  it("very likely an existing trade → existing", () => {
    expect(suggestTradePolicy({ "ac-technician": 0.99, [GENUINELY_NEW]: 0.01 })).toEqual({
      outcome: "existing",
      slug: "ac-technician",
      probability: 0.99,
    });
  });
  it("uncertain match → new, with the closest trade as an admin hint", () => {
    expect(suggestTradePolicy({ videographer: 0.58, roofer: 0.35, [GENUINELY_NEW]: 0.07 })).toEqual({
      outcome: "new",
      closest: { slug: "videographer", probability: 0.58 },
    });
  });
  it("genuinely new with weak neighbours → new, no hint", () => {
    expect(suggestTradePolicy({ [GENUINELY_NEW]: 0.99, accounting: 0.01 })).toEqual({
      outcome: "new",
      closest: null,
    });
  });
});
