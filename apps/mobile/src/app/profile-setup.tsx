import { isValidReferralCode, type Tables } from '@vouch/shared';
import { Redirect, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Button } from '@/components/ui/button';
import { TextField } from '@/components/ui/text-field';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useAuth } from '@/lib/auth';
import { invokeFunction, supabase } from '@/lib/supabase';

type Region = Pick<Tables<'regions'>, 'id' | 'name'>;

export default function ProfileSetupScreen() {
  const router = useRouter();
  const theme = useTheme();
  const { session, initializing, refreshProfile } = useAuth();
  const [regions, setRegions] = useState<Region[]>([]);
  const [name, setName] = useState('');
  const [regionId, setRegionId] = useState<number | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    supabase
      .from('regions')
      .select('id, name')
      .eq('enabled', true)
      .not('parent_id', 'is', null)
      .order('sort')
      .then(({ data }) => setRegions(data ?? []));
  }, []);

  if (!initializing && !session) return <Redirect href="/sign-in" />;

  async function submit() {
    setNameError(null);
    setCodeError(null);
    setFormError(null);
    const trimmed = name.trim();
    if (trimmed.length < 2) {
      setNameError('Tell people your name — at least 2 characters.');
      return;
    }
    if (!regionId) {
      setFormError('Pick the region you live in.');
      return;
    }
    const referral = code.trim();
    if (referral && !isValidReferralCode(referral)) {
      setCodeError("That code doesn't look right — codes are 6 letters/numbers.");
      return;
    }

    setBusy(true);
    const { errorCode } = await invokeFunction('complete-profile', {
      display_name: trimmed,
      home_region_id: regionId,
      ...(referral ? { referral_code: referral } : {}),
    });
    if (errorCode === 'invalid_referral_code') {
      setBusy(false);
      setCodeError("We don't recognize that code. Check it or leave it blank.");
      return;
    }
    if (errorCode) {
      setBusy(false);
      setFormError('Something went wrong saving your details. Try again.');
      return;
    }
    await refreshProfile();
    setBusy(false);
    router.replace('/(tabs)');
  }

  return (
    <ThemedView style={styles.container}>
      <ScrollView
        style={styles.inner}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled">
        <TextField
          label="Your name"
          placeholder="e.g. Keisha Mohammed"
          autoFocus
          autoCapitalize="words"
          value={name}
          onChangeText={setName}
          error={nameError}
        />

        <ThemedView style={styles.regionBlock}>
          <ThemedText type="smallBold" themeColor="textSecondary">
            Where are you based?
          </ThemedText>
          <ThemedView style={styles.regionList}>
            {regions.map((region) => {
              const selected = region.id === regionId;
              return (
                <Pressable
                  key={region.id}
                  accessibilityRole="radio"
                  accessibilityState={{ selected }}
                  onPress={() => setRegionId(region.id)}
                  style={[
                    styles.regionChip,
                    {
                      backgroundColor: selected ? theme.text : theme.backgroundElement,
                    },
                  ]}>
                  <ThemedText
                    type="small"
                    style={{ color: selected ? theme.background : theme.text }}>
                    {region.name}
                  </ThemedText>
                </Pressable>
              );
            })}
          </ThemedView>
        </ThemedView>

        <TextField
          label="Referral code (optional)"
          placeholder="Have a code?"
          autoCapitalize="characters"
          autoCorrect={false}
          maxLength={6}
          value={code}
          onChangeText={setCode}
          error={codeError}
        />

        {formError ? (
          <ThemedText type="small" style={styles.formError}>
            {formError}
          </ThemedText>
        ) : null}

        <Button label="Done" onPress={submit} loading={busy} />
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
  regionBlock: {
    gap: Spacing.two,
  },
  regionList: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  regionChip: {
    minHeight: 44,
    borderRadius: 22,
    paddingHorizontal: Spacing.three,
    justifyContent: 'center',
  },
  formError: {
    color: '#B3261E',
  },
});
