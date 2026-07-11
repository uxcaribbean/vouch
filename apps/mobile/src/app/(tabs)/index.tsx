import { useRouter } from 'expo-router';
import { StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Button } from '@/components/ui/button';
import { BottomTabInset, MaxContentWidth, Spacing } from '@/constants/theme';
import { useAuth } from '@/lib/auth';

/**
 * Placeholder home. M3 replaces this with the search-first directory
 * (search bar + popular categories + region selector).
 */
export default function HomeScreen() {
  const router = useRouter();
  const { session, profile, initializing } = useAuth();

  return (
    <ThemedView style={styles.container}>
      <SafeAreaView style={styles.safeArea}>
        <ThemedView style={styles.hero}>
          <ThemedText type="title" style={styles.center}>
            VOUCH
          </ThemedText>
          <ThemedText themeColor="textSecondary" style={styles.center}>
            Trades & services your own people vouch for. Trinidad first.
          </ThemedText>
        </ThemedView>

        {initializing ? null : !session ? (
          <ThemedView style={styles.actions}>
            <Button
              label="Sign in with your phone number"
              onPress={() => router.push('/sign-in')}
            />
            <ThemedText type="small" themeColor="textSecondary" style={styles.center}>
              Browsing without an account arrives with the directory (M3).
            </ThemedText>
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
            <ThemedText style={styles.center}>
              You&apos;re in, {profile.display_name}.
            </ThemedText>
            <Button
              label="Settings"
              variant="soft"
              onPress={() => router.push('/settings')}
            />
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
    paddingBottom: BottomTabInset + Spacing.four,
    maxWidth: MaxContentWidth,
    justifyContent: 'flex-end',
    gap: Spacing.five,
  },
  hero: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.three,
  },
  actions: {
    gap: Spacing.three,
  },
  center: {
    textAlign: 'center',
  },
});
