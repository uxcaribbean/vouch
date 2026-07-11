import { Redirect, useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert, ScrollView, StyleSheet } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Button } from '@/components/ui/button';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { useAuth } from '@/lib/auth';
import { invokeFunction } from '@/lib/supabase';
import { useTraderProfileId } from '@/lib/trader-profile';

export default function SettingsScreen() {
  const router = useRouter();
  const { session, profile, initializing, signOut } = useAuth();
  const { traderId } = useTraderProfileId();
  const [deleting, setDeleting] = useState(false);

  if (!initializing && !session) return <Redirect href="/(tabs)" />;

  async function handleSignOut() {
    await signOut();
    router.replace('/(tabs)');
  }

  function confirmDelete() {
    Alert.alert(
      'Delete your account?',
      'Your profile, phone number and synced contacts are removed permanently. Vouches you gave stay, shown as "A former member". This cannot be undone.',
      [
        { text: 'Keep my account', style: 'cancel' },
        {
          text: 'Delete forever',
          style: 'destructive',
          onPress: async () => {
            setDeleting(true);
            const { errorCode } = await invokeFunction('delete-account');
            setDeleting(false);
            if (errorCode) {
              Alert.alert('Something went wrong', 'Your account was not deleted. Try again.');
              return;
            }
            await signOut();
            router.replace('/(tabs)');
          },
        },
      ],
    );
  }

  return (
    <ThemedView style={styles.container}>
      <ScrollView style={styles.inner} contentContainerStyle={styles.content}>
        <ThemedView style={styles.block}>
          <Row label="Name" value={profile?.display_name ?? '—'} />
          <Row label="Phone" value={profile?.phone_e164 ?? session?.user.phone ?? '—'} />
          <Row label="Your referral code" value={profile?.referral_code ?? '—'} />
          <ThemedText type="small" themeColor="textSecondary">
            Friends who join with your code get you +1 free month once invites
            launch (M6).
          </ThemedText>
        </ThemedView>

        <ThemedView style={styles.block}>
          <Button
            label={traderId ? 'My trader listing' : 'I provide a service'}
            variant="soft"
            onPress={() => router.push(traderId ? '/my-trader-profile' : '/become-a-trader')}
          />
          <Button label="Sign out" variant="soft" onPress={handleSignOut} />
          <Button
            label="Delete my account"
            variant="danger"
            loading={deleting}
            onPress={confirmDelete}
          />
        </ThemedView>
      </ScrollView>
    </ThemedView>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <ThemedView style={styles.row}>
      <ThemedText type="smallBold" themeColor="textSecondary">
        {label}
      </ThemedText>
      <ThemedText>{value}</ThemedText>
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
    gap: Spacing.five,
  },
  block: {
    gap: Spacing.three,
  },
  row: {
    gap: Spacing.half,
  },
});
