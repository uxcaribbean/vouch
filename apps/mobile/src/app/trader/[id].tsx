import type { Tables } from '@vouch/shared';
import { Image } from 'expo-image';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, ScrollView, StyleSheet } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Button } from '@/components/ui/button';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { trackEvent } from '@/lib/analytics';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import { TRADER_PROFILE_SELECT, regionsSummary, tradeChipLabel, type TraderProfileWithJoins } from '@/lib/trader-profile';

type DirectoryRow = {
  trader_id: string;
  status: string;
  business_name: string | null;
  bio: string | null;
  photo_url: string | null;
  created_at: string | null;
  display_name: string | null;
  avatar_url: string | null;
  phone_e164: string | null;
};

type VouchRow = Pick<Tables<'vouches'>, 'id' | 'voucher_user_id' | 'trade_id' | 'comment' | 'created_at' | 'status'>;
type VoucherProfile = Pick<Tables<'public_profiles'>, 'id' | 'display_name'>;

/** trader_summary's Returns type is untyped Json server-side (packages/shared) — this is its real shape (scripts/acceptance/test-m4.mjs). */
type TraderSummary = {
  vouch_count_total: number;
  vouch_count_by_trade: Record<string, number>;
  friend_vouch_count: number;
  friend_voucher_names: string[];
};

type LoadState = 'loading' | 'not_found' | 'ready';

