import type { Database, Tables } from '@vouch/shared';
import { Image } from 'expo-image';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet } from 'react-native';

import { InviteAFriend } from '@/components/invite-a-friend';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Button } from '@/components/ui/button';
import { TextField } from '@/components/ui/text-field';
import { ToggleChip } from '@/components/ui/toggle-chip';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { trackEvent } from '@/lib/analytics';
import { useAuth } from '@/lib/auth';
import { ALL_TRINIDAD_REGION, useSelectedRegion } from '@/lib/region-state';
import { invokeFunction, supabase } from '@/lib/supabase';
import { regionNamesSummary } from '@/lib/trader-profile';

type TradeOption = Pick<Tables<'trades'>, 'id' | 'name' | 'slug' | 'category' | 'keywords' | 'status'>;
type SearchRow = Database['public']['Functions']['search_traders']['Returns'][number];
type RegionOption = { id: number; name: string };

type ResolvedResults = { key: string } & ({ status: 'ready'; rows: SearchRow[] } | { status: 'error' });

// M12 — plain-language search. Response shape of the `interpret-need` edge
// function (see scripts/acceptance/test-m12.mjs for the live contract).
type NeedTrade = { id: number; slug: string; name: string; probability: number };
type NeedResponse = {
  outcome: 'confident' | 'ambiguous' | 'no_match' | 'unavailable';
  /** 'exact' = the text was already a trade name — no caption needed. */
  source?: 'exact' | 'model' | 'fallback';
  trades: NeedTrade[];
};
/** One submitted need. Identity (not text) is the key: re-submitting the same
 * text is a fresh request, and dropping it (edit/select) discards late answers. */
type NeedRequest = { text: string };
type NeedAnswer = { request: NeedRequest; outcome: 'ambiguous' | 'no_match'; trades: NeedTrade[] };
type NeedCaption = { text: string; tradeId: number; tradeName: string };

/** Never throws: null means "use the local typeahead" (the designed fallback
 * for `unavailable`, network errors and bad payloads alike). */
async function interpretNeed(text: string): Promise<NeedResponse | null> {
  try {
    const { data, errorCode } = await invokeFunction<NeedResponse>('interpret-need', {
      need: text.slice(0, 200),
    });
    if (errorCode || !data || !Array.isArray(data.trades)) return null;
    return data;
  } catch {
    return null;
  }
}

