/**
 * "Ask for vouches" (spec M6.1) — a trader picks people from their own
 * phone and drafts a vouch request to each of them.
 *
 * Two hard rules this screen exists to honour:
 *  1. Contact NAMES and NUMBERS never leave the device. Nothing here calls
 *     `sync-contacts` or uploads anything; the only server call is
 *     `create-invite`, which returns a token and knows no recipients.
 *  2. No automatic sending, anywhere (spec M6.4). Each recipient gets a
 *     WhatsApp *draft* via `wa.me`; the trader presses send themselves.
 *
 * SDK 57 gotcha: `expo-contacts`'s main entry ships throwing stubs — the
 * working functional API is `expo-contacts/legacy` (same as contact-sync.ts).
 */
import { buildVouchRequestMessage, hashPhone, normalizePhone, vouchLinkUrl } from '@vouch/shared';
import * as Contacts from 'expo-contacts/legacy';
import { Redirect, useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Linking, Platform, Pressable, ScrollView, StyleSheet } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Button } from '@/components/ui/button';
import { TextField } from '@/components/ui/text-field';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { trackEvent } from '@/lib/analytics';
import { useAuth } from '@/lib/auth';
import {
  WEB_BASE_URL,
  createInvite,
  inviteErrorCopy,
  whatsAppDraftUrl,
} from '@/lib/invites';
import { supabase } from '@/lib/supabase';

type ContactRow = { id: string; name: string; e164: string };

type ContactsState =
  | { kind: 'loading' }
  | { kind: 'ready'; rows: ContactRow[] }
  | { kind: 'denied' }
  | { kind: 'unsupported' }
  | { kind: 'error' };

type Flow =
  | { kind: 'picking' }
  /** one-by-one send loop — `opened` holds the numbers actually drafted */
  | { kind: 'sending'; recipients: ContactRow[]; message: string; index: number; opened: string[] }
  | { kind: 'done'; opened: number };

type TraderListing = {
  id: string;
  trader_trades: { trades: { name: string } | null }[];
};

/** Full name as the phone stores it, falling back to the name parts. */
function contactName(contact: Contacts.ExistingContact): string {
  const full = (contact.name ?? '').trim();
  if (full) return full;
  return [contact.firstName, contact.lastName].filter(Boolean).join(' ').trim();
}

/**
 * Device contacts → one row per person: display name + their FIRST valid
 * number. Contacts blocked by the trader (spec M9 `private_blocks`, matched
 * locally against the hash) and duplicate numbers are dropped entirely.
 */
