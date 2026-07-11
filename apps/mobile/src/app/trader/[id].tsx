import { Image } from 'expo-image';
import { useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
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

type LoadState = 'loading' | 'not_found' | 'ready';

function formatMemberSince(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

export default function PublicTraderProfileScreen() {
  const theme = useTheme();
  const { session } = useAuth();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [state, setState] = useState<LoadState>(() => (id ? 'loading' : 'not_found'));
  const [directory, setDirectory] = useState<DirectoryRow | null>(null);
  const [joins, setJoins] = useState<TraderProfileWithJoins | null>(null);
  const [showReportNote, setShowReportNote] = useState(false);

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
          <ThemedText type="smallBold" themeColor="textSecondary">
            Vouches
          </ThemedText>
          <ThemedText themeColor="textSecondary">Vouches arrive in M5</ThemedText>
        </ThemedView>

        {!isLapsed && directory.phone_e164 ? (
          <ThemedView style={styles.actions}>
            <Button label="Call" onPress={handleCall} />
            <Button label="WhatsApp" variant="soft" onPress={handleWhatsApp} />
          </ThemedView>
        ) : null}

        <ThemedView style={styles.actions}>
          <Button label="Vouch for this trader" disabled />
          <ThemedText type="small" themeColor="textSecondary" style={styles.center}>
            (arrives in M5)
          </ThemedText>
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
  center: {
    textAlign: 'center',
  },
  reportBlock: {
    gap: Spacing.one,
  },
  reportRow: {
    minHeight: 44,
    justifyContent: 'center',
  },
});