export default function SearchScreen() {
  const router = useRouter();
  const theme = useTheme();
  const { session, profile } = useAuth();
  const params = useLocalSearchParams<{ q?: string; category?: string; trade?: string }>();
  const [region, setRegion] = useSelectedRegion();
  const [regions, setRegions] = useState<RegionOption[]>([]);

  const [trades, setTrades] = useState<TradeOption[]>([]);

  const [query, setQuery] = useState(params.q ?? '');
  // Deep-link support: a `trade` param pre-selects by id immediately; its
  // display name is looked up below once the taxonomy loads.
  const [selectedTradeId, setSelectedTradeId] = useState<number | null>(() =>
    params.trade ? Number(params.trade) : null,
  );
  const [searchAll, setSearchAll] = useState(false);
  // "People I know" filter (spec M4.4) — logged-in + synced only.
  const [friendsOnly, setFriendsOnly] = useState(false);
  const canFilterFriends = Boolean(session && profile?.contact_sync_enabled);
  const [retryTick, setRetryTick] = useState(0);
  // Search-by-need: on submit (or arrival with ?q=) the text goes to
  // `interpret-need` once. Like `resolved` below, "loading" is derived by
  // comparing the answer's request to the current one — no separate flag.
  const [needRequest, setNeedRequest] = useState<NeedRequest | null>(() => {
    const initial = params.q?.trim() ?? '';
    return initial.length >= 2 && !params.trade ? { text: initial } : null;
  });
  const [needAnswer, setNeedAnswer] = useState<NeedAnswer | null>(null);
  const [needCaption, setNeedCaption] = useState<NeedCaption | null>(null);
  // `resolved` only ever changes inside the effect's async continuation
  // (never synchronously in the effect body) — "loading" is derived below by
  // comparing `resolved.key` to the current `requestKey`, so there is no
  // separate loading flag to keep in sync.
  const [resolved, setResolved] = useState<ResolvedResults | null>(null);

  // Mirrors `session` for use inside the search effect below without making
  // it a dependency (auth resolving shouldn't re-trigger a fresh search).
  const sessionRef = useRef(session);
  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  useEffect(() => {
    supabase
      .from('regions')
      .select('id,name')
      .eq('enabled', true)
      .order('sort')
      .then(({ data }) => setRegions(data ?? []));
  }, []);

  useEffect(() => {
    supabase
      .from('trades')
      .select('id,name,slug,category,keywords,status')
      .in('status', ['active', 'proposed'])
      .order('name')
      .then(({ data }) => setTrades(data ?? []));
  }, []);

  const friendsFilterActive = canFilterFriends && friendsOnly;
  const requestKey =
    selectedTradeId != null || searchAll
      ? `${selectedTradeId ?? 'all'}|${region.id}|${friendsFilterActive}|${retryTick}`
      : null;

  useEffect(() => {
    if (requestKey == null) return;
    let cancelled = false;
    supabase
      .rpc('search_traders', {
        p_trade_id: selectedTradeId ?? undefined,
        p_region_id: region.id,
        p_friends_only: friendsFilterActive,
        p_limit: 50,
      })
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error || !data) {
          setResolved({ key: requestKey, status: 'error' });
          return;
        }
        setResolved({ key: requestKey, status: 'ready', rows: data });
        void trackEvent(sessionRef.current, 'search_performed', {
          trade_id: selectedTradeId ?? null,
          region_id: region.id,
          results_count: data.length,
          // Spec M11's north-star input: how many results carried a vouch
          // from someone the searcher knows.
          friend_results_count: data.filter((row) => (row.friend_vouch_count ?? 0) > 0).length,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [requestKey, selectedTradeId, region.id, friendsFilterActive]);

  // Setters only, so the identity is stable and the need effect can depend on it.
  const selectTrade = useCallback((trade: Pick<TradeOption, 'id' | 'name'>, fromNeedText?: string) => {
    setSelectedTradeId(trade.id);
    setSearchAll(false);
    setQuery('');
    setNeedRequest(null);
    setNeedCaption(fromNeedText ? { text: fromNeedText, tradeId: trade.id, tradeName: trade.name } : null);
  }, []);

  useEffect(() => {
    if (!needRequest) return;
    // Cleanup runs when the request is replaced or dropped (text edited, a
    // trade picked, "Search all services") — a late answer is then ignored.
    let cancelled = false;
    void interpretNeed(needRequest.text).then((answer) => {
      if (cancelled) return;
      if (!answer || answer.outcome === 'unavailable') {
        setNeedRequest(null);
        return;
      }
      if (answer.outcome === 'confident') {
        const top = answer.trades[0];
        if (top) selectTrade(top, answer.source === 'exact' ? undefined : needRequest.text);
        else setNeedRequest(null);
        return;
      }
      if (answer.outcome === 'ambiguous' && answer.trades.length === 0) {
        setNeedRequest(null);
        return;
      }
      setNeedAnswer({ request: needRequest, outcome: answer.outcome, trades: answer.trades });
    });
    return () => {
      cancelled = true;
    };
  }, [needRequest, selectTrade]);

  function submitNeed() {
    const text = query.trim();
    if (text.length < 2) return;
    setNeedRequest({ text });
  }

  function changeQuery(next: string) {
    setQuery(next);
    setNeedRequest(null);
  }

  function clearSelection() {
    // Put the sentence back so the person can rephrase rather than retype.
    if (needCaption && needCaption.tradeId === selectedTradeId) setQuery(needCaption.text);
    setSelectedTradeId(null);
    setSearchAll(false);
    setNeedCaption(null);
  }

  function searchEverything() {
    setSearchAll(true);
    setNeedRequest(null);
    setNeedCaption(null);
  }

  function pickRegion(next: RegionOption) {
    setRegion(next.id === ALL_TRINIDAD_REGION.id ? ALL_TRINIDAD_REGION : next);
  }

  const activeCaption = needCaption && needCaption.tradeId === selectedTradeId ? needCaption : null;
  const selectedTradeName =
    selectedTradeId != null
      ? (trades.find((t) => t.id === selectedTradeId)?.name ?? activeCaption?.tradeName ?? 'Selected service')
      : null;
  const needLoading = needRequest != null && needAnswer?.request !== needRequest;
  const activeAnswer = needRequest != null && needAnswer?.request === needRequest ? needAnswer : null;
  const normalizedQuery = query.trim().toLowerCase();
  const filteredResults =
    normalizedQuery.length > 0
      ? trades
          .filter((t) => `${t.name} ${(t.keywords ?? []).join(' ')}`.toLowerCase().includes(normalizedQuery))
          .slice(0, 20)
      : [];
  const categoryTrades = params.category ? trades.filter((t) => t.category === params.category) : [];
  const showPicker = selectedTradeId == null && !searchAll;
  const isCurrent = requestKey != null && resolved?.key === requestKey;
  const isLoading = requestKey != null && !isCurrent;

  const categorySection = params.category ? (
    <ThemedView style={styles.chipSection}>
      <ThemedText type="smallBold" themeColor="textSecondary">
        {params.category}
      </ThemedText>
      <ThemedView style={styles.chipList}>
        {categoryTrades.map((trade) => (
          <ToggleChip key={trade.id} label={trade.name} selected={false} onPress={() => selectTrade(trade)} />
        ))}
      </ThemedView>
    </ThemedView>
  ) : null;

  return (
    <ThemedView style={styles.container}>
      <ScrollView
        style={styles.inner}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled">
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.regionRow}>
          <ToggleChip
            label={ALL_TRINIDAD_REGION.name}
            selected={region.id === ALL_TRINIDAD_REGION.id}
            onPress={() => pickRegion(ALL_TRINIDAD_REGION)}
          />
          {regions
            .filter((r) => r.id !== ALL_TRINIDAD_REGION.id)
            .map((r) => (
              <ToggleChip
                key={r.id}
                label={r.name}
                selected={region.id === r.id}
                onPress={() => pickRegion(r)}
              />
            ))}
          {canFilterFriends ? (
            <ToggleChip
              label="People I know"
              role="checkbox"
              selected={friendsOnly}
              onPress={() => setFriendsOnly((v) => !v)}
            />
          ) : null}
        </ScrollView>

        {showPicker ? (
          <ThemedView style={styles.stepBlock}>
            <TextField
              placeholder="What do you need? e.g. plumber"
              value={query}
              onChangeText={changeQuery}
              onSubmitEditing={submitNeed}
              returnKeyType="search"
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus={!params.category}
            />

            {needLoading ? (
              <ThemedView style={styles.findingRow} accessibilityLiveRegion="polite">
                <ActivityIndicator />
                <ThemedText type="small" themeColor="textSecondary">
                  Finding the right trade…
                </ThemedText>
              </ThemedView>
            ) : activeAnswer?.outcome === 'ambiguous' ? (
              <ThemedView style={styles.chipSection}>
                <ThemedText type="smallBold" themeColor="textSecondary">
                  Did you mean…
                </ThemedText>
                <ThemedView style={styles.chipList}>
                  {activeAnswer.trades.map((trade) => (
                    <ToggleChip
                      key={trade.id}
                      label={trade.name}
                      selected={false}
                      onPress={() => selectTrade(trade)}
                    />
                  ))}
                </ThemedView>
              </ThemedView>
            ) : activeAnswer?.outcome === 'no_match' ? (
              <>
                <ThemedView style={styles.chipSection}>
                  <ThemedText themeColor="textSecondary">
                    {`VOUCH doesn't list a service for “${activeAnswer.request.text}” yet.`}
                  </ThemedText>
                  {activeAnswer.trades[0] ? (
                    <>
                      <ThemedText type="smallBold" themeColor="textSecondary">
                        Closest match:
                      </ThemedText>
                      <ThemedView style={styles.chipList}>
                        <ToggleChip
                          label={activeAnswer.trades[0].name}
                          selected={false}
                          onPress={() => selectTrade(activeAnswer.trades[0])}
                        />
                      </ThemedView>
                    </>
                  ) : null}
                </ThemedView>
                {categorySection}
              </>
            ) : normalizedQuery.length > 0 ? (
              <ThemedView style={styles.resultsList}>
                {filteredResults.map((trade) => (
                  <Pressable
                    key={trade.id}
                    accessibilityRole="button"
                    onPress={() => selectTrade(trade)}
                    style={[styles.resultRow, { backgroundColor: theme.backgroundElement }]}>
                    <ThemedText>{trade.name}</ThemedText>
                  </Pressable>
                ))}
                {filteredResults.length === 0 ? (
                  <ThemedText type="small" themeColor="textSecondary">
                    No matching service — try a different word, or search all services below.
                  </ThemedText>
                ) : null}
              </ThemedView>
            ) : (
              categorySection
            )}

            <Button label="Search all services" variant="soft" onPress={searchEverything} />
          </ThemedView>
        ) : (
          <ThemedView style={styles.selectedRow}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Change search — currently ${selectedTradeName ?? 'all services'}`}
              onPress={clearSelection}
              style={[styles.selectedChip, { backgroundColor: theme.text }]}>
              <ThemedText type="small" style={{ color: theme.background }}>
                {selectedTradeName ?? 'All services'} ×
              </ThemedText>
            </Pressable>
          </ThemedView>
        )}

        {!showPicker && activeCaption ? (
          <ThemedView style={styles.captionBlock}>
            <ThemedText type="small" themeColor="textSecondary">
              {`Showing ${activeCaption.tradeName} for “${activeCaption.text}”`}
            </ThemedText>
            <Pressable accessibilityRole="button" hitSlop={8} onPress={clearSelection} style={styles.captionLink}>
              <ThemedText type="linkPrimary">Not right? Choose another</ThemedText>
            </Pressable>
          </ThemedView>
        ) : null}

        {!showPicker && isLoading ? (
          <ThemedView style={styles.loadingWrap}>
            <ActivityIndicator />
          </ThemedView>
        ) : null}

        {!showPicker && isCurrent && resolved?.status === 'error' ? (
          <ThemedView style={styles.stepBlock}>
            <ThemedText type="small" style={styles.formError}>
              Couldn&apos;t load results. Check your connection and try again.
            </ThemedText>
            <Button label="Try again" variant="soft" onPress={() => setRetryTick((t) => t + 1)} />
          </ThemedView>
        ) : null}

        {!showPicker && isCurrent && resolved?.status === 'ready' && resolved.rows.length === 0 ? (
          <ThemedView style={styles.stepBlock}>
            <ThemedText themeColor="textSecondary" style={styles.center}>
              No {selectedTradeName ?? 'traders'} vouched in {region.name} yet — be the first to invite
              one.
            </ThemedText>
            {session && profile ? (
              // Join-invite share (spec M3.6 empty state + M6.2 copy).
              <InviteAFriend label="Invite a trader" />
            ) : (
              // Search works logged out (spec M3) — the CTA routes into
              // sign-in/setup instead of calling create-invite sessionless.
              <Button
                label="Invite a trader"
                variant="soft"
                onPress={() => router.push(session ? '/profile-setup' : '/sign-in')}
              />
            )}
          </ThemedView>
        ) : null}

        {!showPicker && isCurrent && resolved?.status === 'ready' && resolved.rows.length > 0 ? (
          <ThemedView style={styles.resultsColumn}>
            {resolved.rows.map((row) => (
              <TraderCard key={row.trader_id} row={row} onPress={() => router.push(`/trader/${row.trader_id}`)} />
            ))}
          </ThemedView>
        ) : null}
      </ScrollView>
    </ThemedView>
  );
}

function TraderCard({ row, onPress }: { row: SearchRow; onPress: () => void }) {
  const theme = useTheme();
  const lapsed = row.status === 'lapsed';
  const photo = row.photo_url ?? row.avatar_url ?? null;
  const name = row.business_name || row.display_name || 'Trader';
  const tradeNames = row.trade_names ?? [];
  const shownTrades = tradeNames.slice(0, 2);
  const extraCount = tradeNames.length - shownTrades.length;
  const vouchLine = row.vouch_count > 0 ? `${row.vouch_count} vouches` : 'New on VOUCH';
  const friendCount = row.friend_vouch_count ?? 0;

  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={[styles.card, { backgroundColor: theme.backgroundElement, opacity: lapsed ? 0.6 : 1 }]}>
      {photo ? (
        <Image source={{ uri: photo }} style={styles.cardPhoto} contentFit="cover" />
      ) : (
        <ThemedView style={[styles.cardPhoto, styles.cardPhotoPlaceholder, { backgroundColor: theme.backgroundSelected }]}>
          <ThemedText type="small" themeColor="textSecondary">
            No photo
          </ThemedText>
        </ThemedView>
      )}
      <ThemedView style={styles.cardBody}>
        <ThemedView style={styles.cardHeaderRow}>
          <ThemedText type="smallBold" style={styles.cardName}>
            {name}
          </ThemedText>
          {lapsed ? (
            <ThemedView style={[styles.tag, { backgroundColor: theme.backgroundSelected }]}>
              <ThemedText type="small" themeColor="textSecondary">
                Listing inactive
              </ThemedText>
            </ThemedView>
          ) : null}
        </ThemedView>
        <ThemedView style={styles.chipList}>
          {shownTrades.map((t) => (
            <ThemedView key={t} style={[styles.miniChip, { backgroundColor: theme.backgroundSelected }]}>
              <ThemedText type="small">{t}</ThemedText>
            </ThemedView>
          ))}
          {extraCount > 0 ? (
            <ThemedView style={[styles.miniChip, { backgroundColor: theme.backgroundSelected }]}>
              <ThemedText type="small">+{extraCount} more</ThemedText>
            </ThemedView>
          ) : null}
        </ThemedView>
        <ThemedText type="small" themeColor="textSecondary">
          {regionNamesSummary(row.region_names)}
        </ThemedText>
        {friendCount > 0 ? (
          <ThemedText type="smallBold" style={styles.friendLine}>
            {friendCount} {friendCount === 1 ? 'person' : 'people'} you know
          </ThemedText>
        ) : null}
        <ThemedText type="small" themeColor="textSecondary">
          {vouchLine}
        </ThemedText>
      </ThemedView>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    flexDirection: 'row',
    justifyContent: 'center',
  },
  inner: {
    flex: 1,
    maxWidth: MaxContentWidth,
  },
  content: {
    padding: Spacing.four,
    gap: Spacing.four,
  },
  regionRow: {
    flexDirection: 'row',
    gap: Spacing.two,
    paddingVertical: Spacing.half,
  },
  stepBlock: {
    gap: Spacing.three,
  },
  resultsList: {
    gap: Spacing.two,
  },
  resultRow: {
    minHeight: 48,
    borderRadius: Spacing.three,
    paddingHorizontal: Spacing.three,
    justifyContent: 'center',
  },
  chipSection: {
    gap: Spacing.two,
  },
  chipList: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  selectedRow: {
    flexDirection: 'row',
  },
  selectedChip: {
    minHeight: 44,
    borderRadius: 22,
    paddingHorizontal: Spacing.three,
    justifyContent: 'center',
  },
  loadingWrap: {
    paddingVertical: Spacing.five,
    alignItems: 'center',
  },
  findingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  captionBlock: {
    gap: Spacing.one,
  },
  captionLink: {
    alignSelf: 'flex-start',
    minHeight: 44,
    justifyContent: 'center',
  },
  formError: {
    color: '#B3261E',
  },
  center: {
    textAlign: 'center',
  },
  resultsColumn: {
    gap: Spacing.three,
  },
  card: {
    flexDirection: 'row',
    gap: Spacing.three,
    borderRadius: Spacing.three,
    padding: Spacing.three,
  },
  cardPhoto: {
    width: 64,
    height: 64,
    borderRadius: Spacing.two,
  },
  cardPhotoPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardBody: {
    flex: 1,
    gap: Spacing.one,
  },
  cardHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  cardName: {
    flex: 1,
  },
  tag: {
    borderRadius: Spacing.two,
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.half,
  },
  miniChip: {
    minHeight: 28,
    borderRadius: 14,
    paddingHorizontal: Spacing.two,
    justifyContent: 'center',
  },
  friendLine: {
    fontSize: 15,
  },
});