function toContactRows(
  contacts: Contacts.ExistingContact[],
  blockedHashes: Set<string>,
): ContactRow[] {
  const seen = new Set<string>();
  const rows: ContactRow[] = [];
  for (const contact of contacts) {
    const name = contactName(contact);
    if (!name) continue;
    for (const phone of contact.phoneNumbers ?? []) {
      const e164 = phone.number ? normalizePhone(phone.number) : null;
      if (!e164) continue;
      // first valid number wins, whatever happens to it next
      if (!seen.has(e164) && !blockedHashes.has(hashPhone(e164))) {
        seen.add(e164);
        rows.push({ id: contact.id, name, e164 });
      }
      break;
    }
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

export default function AskForVouchesScreen() {
  const router = useRouter();
  const { session, profile, initializing } = useAuth();

  const [listing, setListing] = useState<TraderListing | null>(null);
  const [listingChecked, setListingChecked] = useState(false);
  const [contacts, setContacts] = useState<ContactsState>({ kind: 'loading' });
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [flow, setFlow] = useState<Flow>({ kind: 'picking' });
  const [busy, setBusy] = useState<'prepare' | 'link' | null>(null);
  const [linkMessage, setLinkMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    supabase
      .from('trader_profiles')
      .select('id, trader_trades(trades(name))')
      .eq('user_id', session.user.id)
      .maybeSingle()
      .then(({ data }) => {
        if (cancelled) return;
        setListing(data as unknown as TraderListing | null);
        setListingChecked(true);
      });
    return () => {
      cancelled = true;
    };
  }, [session]);

  useEffect(() => {
    if (!session) return;
    const userId = session.user.id;
    let cancelled = false;

    void (async () => {
      if (Platform.OS === 'web') {
        if (!cancelled) setContacts({ kind: 'unsupported' });
        return;
      }
      try {
        const permission = await Contacts.requestPermissionsAsync();
        if (cancelled) return;
        if (!permission.granted) {
          setContacts({ kind: 'denied' });
          return;
        }

        // The trader's own block list, fetched once and matched on-device so
        // a blocked number never even renders (spec M6.1 pre-filter).
        const { data: blocks } = await supabase
          .from('private_blocks')
          .select('blocked_phone_hash')
          .eq('trader_user_id', userId);
        const blocked = new Set((blocks ?? []).map((block) => block.blocked_phone_hash));

        const { data } = await Contacts.getContactsAsync({
          fields: [Contacts.Fields.Name, Contacts.Fields.PhoneNumbers],
        });
        if (cancelled) return;
        setContacts({ kind: 'ready', rows: toContactRows(data ?? [], blocked) });
      } catch {
        if (!cancelled) setContacts({ kind: 'error' });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [session]);

  const allRows = useMemo(
    () => (contacts.kind === 'ready' ? contacts.rows : []),
    [contacts],
  );
  const visibleRows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return allRows;
    return allRows.filter(
      (row) =>
        row.name.toLowerCase().includes(needle) || row.e164.replace(/\D/g, '').includes(needle.replace(/\D/g, '')),
    );
  }, [allRows, query]);

  if (!initializing && !session) return <Redirect href="/sign-in" />;
  if (!initializing && session && !profile) return <Redirect href="/profile-setup" />;
  if (listingChecked && !listing) return <Redirect href="/become-a-trader" />;

  if (initializing || !session || !profile || !listingChecked || !listing) {
    return (
      <ThemedView style={styles.container}>
        <ThemedView style={styles.loadingWrap}>
          <ActivityIndicator />
        </ThemedView>
      </ThemedView>
    );
  }

  // Captured so the narrowed types survive inside the handlers below.
  const activeSession = session;
  const referralCode = profile.referral_code;
  const tradeName = listing.trader_trades[0]?.trades?.name ?? 'service provider';

  function toggle(e164: string) {
    setSelected((current) =>
      current.includes(e164) ? current.filter((value) => value !== e164) : [...current, e164],
    );
  }

  /** One invites row for the whole selection (spec M6.1), one message. */
  async function buildMessage(action: 'prepare' | 'link'): Promise<string | null> {
    setError(null);
    setBusy(action);
    const { data, errorCode } = await createInvite('vouch_request');
    setBusy(null);
    if (errorCode || !data) {
      setError(inviteErrorCopy(errorCode ?? 'unknown_error'));
      return null;
    }
    return buildVouchRequestMessage({
      tradeName,
      link: vouchLinkUrl(WEB_BASE_URL, data.token),
      referralCode,
    });
  }

  async function handlePrepare() {
    const recipients = allRows.filter((row) => selected.includes(row.e164));
    if (recipients.length === 0) return;
    const message = await buildMessage('prepare');
    if (!message) return;
    setFlow({ kind: 'sending', recipients, message, index: 0, opened: [] });
  }

  async function handleCopyLink() {
    const message = await buildMessage('link');
    if (message) setLinkMessage(message);
  }

  function openWhatsApp(state: Extract<Flow, { kind: 'sending' }>) {
    const recipient = state.recipients[state.index];
    // A draft, never a send — the trader taps send inside WhatsApp.
    void Linking.openURL(whatsAppDraftUrl(recipient.e164, state.message));
    if (state.opened.includes(recipient.e164)) return;
    setFlow({ ...state, opened: [...state.opened, recipient.e164] });
  }

  function advance(state: Extract<Flow, { kind: 'sending' }>, skip: boolean) {
    const recipient = state.recipients[state.index];
    const opened = skip
      ? state.opened.filter((value) => value !== recipient.e164)
      : state.opened;
    if (state.index + 1 >= state.recipients.length) {
      void trackEvent(activeSession, 'vouch_request_sent', { recipients: opened.length });
      setFlow({ kind: 'done', opened: opened.length });
      return;
    }
    setFlow({ ...state, index: state.index + 1, opened });
  }

  return (
    <ThemedView style={styles.container}>
      <ScrollView style={styles.inner} contentContainerStyle={styles.content}>
        {flow.kind === 'done' ? (
          <ThemedView style={styles.block}>
            <ThemedText type="subtitle">All requests prepared.</ThemedText>
            <ThemedText themeColor="textSecondary">
              You pressed send on every one — VOUCH never messages anyone for you.
            </ThemedText>
            <Button label="Done" onPress={() => router.replace('/my-trader-profile')} />
          </ThemedView>
        ) : flow.kind === 'sending' ? (
          <ThemedView style={styles.block}>
            <ThemedText type="subtitle">
              {`Send to ${flow.recipients[flow.index].name} — ${flow.index + 1} of ${flow.recipients.length}`}
            </ThemedText>
            <ThemedText type="small" themeColor="textSecondary">
              {flow.recipients[flow.index].e164}
            </ThemedText>
            <ThemedText selectable>{flow.message}</ThemedText>
            <Button label="Open WhatsApp" onPress={() => openWhatsApp(flow)} />
            <Button
              label={flow.index + 1 >= flow.recipients.length ? 'Finish' : 'Next'}
              variant="soft"
              onPress={() => advance(flow, false)}
            />
            <Button label="Skip" variant="soft" onPress={() => advance(flow, true)} />
          </ThemedView>
        ) : (
          <ThemedView style={styles.block}>
            <ThemedText type="subtitle">Ask people you know for a vouch.</ThemedText>
            <ThemedText themeColor="textSecondary">
              Pick who to ask. Names and numbers stay on this phone — nothing is uploaded, and
              you press send on every message yourself.
            </ThemedText>

            {contacts.kind === 'loading' ? <ActivityIndicator /> : null}
            {contacts.kind === 'denied' ? (
              <ThemedText type="small" themeColor="textSecondary">
                Contact permission is off — turn it on in your phone settings to pick from your
                contacts. You can still share your link below.
              </ThemedText>
            ) : null}
            {contacts.kind === 'unsupported' ? (
              <ThemedText type="small" themeColor="textSecondary">
                Picking from your contacts works in the mobile app. You can still share your link
                below.
              </ThemedText>
            ) : null}
            {contacts.kind === 'error' ? (
              <ThemedText type="small" style={styles.formError}>
                Something went wrong reading your contacts. You can still share your link below.
              </ThemedText>
            ) : null}

            {contacts.kind === 'ready' ? (
              <>
                <TextField
                  label="Search your contacts"
                  placeholder="Name or number"
                  value={query}
                  onChangeText={setQuery}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                {allRows.length === 0 ? (
                  <ThemedText themeColor="textSecondary">
                    No contacts with a usable phone number on this phone.
                  </ThemedText>
                ) : (
                  <>
                    <ThemedText type="smallBold" themeColor="textSecondary">
                      {`${selected.length} selected`}
                    </ThemedText>
                    <ThemedView style={styles.list}>
                      {visibleRows.map((row) => (
                        <ContactPickRow
                          key={row.id}
                          row={row}
                          selected={selected.includes(row.e164)}
                          onToggle={() => toggle(row.e164)}
                        />
                      ))}
                    </ThemedView>
                    <Button
                      label={`Prepare ${selected.length} request${selected.length === 1 ? '' : 's'}`}
                      disabled={selected.length === 0}
                      loading={busy === 'prepare'}
                      onPress={handlePrepare}
                    />
                  </>
                )}
              </>
            ) : null}

            {error ? (
              <ThemedText type="small" style={styles.formError}>
                {error}
              </ThemedText>
            ) : null}

            {linkMessage ? (
              <ThemedView style={styles.block}>
                <ThemedText selectable>{linkMessage}</ThemedText>
                <ThemedText type="small" themeColor="textSecondary">
                  That&apos;s your request — copy and send it anywhere.
                </ThemedText>
              </ThemedView>
            ) : (
              <Button
                label="Copy my vouch link"
                variant="soft"
                loading={busy === 'link'}
                onPress={handleCopyLink}
              />
            )}
          </ThemedView>
        )}
      </ScrollView>
    </ThemedView>
  );
}

function ContactPickRow({
  row,
  selected,
  onToggle,
}: {
  row: ContactRow;
  selected: boolean;
  onToggle: () => void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: selected }}
      onPress={onToggle}
      style={[
        styles.pickRow,
        { backgroundColor: selected ? theme.backgroundSelected : theme.backgroundElement },
      ]}>
      <ThemedView
        style={[
          styles.checkbox,
          { borderColor: theme.text, backgroundColor: selected ? theme.text : 'transparent' },
        ]}>
        {selected ? (
          <ThemedText type="smallBold" style={{ color: theme.background }}>
            ✓
          </ThemedText>
        ) : null}
      </ThemedView>
      <ThemedView style={[styles.pickBody, { backgroundColor: 'transparent' }]}>
        <ThemedText type="smallBold">{row.name}</ThemedText>
        <ThemedText type="small" themeColor="textSecondary">
          {row.e164}
        </ThemedText>
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
  list: {
    gap: Spacing.two,
  },
  pickRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    borderRadius: Spacing.three,
    padding: Spacing.three,
    minHeight: 56,
  },
  checkbox: {
    width: 24,
    height: 24,
    borderRadius: Spacing.two,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pickBody: {
    flex: 1,
    gap: Spacing.half,
  },
  formError: {
    color: '#B3261E',
  },
});
