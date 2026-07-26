import { Redirect, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, ScrollView, StyleSheet } from 'react-native';

import { InviteAFriend } from '@/components/invite-a-friend';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Button } from '@/components/ui/button';
import { ToggleChip } from '@/components/ui/toggle-chip';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { trackEvent } from '@/lib/analytics';
import { useAuth } from '@/lib/auth';
import { formatLastSynced, getLastSyncedAt, requestAndSync } from '@/lib/contact-sync';
import {
  DEFAULT_NOTIFICATION_PREFS,
  loadNotificationPrefs,
  NOTIFICATION_LABELS,
  NOTIFICATION_TYPES,
  setNotificationPref,
  type NotificationPrefs,
  type NotificationType,
} from '@/lib/notifications';
import { invokeFunction, supabase } from '@/lib/supabase';
import { useTraderProfileId } from '@/lib/trader-profile';

export default function SettingsScreen() {
  const router = useRouter();
  const { session, profile, initializing, signOut, refreshProfile } = useAuth();
  const { traderId } = useTraderProfileId();
  const [deleting, setDeleting] = useState(false);

  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const [resyncing, setResyncing] = useState(false);
  const [resyncError, setResyncError] = useState<string | null>(null);
  const [disablingSync, setDisablingSync] = useState(false);
  const [syncDisabledNotice, setSyncDisabledNotice] = useState(false);

  // Absent rows read as enabled, so the optimistic default is also the truth
  // for every account that has never touched a toggle.
  const [notifyPrefs, setNotifyPrefs] = useState<NotificationPrefs>(DEFAULT_NOTIFICATION_PREFS);
  const [notifyError, setNotifyError] = useState<string | null>(null);

  useEffect(() => {
    getLastSyncedAt().then(setLastSyncedAt);
  }, []);

  useEffect(() => {
    if (!session) return;
    void loadNotificationPrefs(session).then(setNotifyPrefs);
  }, [session]);

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

  async function handleResync() {
    if (!session) return;
    setResyncing(true);
    setResyncError(null);
    setSyncDisabledNotice(false);
    const result = await requestAndSync(session);
    setResyncing(false);
    if (result.status === 'synced') {
      setLastSyncedAt(Date.now());
      return;
    }
    if (result.status === 'denied') {
      setResyncError('Contact permission is off — enable it in your phone settings to re-sync.');
      return;
    }
    if (result.status === 'unsupported') {
      setResyncError('Contact matching works in the mobile app.');
      return;
    }
    setResyncError('Something went wrong re-syncing your contacts. Try again.');
  }

  async function handleDisableSync() {
    if (!session) return;
    setDisablingSync(true);
    setResyncError(null);
    setSyncDisabledNotice(false);
    await supabase.from('contact_hashes').delete().eq('owner_user_id', session.user.id);
    await supabase.from('users').update({ contact_sync_enabled: false }).eq('id', session.user.id);
    await refreshProfile();
    setDisablingSync(false);
    setSyncDisabledNotice(true);
    void trackEvent(session, 'contact_sync_disabled', {});
  }

  async function handleToggleNotification(type: NotificationType) {
    if (!session) return;
    const next = !notifyPrefs[type];
    setNotifyError(null);
    setNotifyPrefs((current) => ({ ...current, [type]: next }));
    const ok = await setNotificationPref(session, type, next);
    if (!ok) {
      setNotifyPrefs((current) => ({ ...current, [type]: !next }));
      setNotifyError("That didn't save. Check your connection and try again.");
    }
  }

  return (
    <ThemedView style={styles.container}>
      <ScrollView style={styles.inner} contentContainerStyle={styles.content}>
        <ThemedView style={styles.block}>
          <ThemedText type="smallBold" themeColor="textSecondary">
            People you know
          </ThemedText>

          {profile?.contact_sync_enabled ? (
            <>
              <ThemedText>Contact matching is on</ThemedText>
              <ThemedText type="small" themeColor="textSecondary">
                {lastSyncedAt ? `Last synced ${formatLastSynced(lastSyncedAt)}` : 'Not synced on this device yet'}
              </ThemedText>
            </>
          ) : null}

          {resyncError ? (
            <ThemedText type="small" style={styles.formError}>
              {resyncError}
            </ThemedText>
          ) : null}
          {syncDisabledNotice ? (
            <ThemedText type="small" themeColor="textSecondary">
              Deleted. Nothing about your contacts is stored.
            </ThemedText>
          ) : null}

          {profile?.contact_sync_enabled ? (
            <>
              <Button
                label="Re-sync now"
                variant="soft"
                loading={resyncing}
                disabled={disablingSync}
                onPress={handleResync}
              />
              <Button
                label="Turn off & delete fingerprints"
                variant="danger"
                loading={disablingSync}
                disabled={resyncing}
                onPress={handleDisableSync}
              />
            </>
          ) : (
            <Button
              label="See traders people you know vouch for"
              variant="soft"
              onPress={() => router.push('/sync-contacts')}
            />
          )}
        </ThemedView>

        <ThemedView style={styles.block}>
          <ThemedText type="smallBold" themeColor="textSecondary">
            Notifications
          </ThemedText>

          {NOTIFICATION_TYPES.map((type) => (
            <ThemedView key={type} style={styles.notifyRow}>
              <ThemedText style={styles.notifyLabel}>{NOTIFICATION_LABELS[type]}</ThemedText>
              <ToggleChip
                label={notifyPrefs[type] ? 'On' : 'Off'}
                selected={notifyPrefs[type]}
                role="checkbox"
                accessibilityLabel={NOTIFICATION_LABELS[type]}
                onPress={() => handleToggleNotification(type)}
              />
            </ThemedView>
          ))}

          {notifyError ? (
            <ThemedText type="small" style={styles.formError}>
              {notifyError}
            </ThemedText>
          ) : null}

          <ThemedText type="small" themeColor="textSecondary">
            VOUCH sends at most 2 non-essential notifications a week — that&apos;s enforced on our
            servers, not just here.
          </ThemedText>
        </ThemedView>

        <ThemedView style={styles.block}>
          <Row label="Name" value={profile?.display_name ?? '—'} />
          <Row label="Phone" value={profile?.phone_e164 ?? session?.user.phone ?? '—'} />
          <Row label="Your referral code" value={profile?.referral_code ?? '—'} />
          <ThemedText type="small" themeColor="textSecondary">
            Share your code — you get +1 free month when a friend joins with it.
          </ThemedText>
          <InviteAFriend />
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
  notifyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.three,
    minHeight: 44,
  },
  notifyLabel: {
    flex: 1,
  },
  formError: {
    color: '#B3261E',
  },
});
