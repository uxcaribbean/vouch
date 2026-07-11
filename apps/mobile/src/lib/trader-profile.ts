import type { Tables } from '@vouch/shared';
import { useEffect, useState } from 'react';

import { useAuth } from '@/lib/auth';
import { supabase } from '@/lib/supabase';

/** id 1 ("Trinidad") is the island-wide shortcut — spec M2.1. */
export const ALL_TRINIDAD_REGION_ID = 1;

export type TraderTradeJoin = {
  trade_id: number;
  trades: Pick<Tables<'trades'>, 'id' | 'name' | 'slug' | 'status'> | null;
};

export type TraderRegionJoin = {
  region_id: number;
  regions: Pick<Tables<'regions'>, 'id' | 'name'> | null;
};

export type TraderProfileWithJoins = Tables<'trader_profiles'> & {
  trader_trades: TraderTradeJoin[];
  trader_regions: TraderRegionJoin[];
};

export const TRADER_PROFILE_SELECT =
  '*, trader_trades(trade_id, trades(id, name, slug, status)), trader_regions(region_id, regions(id, name))';

/** Human copy for a trades chip list — proposed (self-declared) trades are called out. */
export function tradeChipLabel(join: Pick<TraderTradeJoin, 'trades'>): string {
  const name = join.trades?.name ?? 'Service';
  return join.trades?.status === 'proposed' ? `${name} (pending approval)` : name;
}

export function regionsSummary(joins: TraderRegionJoin[]): string {
  if (joins.some((join) => join.region_id === ALL_TRINIDAD_REGION_ID)) return 'All Trinidad';
  const names = joins.map((join) => join.regions?.name).filter((name): name is string => Boolean(name));
  return names.length ? names.join(', ') : 'No regions set';
}

/**
 * Same summary as {@link regionsSummary} but for search_traders' already-
 * resolved `region_names` (spec M3.3) — the RPC returns the raw region name
 * ("Trinidad") for the island-wide shortcut, so we still need to relabel it.
 */
export function regionNamesSummary(names: string[] | null | undefined): string {
  if (!names || names.length === 0) return 'No regions set';
  if (names.includes('Trinidad')) return 'All Trinidad';
  return names.join(', ');
}

/**
 * Lightweight existence check for entry points that only need to branch a
 * label/route (home tab, settings) — not the full profile with joins.
 */
export function useTraderProfileId(): { traderId: string | null; loaded: boolean } {
  const { session } = useAuth();
  const [fetchedId, setFetchedId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    supabase
      .from('trader_profiles')
      .select('id')
      .eq('user_id', session.user.id)
      .maybeSingle()
      .then(({ data }) => {
        if (cancelled) return;
        setFetchedId(data?.id ?? null);
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [session]);

  // While logged out there is nothing to fetch — report done immediately
  // instead of resetting state synchronously inside the effect.
  return session ? { traderId: fetchedId, loaded } : { traderId: null, loaded: true };
}
