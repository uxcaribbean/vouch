import type { Tables } from '@vouch/shared';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { Redirect, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Button } from '@/components/ui/button';
import { TextField } from '@/components/ui/text-field';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useAuth } from '@/lib/auth';
import { invokeFunction, supabase } from '@/lib/supabase';
import {
  ALL_TRINIDAD_REGION_ID,
  TRADER_PROFILE_SELECT,
  type TraderProfileWithJoins,
} from '@/lib/trader-profile';

type TradeOption = Pick<Tables<'trades'>, 'id' | 'name' | 'slug' | 'category' | 'keywords' | 'status'>;
type RegionOption = Pick<Tables<'regions'>, 'id' | 'name'>;
type SelectedTrade = { id: number; name: string; status: string };

const MAX_TOTAL_TRADES = 5;
const MAX_NEW_TRADES = 3;

const ERROR_COPY: Record<string, string> = {
  invalid_input: "Something on this form isn't quite right. Check each step and try again.",
  unknown_trade: "One of the services you picked isn't available anymore. Go back and pick it again.",
  invalid_region: "One of the regions you picked isn't available right now. Go back and pick again.",
  invalid_proposed_trade: 'That service name needs at least 3 plain letters — try again.',
  profile_locked: 'Your listing is locked by an admin. Contact support to make changes.',
};
const FALLBACK_ERROR = 'Something went wrong saving your listing. Try again.';

