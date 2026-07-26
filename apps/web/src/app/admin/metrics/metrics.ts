/**
 * The admin_metrics() payload, and how it reads in English (spec M11
 * "North-star dashboard"). Kept beside the page rather than in
 * packages/shared because the rpc has exactly one consumer: this dashboard.
 *
 * Every ratio can be null — the rpc divides by nullif(denominator, 0) so
 * "no data yet" never arrives as a zero that reads like a real number. The
 * tiles below therefore always show the raw counts underneath: 1/3 and
 * 3000/9000 are the same ratio and a very different amount of evidence.
 */

/** The spec's north star: the product works when tile 1 passes ~30%. */
export const FRIEND_SEARCH_TARGET = 0.3;

export type AdminMetrics = {
  friend_search_share: {
    searches: number;
    with_friend_result: number;
    share: number | null;
  };
  viral_factor: {
    total_signups: number;
    referral_signups: number;
    factor: number | null;
  };
  vouch_conversion: {
    links_opened: number;
    weblink_vouches: number;
    rate: number | null;
  };
  trader_activation: {
    eligible_traders: number;
    activated: number;
    rate: number | null;
  };
};

export type Tile = {
  key: string;
  title: string;
  ratio: number | null;
  numerator: number;
  denominator: number;
  numeratorLabel: string;
  denominatorLabel: string;
  explanation: string;
  /** Set on the north-star tile only. */
  target?: number;
};

export function formatRatio(ratio: number | null): string {
  if (ratio === null) return "—";
  return `${(ratio * 100).toFixed(1)}%`;
}

/** Narrow the rpc's `json` return without trusting it blindly. */
export function parseMetrics(payload: unknown): AdminMetrics | null {
  if (!payload || typeof payload !== "object") return null;
  const value = payload as Partial<AdminMetrics>;
  if (
    !value.friend_search_share ||
    !value.viral_factor ||
    !value.vouch_conversion ||
    !value.trader_activation
  ) {
    return null;
  }
  return value as AdminMetrics;
}

export function toTiles(metrics: AdminMetrics): Tile[] {
  return [
    {
      key: "friend_search_share",
      title: "% of searches with a friend result",
      ratio: metrics.friend_search_share.share,
      numerator: metrics.friend_search_share.with_friend_result,
      denominator: metrics.friend_search_share.searches,
      numeratorLabel: "searches showing a friend's vouch",
      denominatorLabel: "searches that could show one",
      explanation:
        "How often somebody searching sees a trader vouched for by a person they actually know. This is the whole product in one number.",
      target: FRIEND_SEARCH_TARGET,
    },
    {
      key: "viral_factor",
      title: "Viral factor",
      ratio: metrics.viral_factor.factor,
      numerator: metrics.viral_factor.referral_signups,
      denominator: metrics.viral_factor.total_signups,
      numeratorLabel: "signups from a referral",
      denominatorLabel: "signups in total",
      explanation:
        "The share of new members who arrived through somebody else's link rather than finding us alone.",
    },
    {
      key: "vouch_conversion",
      title: "Vouch conversion",
      ratio: metrics.vouch_conversion.rate,
      numerator: metrics.vouch_conversion.weblink_vouches,
      denominator: metrics.vouch_conversion.links_opened,
      numeratorLabel: "vouches published from a link",
      denominatorLabel: "vouch links opened",
      explanation:
        "Of the people who opened a vouch-request link, how many finished and posted the vouch.",
    },
    {
      key: "trader_activation",
      title: "Trader activation",
      ratio: metrics.trader_activation.rate,
      numerator: metrics.trader_activation.activated,
      denominator: metrics.trader_activation.eligible_traders,
      numeratorLabel: "traders who got there",
      denominatorLabel: "traders old enough to count",
      explanation:
        "Traders who collected 3 vouches inside their first 14 days. Traders younger than 14 days aren't counted — they haven't had the chance yet.",
    },
  ];
}
