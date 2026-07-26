/**
 * Push notifications — the device half of spec M8.
 *
 * Deliberately thin. Every rule that actually protects the user (per-type
 * opt-outs, the hard cap of 2 non-transactional pushes/week, the "stop after
 * 3 dismissals" nudge rule) is enforced server-side in
 * `supabase/functions/_shared/notify.ts` before a push is ever addressed to a
 * device. This module only: registers the device token, mirrors the toggles
 * into `notification_prefs`, and routes a tap.
 *
 * Nothing here may block the app. Push is a nice-to-have on top of a
 * directory that has to work for a tradesman on a cheap Android with
 * notifications switched off at the OS level — every failure path is a
 * silent no-op.
 */
import type { Session } from '@supabase/supabase-js';
import Constants from 'expo-constants';
import { router } from 'expo-router';
import { Platform } from 'react-native';

import { supabase } from '@/lib/supabase';

/**
 * `expo-notifications` is imported lazily, always behind a `Platform.OS`
 * guard. Importing it eagerly runs the library's device-token registration
 * side effect, which on web only logs "not yet fully supported on web" —
 * noise from a subsystem that does not exist on that platform. The Settings
 * toggles below deliberately do NOT depend on it, so preferences stay
 * editable on web.
 */
const loadPushModule = () => import('expo-notifications');

/** The four toggleable types, matching the DB check constraint (M8 migration). */
export const NOTIFICATION_TYPES = [
  'vouch_received',
  'referral_credited',
  'contacts_joined_traders',
  'sync_nudge',
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** Settings-screen copy, in display order. */
export const NOTIFICATION_LABELS: Record<NotificationType, string> = {
  vouch_received: 'New vouch on your listing',
  referral_credited: 'Referral credited',
  contacts_joined_traders: 'People you know joined',
  sync_nudge: 'Sync reminders',
};

/** An ABSENT `notification_prefs` row means enabled — new types default on. */
export type NotificationPrefs = Record<NotificationType, boolean>;

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  vouch_received: true,
  referral_credited: true,
  contacts_joined_traders: true,
  sync_nudge: true,
};

let warnedAboutToken = false;

function warnOnce(error: unknown): void {
  if (warnedAboutToken) return;
  warnedAboutToken = true;
  // Expected until EAS is wired up: without `extra.eas.projectId` there is no
  // project to attribute a token to, so Expo rejects the request. Device push
  // is a known device-pass item — the app must not care.
  console.warn('[notifications] push token unavailable; continuing without push', error);
}

/**
 * Registers this device's Expo push token against the signed-in user.
 *
 * Never throws, never blocks, never prompts twice: the OS dialog is only
 * raised when permission is genuinely still undecided (already granted →
 * nothing to ask; permanently denied → asking again is a no-op that only
 * annoys). Web has no Expo push token, so it short-circuits.
 */
export async function registerForPush(session: Session): Promise<void> {
  if (Platform.OS === 'web') return;

  try {
    const Notifications = await loadPushModule();
    const existing = await Notifications.getPermissionsAsync();
    let granted = existing.granted;
    if (!granted) {
      if (!existing.canAskAgain) return;
      const requested = await Notifications.requestPermissionsAsync();
      granted = requested.granted;
    }
    if (!granted) return;

    // UNDEFINED until EAS is configured — passing it through unchanged means
    // this starts working the moment `extra.eas.projectId` exists, with no
    // code change.
    const projectId = (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)
      ?.eas?.projectId;
    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });

    // Own-device data, so this is a direct RLS-guarded write (iron rule 4
    // covers other users' data). Re-registering the same token on every app
    // launch is normal — hence the upsert.
    await supabase.from('push_tokens').upsert({
      user_id: session.user.id,
      token,
      platform: Platform.OS === 'ios' ? 'ios' : 'android',
    });
  } catch (error) {
    warnOnce(error);
  }
}

/**
 * Foreground presentation + tap routing. Called once from `AuthProvider`;
 * resolves to its own teardown.
 */
export async function configureNotifications(): Promise<() => void> {
  if (Platform.OS === 'web') return () => {};

  try {
    const Notifications = await loadPushModule();

    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: false,
        shouldSetBadge: false,
      }),
    });

    // `vouch_received` carries `{ trader_id }` (see upsert-vouch) — tapping it
    // should land on the listing that got the vouch, not the app's home tab.
    const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
      const data = response.notification.request.content.data as Record<string, unknown> | undefined;
      const traderId = data?.trader_id;
      if (typeof traderId === 'string' && traderId.length > 0) {
        router.push({ pathname: '/trader/[id]', params: { id: traderId } });
      }
    });

    return () => subscription.remove();
  } catch (error) {
    warnOnce(error);
    return () => {};
  }
}

/**
 * Current per-type toggles for the signed-in user. Rows only exist once a
 * user has touched a toggle, so anything missing reads as enabled.
 */
export async function loadNotificationPrefs(session: Session): Promise<NotificationPrefs> {
  const prefs: NotificationPrefs = { ...DEFAULT_NOTIFICATION_PREFS };
  const { data } = await supabase
    .from('notification_prefs')
    .select('type, enabled')
    .eq('user_id', session.user.id);

  for (const row of data ?? []) {
    if ((NOTIFICATION_TYPES as readonly string[]).includes(row.type)) {
      prefs[row.type as NotificationType] = row.enabled;
    }
  }
  return prefs;
}

/** Writes one toggle. Returns false so the caller can revert its optimistic UI. */
export async function setNotificationPref(
  session: Session,
  type: NotificationType,
  enabled: boolean,
): Promise<boolean> {
  const { error } = await supabase
    .from('notification_prefs')
    .upsert({ user_id: session.user.id, type, enabled });
  return !error;
}
