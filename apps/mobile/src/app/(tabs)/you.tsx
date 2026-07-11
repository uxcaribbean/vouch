import { useRouter } from 'expo-router';
import { StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Button } from '@/components/ui/button';
import { BottomTabInset, MaxContentWidth, Spacing, WebTopTabBarInset } from '@/constants/theme';
import { useAuth } from '@/lib/auth';
import { useTraderProfileId } from '@/lib/trader-profile';

/**
 * Account tab (spec M3 restructure — the old home hero/CTA cluster moves
 * here so the Home tab can be search-first).
 */
export default function AccountScreen() {
  const router = useRouter();
  const { session, profile, initializing } = useAuth();
  const { traderId } = useTraderProfileId();

  return (
    <ThemedView style={styles.container}>
      <SafeAreaView style={styles.safeArea}>
        {initializing ? null : !session ? (
          <ThemedView style={styles.signedOut}>
            <ThemedText type="subtitle" style={styles.center}>
              Sign in with your phone number
            </ThemedText>
            <ThemedText themeColor="textSecondary" style={styles.center}>
              Vouching, syncing contacts and offering your own services need an
              account. Browsing the directory never does.
            </ThemedText>
            <Button label="Sign in with your phone number" onPress={() => router.push('/sign-in')} />
          </ThemedView>
        ) : !profile ? (
          <ThemedView style={styles.actions}>
            <Button
              label="Finish setting up your account"
              onPress={() => router.push('/profile-setup')}
            />
          </ThemedView>
        ) : (
          <ThemedView style={styles.actions}>
            <ThemedText type="subtitle" style={styles.center}>
              You&apos;re in, {profile.display_name}.
            </ThemedText>
            <Button
              label={traderId ? 'My trader listing' : 'I provide a service'}
              variant="soft"
              onPress={() => router.push(traderId ? '/my-trader-profile' : '/become-a-trader')}
            />
            <Button label="Settings" variant="soft" onPress={() => router.push('/settings')} />
          </ThemedView>
        )}
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
    paddingHorizontal: Spacing.four,
    paddingTop: WebTopTabBarInset,
    paddingBottom: BottomTabInset + Spacing.four,
    maxWidth: MaxContentWidth,
    justifyContent: 'center',
    gap: Spacing.five,
  },
  signedOut: {
    gap: Spacing.three,
  },
  actions: {
    gap: Spacing.three,
  },
  center: {
    textAlign: 'center',
  },
});