export default function BecomeATraderScreen() {
  const router = useRouter();
  const theme = useTheme();
  const { session, profile, initializing } = useAuth();

  const [step, setStep] = useState<1 | 2 | 3>(1);

  const [trades, setTrades] = useState<TradeOption[]>([]);
  const [tradesLoaded, setTradesLoaded] = useState(false);
  const [regions, setRegions] = useState<RegionOption[]>([]);
  const [regionsLoaded, setRegionsLoaded] = useState(false);
  const [existingChecked, setExistingChecked] = useState(false);
  const [existingId, setExistingId] = useState<string | null>(null);

  const [query, setQuery] = useState('');
  const [selectedTrades, setSelectedTrades] = useState<SelectedTrade[]>([]);
  const [newProposedTrades, setNewProposedTrades] = useState<string[]>([]);
  const [step1Error, setStep1Error] = useState<string | null>(null);

  const [selectedRegionIds, setSelectedRegionIds] = useState<number[]>([]);
  const [step2Error, setStep2Error] = useState<string | null>(null);

  const [businessName, setBusinessName] = useState('');
  const [bio, setBio] = useState('');
  const [photoPreviewUri, setPhotoPreviewUri] = useState<string | null>(null);
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [photoUploading, setPhotoUploading] = useState(false);
  const [photoWarning, setPhotoWarning] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    supabase
      .from('trades')
      .select('id,name,slug,category,keywords,status')
      .in('status', ['active', 'proposed'])
      .order('name')
      .then(({ data }) => {
        setTrades(data ?? []);
        setTradesLoaded(true);
      });
  }, []);

  useEffect(() => {
    supabase
      .from('regions')
      .select('id,name')
      .eq('enabled', true)
      .order('sort')
      .then(({ data }) => {
        setRegions(data ?? []);
        setRegionsLoaded(true);
      });
  }, []);

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
        const existing = data as unknown as TraderProfileWithJoins | null;
        if (existing) {
          setExistingId(existing.id);
          setBusinessName(existing.business_name ?? '');
          setBio(existing.bio ?? '');
          setPhotoUrl(existing.photo_url ?? null);
          setPhotoPreviewUri(existing.photo_url ?? null);
          setSelectedTrades(
            existing.trader_trades.map((t) => ({
              id: t.trade_id,
              name: t.trades?.name ?? 'Service',
              status: t.trades?.status ?? 'active',
            })),
          );
          setSelectedRegionIds(existing.trader_regions.map((r) => r.region_id));
        }
        setExistingChecked(true);
      });
    return () => {
      cancelled = true;
    };
  }, [session]);

  if (!initializing && !session) return <Redirect href="/sign-in" />;
  if (!initializing && session && !profile) return <Redirect href="/profile-setup" />;

  const ready = tradesLoaded && regionsLoaded && existingChecked;
  if (initializing || !session || !profile || !ready) {
    return (
      <ThemedView style={styles.container}>
        <ThemedView style={styles.loadingWrap}>
          <ActivityIndicator />
        </ThemedView>
      </ThemedView>
    );
  }

  const selectedCount = selectedTrades.length + newProposedTrades.length;
  const atMax = selectedCount >= MAX_TOTAL_TRADES;
  const normalizedQuery = query.trim().toLowerCase();
  const searchActive = normalizedQuery.length > 0 && !atMax;
  const matches = (trade: Pick<TradeOption, 'name' | 'keywords'>) =>
    `${trade.name} ${(trade.keywords ?? []).join(' ')}`.toLowerCase().includes(normalizedQuery);
  const filteredResults = searchActive
    ? trades.filter((t) => !selectedTrades.some((s) => s.id === t.id) && matches(t)).slice(0, 20)
    : [];
  const hasAnyMatch = normalizedQuery.length > 0 && trades.some(matches);
  const showAddNew =
    searchActive && normalizedQuery.length >= 3 && !hasAnyMatch && newProposedTrades.length < MAX_NEW_TRADES;

  function addTrade(trade: TradeOption) {
    if (selectedTrades.length + newProposedTrades.length >= MAX_TOTAL_TRADES) return;
    if (selectedTrades.some((t) => t.id === trade.id)) return;
    setSelectedTrades((prev) => [...prev, { id: trade.id, name: trade.name, status: trade.status }]);
    setQuery('');
    setStep1Error(null);
  }

  function removeTrade(id: number) {
    setSelectedTrades((prev) => prev.filter((t) => t.id !== id));
  }

  function addProposedTrade() {
    const trimmed = query.trim();
    if (trimmed.length < 3) return;
    if (selectedTrades.length + newProposedTrades.length >= MAX_TOTAL_TRADES) return;
    if (newProposedTrades.length >= MAX_NEW_TRADES) return;
    if (newProposedTrades.some((p) => p.toLowerCase() === trimmed.toLowerCase())) {
      setQuery('');
      return;
    }
    setNewProposedTrades((prev) => [...prev, trimmed]);
    setQuery('');
    setStep1Error(null);
  }

  function removeProposed(name: string) {
    setNewProposedTrades((prev) => prev.filter((p) => p !== name));
  }

  function toggleRegion(id: number) {
    setStep2Error(null);
    if (id === ALL_TRINIDAD_REGION_ID) {
      setSelectedRegionIds((prev) => (prev.includes(ALL_TRINIDAD_REGION_ID) ? [] : [ALL_TRINIDAD_REGION_ID]));
      return;
    }
    setSelectedRegionIds((prev) => {
      const withoutAll = prev.filter((r) => r !== ALL_TRINIDAD_REGION_ID);
      return withoutAll.includes(id) ? withoutAll.filter((r) => r !== id) : [...withoutAll, id];
    });
  }

  async function pickPhoto() {
    setPhotoWarning(null);
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      setPhotoWarning('Allow photo access in your phone settings to add a picture.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 0.7,
      allowsEditing: true,
      aspect: [1, 1],
    });
    if (result.canceled || !result.assets[0]) return;
    const uri = result.assets[0].uri;
    setPhotoPreviewUri(uri);
    if (!session) return;
    setPhotoUploading(true);
    try {
      const response = await fetch(uri);
      const bytes = await response.arrayBuffer();
      const path = `${session.user.id}/trader-${Date.now()}.jpg`;
      const { error: uploadError } = await supabase.storage.from('avatars').upload(path, bytes, {
        contentType: 'image/jpeg',
        upsert: true,
      });
      if (uploadError) throw uploadError;
      const { data } = supabase.storage.from('avatars').getPublicUrl(path);
      setPhotoUrl(data.publicUrl);
    } catch {
      setPhotoWarning("Couldn't upload that photo — you can still save your listing without one.");
      setPhotoUrl(null);
    } finally {
      setPhotoUploading(false);
    }
  }

  function goNext() {
    if (step === 1) {
      if (selectedCount < 1) {
        setStep1Error('Pick at least one service to continue.');
        return;
      }
      setStep1Error(null);
      setStep(2);
      return;
    }
    if (step === 2) {
      if (selectedRegionIds.length === 0) {
        setStep2Error('Pick at least one region.');
        return;
      }
      setStep2Error(null);
      setStep(3);
    }
  }

  function goBack() {
    setFormError(null);
    setStep((s) => (s === 3 ? 2 : 1));
  }

  async function submit() {
    if (!session) return;
    setFormError(null);
    setBusy(true);
    const { errorCode } = await invokeFunction<{ profile: TraderProfileWithJoins; created: boolean }>(
      'upsert-trader-profile',
      {
        business_name: businessName.trim() || undefined,
        bio: bio.trim() || undefined,
        photo_url: photoUrl ?? undefined,
        trade_ids: selectedTrades.map((t) => t.id),
        proposed_trades: newProposedTrades,
        region_ids: selectedRegionIds,
      },
    );
    setBusy(false);
    if (errorCode) {
      setFormError(ERROR_COPY[errorCode] ?? FALLBACK_ERROR);
      return;
    }
    router.replace('/my-trader-profile');
  }

  return (
    <ThemedView style={styles.container}>
      <ScrollView
        style={styles.inner}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled">
        <ThemedText type="small" themeColor="textSecondary">
          Step {step} of 3
        </ThemedText>

        {step === 1 ? (
          <ThemedView style={styles.stepBlock}>
            <ThemedText type="subtitle">What do you do?</ThemedText>
            <ThemedText themeColor="textSecondary">
              Pick up to 5 services people can find you for.
            </ThemedText>

            <TextField
              placeholder="e.g. plumber, AC repair, gardener"
              value={query}
              onChangeText={setQuery}
              autoCapitalize="none"
              autoCorrect={false}
            />

            {atMax ? (
              <ThemedText type="small" themeColor="textSecondary">
                You&apos;ve picked the most services (5) allowed for one listing.
              </ThemedText>
            ) : null}

            {searchActive ? (
              <ThemedView style={styles.resultsList}>
                {filteredResults.map((trade) => (
                  <Pressable
                    key={trade.id}
                    accessibilityRole="button"
                    onPress={() => addTrade(trade)}
                    style={[styles.resultRow, { backgroundColor: theme.backgroundElement }]}>
                    <ThemedText>{trade.name}</ThemedText>
                  </Pressable>
                ))}
                {showAddNew ? (
                  <Pressable
                    accessibilityRole="button"
                    onPress={addProposedTrade}
                    style={[styles.resultRow, styles.addNewRow, { borderColor: theme.text }]}>
                    <ThemedText>Add &quot;{query.trim()}&quot; as a new service</ThemedText>
                  </Pressable>
                ) : null}
                {filteredResults.length === 0 && !showAddNew ? (
                  <ThemedText type="small" themeColor="textSecondary">
                    {normalizedQuery.length < 3
                      ? 'Keep typing — at least 3 letters to add a new service.'
                      : "That service already has a match above, or you've reached the new-service limit."}
                  </ThemedText>
                ) : null}
              </ThemedView>
            ) : null}

            <ThemedView style={styles.chipSection}>
              <ThemedText type="smallBold" themeColor="textSecondary">
                {selectedCount} of 5 picked
              </ThemedText>
              <ThemedView style={styles.chipList}>
                {selectedTrades.map((t) => (
                  <SelectedChip
                    key={`trade-${t.id}`}
                    label={t.status === 'proposed' ? `${t.name} (new)` : t.name}
                    onRemove={() => removeTrade(t.id)}
                  />
                ))}
                {newProposedTrades.map((name) => (
                  <SelectedChip key={`new-${name}`} label={`${name} (new)`} onRemove={() => removeProposed(name)} />
                ))}
              </ThemedView>
            </ThemedView>

            {step1Error ? (
              <ThemedText type="small" style={styles.formError}>
                {step1Error}
              </ThemedText>
            ) : null}
          </ThemedView>
        ) : null}

        {step === 2 ? (
          <ThemedView style={styles.stepBlock}>
            <ThemedText type="subtitle">Where do you work?</ThemedText>
            <ThemedText themeColor="textSecondary">
              Pick the areas you serve, or go island-wide.
            </ThemedText>

            <ThemedView style={styles.chipList}>
              <ToggleChip
                label="All Trinidad"
                selected={selectedRegionIds.includes(ALL_TRINIDAD_REGION_ID)}
                onPress={() => toggleRegion(ALL_TRINIDAD_REGION_ID)}
              />
              {regions
                .filter((r) => r.id !== ALL_TRINIDAD_REGION_ID)
                .map((region) => (
                  <ToggleChip
                    key={region.id}
                    label={region.name}
                    selected={selectedRegionIds.includes(region.id)}
                    onPress={() => toggleRegion(region.id)}
                  />
                ))}
            </ThemedView>

            {step2Error ? (
              <ThemedText type="small" style={styles.formError}>
                {step2Error}
              </ThemedText>
            ) : null}
          </ThemedView>
        ) : null}

        {step === 3 ? (
          <ThemedView style={styles.stepBlock}>
            <ThemedText type="subtitle">Your listing</ThemedText>

            <TextField
              label="Business name (optional)"
              placeholder={profile.display_name}
              value={businessName}
              onChangeText={setBusinessName}
              maxLength={80}
            />

            <ThemedView style={styles.bioWrap}>
              <TextField
                label="About you / your work (optional)"
                placeholder="Tell people what you do and why they should call you."
                value={bio}
                onChangeText={setBio}
                maxLength={300}
                multiline
                style={styles.bioInput}
              />
              <ThemedText type="small" themeColor="textSecondary" style={styles.counter}>
                {bio.length}/300
              </ThemedText>
            </ThemedView>

            <ThemedView style={styles.photoSection}>
              <ThemedText type="smallBold" themeColor="textSecondary">
                Photo (optional)
              </ThemedText>
              {photoPreviewUri ? (
                <Image source={{ uri: photoPreviewUri }} style={styles.photoPreview} contentFit="cover" />
              ) : (
                <ThemedView style={[styles.photoPlaceholder, { backgroundColor: theme.backgroundElement }]}>
                  <ThemedText themeColor="textSecondary">No photo yet</ThemedText>
                </ThemedView>
              )}
              <Button
                label={photoPreviewUri ? 'Change photo' : 'Add a photo'}
                variant="soft"
                onPress={pickPhoto}
                loading={photoUploading}
              />
              {photoWarning ? (
                <ThemedText type="small" style={styles.formError}>
                  {photoWarning}
                </ThemedText>
              ) : null}
            </ThemedView>

            {formError ? (
              <ThemedText type="small" style={styles.formError}>
                {formError}
              </ThemedText>
            ) : null}
          </ThemedView>
        ) : null}

        <ThemedView style={styles.footer}>
          {step > 1 ? (
            <ThemedView style={styles.footerButton}>
              <Button label="Back" variant="soft" onPress={goBack} />
            </ThemedView>
          ) : null}
          <ThemedView style={styles.footerButton}>
            <Button
              label={step === 3 ? (existingId ? 'Save changes' : 'Save my listing') : 'Continue'}
              onPress={step === 3 ? submit : goNext}
              loading={busy}
            />
          </ThemedView>
        </ThemedView>
      </ScrollView>
    </ThemedView>
  );
}

function SelectedChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onRemove}
      accessibilityRole="button"
      accessibilityLabel={`Remove ${label}`}
      style={[styles.chip, { backgroundColor: theme.text }]}>
      <ThemedText type="small" style={{ color: theme.background }}>
        {label} ×
      </ThemedText>
    </Pressable>
  );
}

function ToggleChip({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: selected }}
      style={[styles.chip, { backgroundColor: selected ? theme.text : theme.backgroundElement }]}>
      <ThemedText type="small" style={{ color: selected ? theme.background : theme.text }}>
        {label}
      </ThemedText>
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
  loadingWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
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
  addNewRow: {
    borderWidth: 1,
    borderStyle: 'dashed',
  },
  chipSection: {
    gap: Spacing.two,
  },
  chipList: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  chip: {
    minHeight: 44,
    borderRadius: 22,
    paddingHorizontal: Spacing.three,
    justifyContent: 'center',
  },
  bioWrap: {
    gap: Spacing.one,
  },
  bioInput: {
    minHeight: 100,
    textAlignVertical: 'top',
  },
  counter: {
    textAlign: 'right',
  },
  photoSection: {
    gap: Spacing.two,
  },
  photoPreview: {
    width: 96,
    height: 96,
    borderRadius: Spacing.three,
  },
  photoPlaceholder: {
    width: 96,
    height: 96,
    borderRadius: Spacing.three,
    alignItems: 'center',
    justifyContent: 'center',
  },
  formError: {
    color: '#B3261E',
  },
  footer: {
    flexDirection: 'row',
    gap: Spacing.three,
  },
  footerButton: {
    flex: 1,
  },
});
