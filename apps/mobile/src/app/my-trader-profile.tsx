import { Image } from 'expo-image';
import { Redirect, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Button } from '@/components/ui/button';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import {
  TRADER_PROFILE_SELECT,
  regionsSummary,
  tradeChipLabel,
  type TraderProfileWithJoins,
} from '@/lib/trader-profile';

function formatFreeUntil(dateStr: string): string {
  const date = new Date(`${dateStr}T00:00:00`);
  return date.toLocaleDateString('en-US', { day: 'numeric', month: 'long', year: 'numeric' });
}

function statusLine(profile: TraderProfileWithJoins): string {
  if (profile.status === 'active') return `Free until ${formatFreeUntil(profile.free_until)}`;
  if (profile.status === 'lapsed') return 'Your listing is inactive — free period ended';
  return 'Your listing is hidden. Contact support.';
}

export default function MyTraderProfileScreen() {
  const router = useRouter();
  const theme = useTheme();
  const { session, profile: userProfile, initializing } = useAuth();
  const [traderProfile, setTraderProfile] = useState<TraderProfileWithJoins | null>(null);
  const [checked, setChecked] = useState(false);
  const [vouchCount, setVouchCount] = useState<number | null>(null);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    supabase
      .from('trader_profiles')
      .select(TRADER_PROFILE_SELECT)
      .eq('user_id', session.user.id)
      .maybeSingle()
      .then(({ data }) => {
        if (cancelled) return;
        setTraderProfile(data as unknown as TraderProfileWithJoins | null);
        setChecked(true);
      });
    return () => {
      cancelled = true;
    };
  }, [session]);

  useEffect(() => {
    if (!traderProfile) return;
    let cancelled = false;
    supabase
      .from('vouches')
      .select('id', { count: 'exact', head: true })
      .eq('trader_id', traderProfile.id)
      .eq('status', 'published')
      .then(({ count }) => {
        if (cancelled) return;
        setVouchCount(count ?? 0);
      });
    return () => {
      cancelled = true;
    };
  }, [traderProfile]);

  if (!initializing && !session) return <Redirect href="/sign-in" />;
  if (checked && !traderProfile) return <Redirect href="/become-a-trader" />;

  if (initializing || !session || !checked || !traderProfile) {
    return (
      <ThemedView style={styles.container}>
        <ThemedView style={styles.loadingWrap}>
          <ActivityIndicator />
        </ThemedView>
      </ThemedView>
    );
  }

  const displayName = traderProfile.business_name || userProfile?.display_name || 'Your listing';

  return (
    <ThemedView style={styles.container}>
      <ScrollView style={styles.inner} contentContainerStyle={styles.content}>
        <ThemedView style={styles.header}>
          {traderProfile.photo_url ? (
            <Image source={{ uri: traderProfile.photo_url }} style={styles.photo} contentFit="cover" />
          ) : (
            <ThemedView style={[styles.photo, styles.photoPlaceholder, { backgroundColor: theme.backgroundElement }]}>
              <ThemedText themeColor="textSecondary">No photo</ThemedText>
            </ThemedView>
          )}
          <ThemedView style={styles.headerText}>
            <ThemedText type="subtitle">{displayName}</ThemedText>
            <ThemedText themeColor="textSecondary">{statusLine(traderProfile)}</ThemedText>
            {vouchCount !== null ? (
              <ThemedText themeColor="textSecondary">{vouchCount} vouches received</ThemedText>
            ) : null}
          </ThemedView>
        </ThemedView>

        {traderProfile.bio ? <ThemedText>{traderProfile.bio}</ThemedText> : null}

        <ThemedView style={styles.block}>
          <ThemedText type="smallBold" themeColor="textSecondary">
            Services
          </ThemedText>
          <ThemedView style={styles.chipList}>
            {traderProfile.trader_trades.map((join) => (
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
            Where you work
          </ThemedText>
          <ThemedText>{regionsSummary(traderProfile.trader_regions)}</ThemedText>
        </ThemedView>

        <ThemedView style={styles.actions}>
          <Button label="Ask for vouches" onPress={() => router.push('/ask-for-vouches')} />
          <Button label="Edit listing" onPress={() => router.push('/become-a-trader')} />
          <Button
            label="View public profile"
            variant="soft"
            onPress={() => router.push(`/trader/${traderProfile.id}`)}
          />
          {/* Spec M9.2 — private block list; nobody but this trader sees it. */}
          <Button
            label="Blocked numbers"
            variant="soft"
            onPress={() => router.push('/blocked-numbers')}
          />
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
});
