import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { TextField } from '@/components/ui/text-field';
import { ToggleChip } from '@/components/ui/toggle-chip';
import { BottomTabInset, MaxContentWidth, Spacing, WebTopTabBarInset } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useAuth } from '@/lib/auth';
import { ALL_TRINIDAD_REGION, initializeRegionFromProfile, useSelectedRegion } from '@/lib/region-state';
import { supabase } from '@/lib/supabase';

type RegionOption = { id: number; name: string };

/** Seeded order per spec M3.1 — the 6 real (non-"Proposed") trades.category values. */
const CATEGORIES = [
  'Home & Building',
  'Auto',
  'Personal & Home',
  'Tuition',
  'Events',
  'Tech & Office',
] as const;

export default function HomeScreen() {
  const router = useRouter();
  const theme = useTheme();
  const { session, profile, initializing } = useAuth();
  const [region, setRegion] = useSelectedRegion();
  const [regions, setRegions] = useState<RegionOption[]>([]);
  const [regionsExpanded, setRegionsExpanded] = useState(false);
  const [searchText, setSearchText] = useState('');

  useEffect(() => {
    supabase
      .from('regions')
      .select('id,name')
      .eq('enabled', true)
      .order('sort')
      .then(({ data }) => setRegions(data ?? []));
  }, []);

  // Default to the signed-in user's home region once (spec M3.1) unless the
  // visitor already picked a region themselves this session.
  useEffect(() => {
    if (!profile?.home_region_id || regions.length === 0) return;
    const match = regions.find((r) => r.id === profile.home_region_id);
    if (!match) return;
    initializeRegionFromProfile(
      match.id === ALL_TRINIDAD_REGION.id ? ALL_TRINIDAD_REGION : match,
    );
  }, [profile?.home_region_id, regions]);

  function goToSearch(extra: Record<string, string>) {
    router.push({ pathname: '/search', params: extra });
  }

  function pickRegion(next: RegionOption) {
    setRegion(next.id === ALL_TRINIDAD_REGION.id ? ALL_TRINIDAD_REGION : next);
    setRegionsExpanded(false);
  }

  function submitSearch() {
    const trimmed = searchText.trim();
    goToSearch(trimmed ? { q: trimmed } : {});
  }

  return (
    <ThemedView style={styles.container}>
      <SafeAreaView style={styles.safeArea}>
        <ScrollView
          style={styles.inner}
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled">
          <ThemedView style={styles.headerRow}>
            <ThemedText style={styles.wordmark}>VOUCH</ThemedText>
            {!initializing && !session ? (
              <Pressable accessibilityRole="button" hitSlop={8} onPress={() => router.push('/sign-in')}>
                <ThemedText type="linkPrimary">Sign in</ThemedText>
              </Pressable>
            ) : null}
          </ThemedView>

          <ThemedView style={styles.regionBlock}>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: regionsExpanded }}
              onPress={() => setRegionsExpanded((v) => !v)}
              style={[styles.regionRow, { backgroundColor: theme.backgroundElement }]}>
              <ThemedText>{region.name}</ThemedText>
              <ThemedText themeColor="textSecondary">{regionsExpanded ? '▴' : '▾'}</ThemedText>
            </Pressable>
            {regionsExpanded ? (
              <ThemedView style={styles.chipList}>
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
              </ThemedView>
            ) : null}
          </ThemedView>

          <TextField
            placeholder="What do you need? e.g. plumber"
            value={searchText}
            onChangeText={setSearchText}
            onFocus={submitSearch}
            onSubmitEditing={submitSearch}
            returnKeyType="search"
            autoCapitalize="none"
            autoCorrect={false}
          />

          <ThemedView style={styles.categoryGrid}>
            {CATEGORIES.map((category) => (
              <Pressable
                key={category}
                accessibilityRole="button"
                onPress={() => goToSearch({ category })}
                style={[styles.categoryTile, { backgroundColor: theme.backgroundElement }]}>
                <ThemedText type="smallBold" style={styles.center}>
                  {category}
                </ThemedText>
              </Pressable>
            ))}
          </ThemedView>
        </ScrollView>
      </SafeAreaView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    flexDirection: 'row',
    justifyContent: 'center',
  },
  safeArea: {
    flex: 1,
    width: '100%',
  },
  inner: {
    flex: 1,
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
    width: '100%',
  },
  content: {
    padding: Spacing.four,
    paddingTop: WebTopTabBarInset + Spacing.four,
    paddingBottom: BottomTabInset + Spacing.four,
    gap: Spacing.four,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  wordmark: {
    fontSize: 20,
    fontWeight: '700',
  },
  regionBlock: {
    gap: Spacing.two,
  },
  regionRow: {
    minHeight: 56,
    borderRadius: Spacing.three,
    paddingHorizontal: Spacing.three,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  chipList: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  categoryGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
  },
  categoryTile: {
    width: '48%',
    minHeight: 100,
    borderRadius: Spacing.three,
    marginBottom: Spacing.three,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.two,
  },
  center: {
    textAlign: 'center',
  },
});
