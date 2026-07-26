import { Image } from 'expo-image';
import { Redirect, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Button } from '@/components/ui/button';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { trackEvent } from '@/lib/analytics';
import { useAuth } from '@/lib/auth';
import { requestAndSync } from '@/lib/contact-sync';
import { supabase } from '@/lib/supabase';

type ReverseVouchRow = {
  trader_id: string;
  user_id: string;
  display_name: string | null;
  business_name: string | null;
  photo_url: string | null;
  avatar_url: string | null;
  trade_names: string[] | null;
};

type ScreenState =
  | { kind: 'pitch' }
  | { kind: 'busy' }
  | { kind: 'denied' }
  | { kind: 'unsupported' }
  | { kind: 'error' }
  | { kind: 'reverse'; rows: ReverseVouchRow[] }
  | { kind: 'done' };

/** Spec M4.5 reverse-prompt heading — built as a plain string (rather than
 * inline multi-line JSX text) so line-wrapping in this source file can never
 * change the rendered spacing. */
function reversePromptHeading(count: number): string {
  const noun = count === 1 ? 'person' : 'people';
  const verb = count === 1 ? 'is' : 'are';
  return `${count} ${noun} in your contacts ${verb} on VOUCH as traders — vouch for them?`;
}

export default function SyncContactsScreen() {
  const router = useRouter();
  const { session, profile, initializing } = useAuth();
  const [state, setState] = useState<ScreenState>({ kind: 'pitch' });

  // Fires once on mount, guarded like every other trackEvent call — a no-op
  // until the auth guards below resolve a real session.
  useEffect(() => {
    void trackEvent(session, 'contact_sync_prompt_shown', {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!initializing && !session) return <Redirect href="/sign-in" />;
  if (!initializing && session && !profile) return <Redirect href="/profile-setup" />;

  if (initializing || !session || !profile) {
    return (
      <ThemedView style={styles.container}>
        <ThemedView style={styles.loadingWrap}>
          <ActivityIndicator />
        </ThemedView>
      </ThemedView>
    );
  }

  // Reassigned so the narrowed non-null type survives capture by the
  // nested closure below (TS widens `session` back to `Session | null`
  // otherwise, since it's a `let`-like outer binding from a hook).
  const activeSession = session;

  async function handleEnable() {
    setState({ kind: 'busy' });
    const result = await requestAndSync(activeSession);
    if (result.status === 'denied') {
      setState({ kind: 'denied' });
      return;
    }
    if (result.status === 'unsupported') {
      setState({ kind: 'unsupported' });
      return;
    }
    if (result.status === 'error') {
      setState({ kind: 'error' });
      return;
    }
    // Reverse prompt (spec M4.5): surface traders already in the user's
    // contacts that they haven't vouched for yet.
    const { data } = await supabase.rpc('contacts_on_vouch');
    if (data && data.length > 0) {
      setState({ kind: 'reverse', rows: data });
    } else {
      setState({ kind: 'done' });
    }
  }

  function goToVouch(traderId: string) {
    router.push({ pathname: '/vouch/[traderId]', params: { traderId } });
  }

  /** Spec M8: three of these and the server stops nudging this user for good. */
  function handleNotNow() {
    void trackEvent(activeSession, 'sync_nudge_dismissed', {});
    router.back();
  }

  return (
    <ThemedView style={styles.container}>
      <ScrollView style={styles.inner} contentContainerStyle={styles.content}>
        {state.kind === 'reverse' ? (
          <ThemedView style={styles.block}>
            <ThemedText type="subtitle">{reversePromptHeading(state.rows.length)}</ThemedText>
            <ThemedView style={styles.reverseList}>
              {state.rows.map((row) => (
                <ReverseTraderCard key={row.trader_id} row={row} onPress={() => goToVouch(row.trader_id)} />
              ))}
            </ThemedView>
            <Button label="Done for now" variant="soft" onPress={() => router.back()} />
          </ThemedView>
        ) : state.kind === 'done' ? (
          <ThemedView style={styles.block}>
            <ThemedText type="subtitle">You&apos;re set.</ThemedText>
            <ThemedText themeColor="textSecondary">
              Traders your contacts vouch for now show up first.
            </ThemedText>
            <Button label="Done" onPress={() => router.back()} />
          </ThemedView>
        ) : (
          <ThemedView style={styles.block}>
            <ThemedText type="subtitle">See which traders your own contacts vouch for.</ThemedText>
            <ThemedText themeColor="textSecondary">
              Names and numbers never leave your phone — only anonymous fingerprints.
            </ThemedText>

            {state.kind === 'denied' ? (
              <ThemedText type="small" themeColor="textSecondary">
                You can turn this on any time in Settings.
              </ThemedText>
            ) : null}
            {state.kind === 'unsupported' ? (
              <ThemedText type="small" themeColor="textSecondary">
                Contact matching works in the mobile app.
              </ThemedText>
            ) : null}
            {state.kind === 'error' ? (
              <ThemedText type="small" style={styles.formError}>
                Something went wrong syncing your contacts. Try again.
              </ThemedText>
            ) : null}

            {state.kind === 'denied' || state.kind === 'unsupported' || state.kind === 'error' ? (
              <Button label="Done" variant="soft" onPress={() => router.back()} />
            ) : (
              <ThemedView style={styles.actions}>
                <Button
                  label="Enable contact matching"
                  onPress={handleEnable}
                  loading={state.kind === 'busy'}
                  disabled={state.kind === 'busy'}
                />
                <Button
                  label="Not now"
                  variant="soft"
                  onPress={handleNotNow}
                  disabled={state.kind === 'busy'}
                />
              </ThemedView>
            )}
          </ThemedView>
        )}
      </ScrollView>
    </ThemedView>
  );
}

function ReverseTraderCard({ row, onPress }: { row: ReverseVouchRow; onPress: () => void }) {
  const theme = useTheme();
  const photo = row.photo_url ?? row.avatar_url ?? null;
  const name = row.business_name || row.display_name || 'Trader';
  const trades = (row.trade_names ?? []).slice(0, 2).join(', ');

  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={[styles.reverseCard, { backgroundColor: theme.backgroundElement }]}>
      {photo ? (
        <Image source={{ uri: photo }} style={styles.reversePhoto} contentFit="cover" />
      ) : (
        <ThemedView
          style={[styles.reversePhoto, styles.reversePhotoPlaceholder, { backgroundColor: theme.backgroundSelected }]}>
          <ThemedText type="small" themeColor="textSecondary">
            No photo
          </ThemedText>
        </ThemedView>
      )}
      <ThemedView style={styles.reverseBody}>
        <ThemedText type="smallBold">{name}</ThemedText>
        {trades ? (
          <ThemedText type="small" themeColor="textSecondary">
            {trades}
          </ThemedText>
        ) : null}
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
  loadingWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  block: {
    gap: Spacing.three,
  },
  actions: {
    gap: Spacing.three,
  },
  formError: {
    color: '#B3261E',
  },
  reverseList: {
    gap: Spacing.two,
  },
  reverseCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    borderRadius: Spacing.three,
    padding: Spacing.three,
  },
  reversePhoto: {
    width: 48,
    height: 48,
    borderRadius: Spacing.two,
  },
  reversePhotoPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  reverseBody: {
    flex: 1,
    gap: Spacing.half,
  },
});
