import { useState } from 'react';
import { Platform, Share, StyleSheet } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Button } from '@/components/ui/button';
import { Spacing } from '@/constants/theme';
import { trackEvent } from '@/lib/analytics';
import { useAuth } from '@/lib/auth';
import { buildJoinMessage, createInvite, inviteErrorCopy } from '@/lib/invites';

/**
 * "Invite a friend" (spec M6.2) — shared by Settings and the You tab.
 *
 * Opens the OS share sheet with a prewritten draft; the user presses send
 * (spec M6.4 — the app never messages anyone). Web's share sheet is flaky,
 * so there we render the message for the user to copy instead.
 */
export function InviteAFriend({ label = 'Invite a friend' }: { label?: string }) {
  const { session, profile } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copyMessage, setCopyMessage] = useState<string | null>(null);

  if (!session || !profile) return null;

  const activeSession = session;
  const referralCode = profile.referral_code;

  async function handleInvite() {
    setBusy(true);
    setError(null);
    setCopyMessage(null);

    const { errorCode } = await createInvite('join_invite');
    setBusy(false);
    if (errorCode) {
      setError(inviteErrorCopy(errorCode));
      return;
    }

    const message = buildJoinMessage(referralCode);
    if (Platform.OS === 'web') {
      setCopyMessage(message);
    } else {
      try {
        await Share.share({ message });
      } catch {
        setCopyMessage(message);
      }
    }
    void trackEvent(activeSession, 'join_invite_shared', {});
  }

  return (
    <ThemedView style={styles.wrap}>
      <Button label={label} variant="soft" loading={busy} onPress={handleInvite} />
      {error ? (
        <ThemedText type="small" style={styles.error}>
          {error}
        </ThemedText>
      ) : null}
      {copyMessage ? (
        <ThemedView style={styles.messageBlock}>
          <ThemedText selectable>{copyMessage}</ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            That&apos;s your invite — copy and send it anywhere.
          </ThemedText>
        </ThemedView>
      ) : null}
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  wrap: {
    gap: Spacing.three,
  },
  messageBlock: {
    gap: Spacing.two,
  },
  error: {
    color: '#B3261E',
  },
});
