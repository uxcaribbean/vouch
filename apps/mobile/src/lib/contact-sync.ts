/**
 * Contact sync — the one sync engine (spec M4.2). Raw contact numbers never
 * leave this file: `hashContactList` (packages/shared) normalizes + hashes
 * them locally, and only the resulting sha256 fingerprints are ever sent to
 * `sync-contacts`. Never reimplement the hashing here.
 *
 * NOTE (SDK 57 gotcha): the top-level `expo-contacts` entry point replaced
 * `getContactsAsync`/`Fields`/permission calls with throwing stubs pointing
 * at a new class-based API. The working implementation of the API this
 * module needs still lives at `expo-contacts/legacy` — import from there,
 * never from `expo-contacts` directly.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Session } from '@supabase/supabase-js';
import type { Tables } from '@vouch/shared';
import { hashContactList } from '@vouch/shared';
import * as Contacts from 'expo-contacts/legacy';
import { Platform } from 'react-native';

import { invokeFunction } from '@/lib/supabase';

export const LAST_SYNC_STORAGE_KEY = 'contact-sync:last';

const CHUNK_SIZE = 500;
const AUTO_RESYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;

export type SyncResult =
  | { status: 'denied' }
  | { status: 'unsupported' }
  | { status: 'synced'; stored: number }
  | { status: 'error'; errorCode: string };

type SyncContactsResponse = { stored: number };

/**
 * Request contacts permission (if needed) and, once granted, hash + upload
 * every phone number found on-device. Never blocks app usage — a denial or
 * an unsupported platform is a normal outcome the caller displays inline.
 */
export async function requestAndSync(session: Session): Promise<SyncResult> {
  if (Platform.OS === 'web') return { status: 'unsupported' };

  const permission = await Contacts.requestPermissionsAsync();
  if (!permission.granted) return { status: 'denied' };

  const { data } = await Contacts.getContactsAsync({ fields: [Contacts.Fields.PhoneNumbers] });
  const rawNumbers = (data ?? []).flatMap((contact) =>
    (contact.phoneNumbers ?? [])
      .map((phone) => phone.number)
      .filter((number): number is string => Boolean(number)),
  );
  const hashes = hashContactList(rawNumbers);

  // Always send at least one batch (even an empty one) so a contact list
  // with zero phone numbers still flips contact_sync_enabled on and wipes
  // any stale hashes from a prior sync.
  const chunks: string[][] = [];
  for (let i = 0; i < hashes.length; i += CHUNK_SIZE) chunks.push(hashes.slice(i, i + CHUNK_SIZE));
  if (chunks.length === 0) chunks.push([]);

  let stored = 0;
  for (let i = 0; i < chunks.length; i++) {
    const { data: response, errorCode } = await invokeFunction<SyncContactsResponse>('sync-contacts', {
      hashes: chunks[i],
      replace: i === 0,
    });
    if (errorCode) return { status: 'error', errorCode };
    stored = response?.stored ?? stored;
  }

  await AsyncStorage.setItem(LAST_SYNC_STORAGE_KEY, String(Date.now()));
  return { status: 'synced', stored };
}

/**
 * Foreground re-sync (spec M4.2: max once/24h) — silent, never prompts.
 * Only runs when permission is already granted and the user has previously
 * opted in; the auth provider calls this once per app session once a
 * session + profile are both available.
 */
export async function maybeAutoResync(
  session: Session,
  profile: Pick<Tables<'users'>, 'contact_sync_enabled'>,
): Promise<void> {
  if (Platform.OS === 'web') return;
  if (!profile.contact_sync_enabled) return;

  const permission = await Contacts.getPermissionsAsync();
  if (!permission.granted) return;

  const lastSync = await getLastSyncedAt();
  if (lastSync != null && Date.now() - lastSync < AUTO_RESYNC_INTERVAL_MS) return;

  await requestAndSync(session);
}

/** Epoch ms of the last successful sync on this device, or null if never synced. */
export async function getLastSyncedAt(): Promise<number | null> {
  const raw = await AsyncStorage.getItem(LAST_SYNC_STORAGE_KEY);
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Short relative-time label for Settings ("2 hours ago", "just now"). */
export function formatLastSynced(epochMs: number): string {
  const diffMs = Date.now() - epochMs;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diffMs < minute) return 'just now';
  if (diffMs < hour) {
    const mins = Math.floor(diffMs / minute);
    return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  }
  if (diffMs < day) {
    const hours = Math.floor(diffMs / hour);
    return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  }
  const days = Math.floor(diffMs / day);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}