function formatMemberSince(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

function formatVouchDate(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** Spec M4.3 — names come from the platform (voucher display names), never the viewer's address book. */
function friendBlockText(names: string[], friendCount: number): string | null {
  if (friendCount <= 0 || names.length === 0) return null;
  const suffix =
    friendCount > names.length
      ? ` and ${friendCount - names.length} others you know`
      : friendCount > 1 && names.length > 1
        ? ' — people you know'
        : ' — someone you know';
  return `Vouched for by ${joinNames(names)}${suffix}`;
}

export default function PublicTraderProfileScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { session, profile } = useAuth();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [state, setState] = useState<LoadState>(() => (id ? 'loading' : 'not_found'));
  const [directory, setDirectory] = useState<DirectoryRow | null>(null);
  const [joins, setJoins] = useState<TraderProfileWithJoins | null>(null);
  const [showReportNote, setShowReportNote] = useState(false);
  const [vouches, setVouches] = useState<VouchRow[]>([]);
  const [voucherProfiles, setVoucherProfiles] = useState<Record<string, VoucherProfile>>({});
  const [summary, setSummary] = useState<TraderSummary | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    Promise.all([
      supabase
        .from('trader_directory')
        .select('trader_id,user_id,status,business_name,bio,photo_url,created_at,display_name,avatar_url,phone_e164')
        .eq('trader_id', id)
        .maybeSingle(),
      supabase.from('trader_profiles').select(TRADER_PROFILE_SELECT).eq('id', id).maybeSingle(),
    ]).then(([directoryRes, joinsRes]) => {
      if (cancelled) return;
      if (!directoryRes.data) {
        setState('not_found');
        return;
      }
      setDirectory(directoryRes.data as DirectoryRow);
      setJoins((joinsRes.data as unknown as TraderProfileWithJoins) ?? null);
      setState('ready');
    });
    return () => {
      cancelled = true;
    };
  }, [id]);

  // Refetched on every focus (not just mount) so a vouch just submitted or
  // removed in the M5 composer is reflected immediately on Back.
  useFocusEffect(
    useCallback(() => {
      if (!id) return;
      let cancelled = false;
      Promise.all([
        supabase
          .from('vouches')
          .select('id,voucher_user_id,trade_id,comment,created_at,status')
          .eq('trader_id', id)
          .eq('status', 'published')
          .order('created_at', { ascending: false }),
        supabase.rpc('trader_summary', { p_trader_id: id }),
      ]).then(async ([vouchesRes, summaryRes]) => {
        if (cancelled) return;
        const rows = (vouchesRes.data ?? []) as VouchRow[];
        setVouches(rows);
        setSummary((summaryRes.data as unknown as TraderSummary | null) ?? null);
        const voucherIds = Array.from(new Set(rows.map((r) => r.voucher_user_id)));
        if (voucherIds.length === 0) {
          setVoucherProfiles({});
          return;
        }
        const { data: profiles } = await supabase
          .from('public_profiles')
          .select('id,display_name')
          .in('id', voucherIds);
        if (cancelled) return;
        const map: Record<string, VoucherProfile> = {};
        (profiles ?? []).forEach((p) => {
          if (p.id) map[p.id] = p as VoucherProfile;
        });
        setVoucherProfiles(map);
      });
      return () => {
        cancelled = true;
      };
    }, [id]),
  );

  if (state === 'loading') {
    return (
      <ThemedView style={styles.container}>
        <ThemedView style={styles.loadingWrap}>
          <ActivityIndicator />
        </ThemedView>
      </ThemedView>
    );
  }

  if (state === 'not_found' || !directory) {
    return (
      <ThemedView style={styles.container}>
        <ThemedView style={styles.loadingWrap}>
          <ThemedText themeColor="textSecondary">This listing isn&apos;t available.</ThemedText>
        </ThemedView>
      </ThemedView>
    );
  }

  const photoUrl = directory.photo_url || directory.avatar_url || null;
  const displayName = directory.business_name || directory.display_name || 'Trader';
  const isLapsed = directory.status === 'lapsed';
  const traderId = directory.trader_id ?? id;
  const ownVouch = session ? vouches.find((v) => v.voucher_user_id === session.user.id) : undefined;

  function handleVouchPress() {
    if (!session) {
      router.push('/sign-in');
      return;
    }
    if (ownVouch) {
      router.push({ pathname: '/vouch/[traderId]', params: { traderId, trade: String(ownVouch.trade_id) } });
      return;
    }
    router.push({ pathname: '/vouch/[traderId]', params: { traderId } });
  }

  function handleCall() {
    if (!directory?.phone_e164) return;
    void trackEvent(session, 'contact_tapped', { trader_id: traderId, channel: 'call' });
    void Linking.openURL(`tel:${directory.phone_e164}`);
  }

  function handleWhatsApp() {
    if (!directory?.phone_e164) return;
    void trackEvent(session, 'contact_tapped', { trader_id: traderId, channel: 'whatsapp' });
    void Linking.openURL(`https://wa.me/${directory.phone_e164.replace('+', '')}`);
  }

  return (
    <ThemedView style={styles.container}>
      <ScrollView style={styles.inner} contentContainerStyle={styles.content}>
        {isLapsed ? (
          <ThemedView style={[styles.banner, { backgroundColor: theme.backgroundElement }]}>
            <ThemedText type="small" themeColor="textSecondary">
              This trader&apos;s listing is inactive
            </ThemedText>
          </ThemedView>
        ) : null}

        <ThemedView style={styles.header}>
          {photoUrl ? (
            <Image source={{ uri: photoUrl }} style={styles.photo} contentFit="cover" />
          ) : (
            <ThemedView style={[styles.photo, styles.photoPlaceholder, { backgroundColor: theme.backgroundElement }]}>
              <ThemedText themeColor="textSecondary">No photo</ThemedText>
            </ThemedView>
          )}
          <ThemedView style={styles.headerText}>
            <ThemedText type="subtitle">{displayName}</ThemedText>
            {directory.created_at ? (
              <ThemedText themeColor="textSecondary">
                Member since {formatMemberSince(directory.created_at)}
              </ThemedText>
            ) : null}
          </ThemedView>
        </ThemedView>

        {directory.bio ? <ThemedText>{directory.bio}</ThemedText> : null}

        <ThemedView style={styles.block}>
          <ThemedText type="smallBold" themeColor="textSecondary">
            Services
          </ThemedText>
          <ThemedView style={styles.chipList}>
            {(joins?.trader_trades ?? []).map((join) => (
              <ThemedView
                key={join.trade_id}
                style={[styles.chip, { backgroundColor: theme.backgroundElement }]}>
                <ThemedText type="small">{tradeChipLabel(join)}</ThemedText>
              </ThemedView>
            ))}
          </ThemedView>
        </ThemedView>

        <ThemedView style={styles.block}>
          <ThemedText type="smallBold" themeColor="textSecondary">
            Where they work
          </ThemedText>
          <ThemedText>{regionsSummary(joins?.trader_regions ?? [])}</ThemedText>
        </ThemedView>

        <ThemedView style={styles.block}>
          <ThemedText type="subtitle">
            {(summary?.vouch_count_total ?? vouches.length) > 0
              ? `${summary?.vouch_count_total ?? vouches.length} vouches`
              : 'New on VOUCH — no vouches yet'}
          </ThemedText>
          {summary && friendBlockText(summary.friend_voucher_names, summary.friend_vouch_count) ? (
            <ThemedView style={[styles.friendBlock, { backgroundColor: theme.backgroundSelected }]}>
              <ThemedText type="smallBold">
                {friendBlockText(summary.friend_voucher_names, summary.friend_vouch_count)}
              </ThemedText>
            </ThemedView>
          ) : session && profile && !profile.contact_sync_enabled ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => router.push('/sync-contacts')}
              style={[styles.nudgeRow, { backgroundColor: theme.backgroundElement }]}>
              <ThemedText type="small" themeColor="textSecondary">
                Sync contacts to see if anyone you know vouches for people like this
              </ThemedText>
            </Pressable>
          ) : null}
          {vouches.length > 0 ? (
            <ThemedView style={styles.vouchList}>
              {vouches.map((v) => {
                const voucherName = voucherProfiles[v.voucher_user_id]?.display_name ?? 'A member';
                const tradeName =
                  (joins?.trader_trades ?? []).find((t) => t.trade_id === v.trade_id)?.trades?.name ?? 'Service';
                return (
                  <ThemedView key={v.id} style={[styles.vouchCard, { backgroundColor: theme.backgroundElement }]}>
                    <ThemedView style={styles.vouchHeaderRow}>
                      <ThemedText type="smallBold" style={styles.vouchName}>
                        {voucherName}
                      </ThemedText>
                      <ThemedText type="small" themeColor="textSecondary">
                        {formatVouchDate(v.created_at)}
                      </ThemedText>
                    </ThemedView>
                    <ThemedView style={[styles.miniChip, { backgroundColor: theme.backgroundSelected }]}>
                      <ThemedText type="small">{tradeName}</ThemedText>
                    </ThemedView>
                    {v.comment ? <ThemedText type="small">{v.comment}</ThemedText> : null}
                  </ThemedView>
                );
              })}
            </ThemedView>
          ) : null}
        </ThemedView>

        {!isLapsed && directory.phone_e164 ? (
          <ThemedView style={styles.actions}>
            <Button label="Call" onPress={handleCall} />
            <Button label="WhatsApp" variant="soft" onPress={handleWhatsApp} />
          </ThemedView>
        ) : null}

        <ThemedView style={styles.actions}>
          <Button
            label={ownVouch ? 'Update your vouch ✓' : 'Vouch for this trader'}
            variant={ownVouch ? 'soft' : 'solid'}
            onPress={handleVouchPress}
          />
        </ThemedView>

        <ThemedView style={styles.reportBlock}>
          <Pressable
            accessibilityRole="button"
            onPress={() => setShowReportNote((v) => !v)}
            style={styles.reportRow}>
            <ThemedText type="small" themeColor="textSecondary">
              Report this listing
            </ThemedText>
          </Pressable>
          {showReportNote ? (
            <ThemedText type="small" themeColor="textSecondary">
              (reporting arrives in M9)
            </ThemedText>
          ) : null}
        </ThemedView>
      </ScrollView>
    </ThemedView>
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
  loadingWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  banner: {
    borderRadius: Spacing.three,
    padding: Spacing.three,
  },
  header: {
    flexDirection: 'row',
    gap: Spacing.three,
    alignItems: 'center',
  },
  headerText: {
    flex: 1,
    gap: Spacing.one,
  },
  photo: {
    width: 72,
    height: 72,
    borderRadius: Spacing.three,
  },
  photoPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  block: {
    gap: Spacing.two,
  },
  chipList: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  chip: {
    minHeight: 36,
    borderRadius: 18,
    paddingHorizontal: Spacing.three,
    justifyContent: 'center',
  },
  actions: {
    gap: Spacing.three,
  },
  friendBlock: {
    borderRadius: Spacing.three,
    padding: Spacing.three,
  },
  nudgeRow: {
    minHeight: 44,
    borderRadius: Spacing.three,
    paddingHorizontal: Spacing.three,
    justifyContent: 'center',
  },
  vouchList: {
    gap: Spacing.two,
  },
  vouchCard: {
    borderRadius: Spacing.three,
    padding: Spacing.three,
    gap: Spacing.two,
  },
  vouchHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  vouchName: {
    flex: 1,
  },
  miniChip: {
    alignSelf: 'flex-start',
    minHeight: 28,
    borderRadius: 14,
    paddingHorizontal: Spacing.two,
    justifyContent: 'center',
  },
  reportBlock: {
    gap: Spacing.one,
  },
  reportRow: {
    minHeight: 44,
    justifyContent: 'center',
  },
});
