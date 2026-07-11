import { Image } from 'expo-image';
import { useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Button } from '@/components/ui/button';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { supabase } from '@/lib/supabase';
import { TRADER_PROFILE_SELECT, regionsSummary, tradeChipLabel, type TraderProfileWithJoins } from '@/lib/trader-profile';

type PublicProfile = {
  display_name: string | null;
  avatar_url: string | null;
  created_at: string | null;
};

type LoadState = 'loading' | 'not_found' | 'ready';

function formatMemberSince(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

export default function PublicTraderProfileScreen() {
  const theme = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [state, setState] = useState<LoadState>(() => (id ? 'loading' : 'not_found'));
  const [traderProfile, setTraderProfile] = useState<TraderProfileWithJoins | null>(null);
  const [publicProfile, setPublicProfile] = useState<PublicProfile | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    supabase
      .from('trader_profiles')
      .select(TRADER_PROFILE_SELECT)
      .eq('id', id)
      .maybeSingle()
      .then(async ({ data }) => {
        if (cancelled) return;
        const trader = data as unknown as TraderProfileWithJoins | null;
        if (!trader) {
          setState('not_found');
          return;
        }
        setTraderProfile(trader);
        const { data: pub } = await supabase
          .from('public_profiles')
          .select('display_name,avatar_url,created_at')
          .eq('id', trader.user_id)
          .single();
        if (cancelled) return;
        setPublicProfile(pub ?? null);
        setState('ready');
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (state === 'loading') {
    return (
      <ThemedView style={styles.container}>
        <ThemedView style={styles.loadingWrap}>
          <ActivityIndicator />
        </ThemedView>
      </ThemedView>
    );
  }

  if (state === 'not_found' || !traderProfile) {
    return (
      <ThemedView style={styles.container}>
        <ThemedView style={styles.loadingWrap}>
          <ThemedText themeColor="textSecondary">This listing isn&apos;t available.</ThemedText>
        </ThemedView>
      </ThemedView>
    );
  }

  const photoUrl = traderProfile.photo_url || publicProfile?.avatar_url || null;
  const displayName = traderProfile.business_name || publicProfile?.display_name || 'Trader';
  const isLapsed = traderProfile.status === 'lapsed';

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
            {publicProfile?.created_at ? (
              <ThemedText themeColor="textSecondary">
                Member since {formatMemberSince(publicProfile.created_at)}
              </ThemedText>
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
            Where they work
          </ThemedText>
          <ThemedText>{regionsSummary(traderProfile.trader_regions)}</ThemedText>
        </ThemedView>

        <ThemedView style={styles.block}>
          <ThemedText type="smallBold" themeColor="textSecondary">
            Vouches
          </ThemedText>
          <ThemedText themeColor="textSecondary">Vouches arrive in M5</ThemedText>
        </ThemedView>

        <ThemedView style={styles.actions}>
          <Button label="Call" disabled />
          <Button label="WhatsApp" variant="soft" disabled />
          <ThemedText type="small" themeColor="textSecondary" style={styles.center}>
            Contact arrives with the directory (M3)
          </ThemedText>
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
  center: {
    textAlign: 'center',
  },
});
