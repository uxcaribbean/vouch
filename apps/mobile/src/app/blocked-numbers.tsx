/**
 * Blocked numbers (spec M9.2) — a trader's private block list.
 *
 * The only thing stored is `hashPhone(e164)` plus a note the trader writes
 * for themselves. That hash is one-way, so this screen can never show the
 * number back — the note IS the identifier, which the copy says out loud.
 *
 * Effect in MVP: "Ask for vouches" (M6.1) filters these hashes out on-device
 * before rendering the contact picker. Nothing else, and nobody else — not
 * other members, not admins — ever sees this list.
 */
import { hashPhone, normalizePhone } from '@vouch/shared';
import { Redirect } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView, StyleSheet } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Button } from '@/components/ui/button';
import { TextField } from '@/components/ui/text-field';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import { useTraderProfileId } from '@/lib/trader-profile';

type BlockRow = {
  blocked_phone_hash: string;
  note: string | null;
  created_at: string;
};

const MAX_NOTE_LENGTH = 80;
const CONFIRM_RESET_MS = 4000;
const DUPLICATE_CODE = '23505';

function formatBlockedOn(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-US', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

export default function BlockedNumbersScreen() {
  const theme = useTheme();
  const { session, initializing } = useAuth();
  const { traderId, loaded: traderLoaded } = useTraderProfileId();

  const [blocks, setBlocks] = useState<BlockRow[] | null>(null);
  const [raw, setRaw] = useState('');
  const [note, setNote] = useState('');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [confirmingHash, setConfirmingHash] = useState<string | null>(null);
  const [removingHash, setRemovingHash] = useState<string | null>(null);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    supabase
      .from('private_blocks')
      .select('blocked_phone_hash,note,created_at')
      .eq('trader_user_id', session.user.id)
      .order('created_at', { ascending: false })
      .then(({ data }) => {
        if (cancelled) return;
        setBlocks((data ?? []) as BlockRow[]);
      });
    return () => {
      cancelled = true;
    };
  }, [session]);

  // Two-tap confirm auto-resets so a stray later tap can't remove a row.
  useEffect(() => {
    if (!confirmingHash) return;
    const timer = setTimeout(() => setConfirmingHash(null), CONFIRM_RESET_MS);
    return () => clearTimeout(timer);
  }, [confirmingHash]);

  if (!initializing && !session) return <Redirect href="/sign-in" />;
  if (traderLoaded && session && !traderId) return <Redirect href="/become-a-trader" />;

  if (initializing || !session || !traderLoaded || blocks === null) {
    return (
      <ThemedView style={styles.container}>
        <ThemedView style={styles.loadingWrap}>
          <ActivityIndicator />
        </ThemedView>
      </ThemedView>
    );
  }

  // Trinidad numbers get the +1 868 prefix visually; typing "+" switches to
  // full international entry (same convention as sign-in).
  const international = raw.trim().startsWith('+');
  const activeSession = session;

  async function handleAdd() {
    if (adding) return;
    setAddError(null);
    const e164 = normalizePhone(raw);
    if (!e164) {
      setAddError("That doesn't look like a phone number. Try 555-1234 or the full number with country code.");
      return;
    }
    const hash = hashPhone(e164);
    setAdding(true);
    const { error } = await supabase.from('private_blocks').insert({
      trader_user_id: activeSession.user.id,
      blocked_phone_hash: hash,
      note: note.trim() || null,
    });
    setAdding(false);
    if (error) {
      setAddError(
        error.code === DUPLICATE_CODE
          ? "That number is already on your list."
          : "That didn't save. Check your connection and try again.",
      );
      return;
    }
    setBlocks((current) => [
      { blocked_phone_hash: hash, note: note.trim() || null, created_at: new Date().toISOString() },
      ...(current ?? []),
    ]);
    setRaw('');
    setNote('');
  }

  function handleRemovePress(hash: string) {
    if (confirmingHash !== hash) {
      setConfirmingHash(hash);
      return;
    }
    void handleRemove(hash);
  }

  async function handleRemove(hash: string) {
    setRemovingHash(hash);
    const { error } = await supabase
      .from('private_blocks')
      .delete()
      .eq('trader_user_id', activeSession.user.id)
      .eq('blocked_phone_hash', hash);
    setRemovingHash(null);
    setConfirmingHash(null);
    if (error) {
      setAddError("That didn't save. Check your connection and try again.");
      return;
    }
    setBlocks((current) => (current ?? []).filter((row) => row.blocked_phone_hash !== hash));
  }

  return (
    <ThemedView style={styles.container}>
      <KeyboardAvoidingView
        style={styles.inner}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <ThemedView style={styles.block}>
            <ThemedText themeColor="textSecondary">
              Blocked numbers never see your vouch requests. This list is private — nobody else can
              see it, not even VOUCH admins.
            </ThemedText>
          </ThemedView>

          <ThemedView style={styles.block}>
            <ThemedText type="smallBold" themeColor="textSecondary">
              Block a number
            </ThemedText>
            <TextField
              label="Phone number"
              prefix={international ? undefined : '+1 868'}
              placeholder={international ? '+44 7911 123456' : '555-1234'}
              keyboardType="phone-pad"
              autoCorrect={false}
              value={raw}
              onChangeText={(next) => {
                setRaw(next);
                if (addError) setAddError(null);
              }}
            />
            <TextField
              label="Note for yourself (optional)"
              placeholder="e.g. the name you know them by"
              value={note}
              onChangeText={(v) => setNote(v.slice(0, MAX_NOTE_LENGTH))}
              maxLength={MAX_NOTE_LENGTH}
            />
            <ThemedText type="small" themeColor="textSecondary">
              We store a one-way fingerprint of the number, never the digits — so we can&apos;t show
              it back to you. Your note is how you&apos;ll recognise this row later, and only you
              can read it.
            </ThemedText>
            {addError ? (
              <ThemedText type="small" style={styles.formError}>
                {addError}
              </ThemedText>
            ) : null}
            <Button label="Block this number" onPress={handleAdd} loading={adding} />
          </ThemedView>

          <ThemedView style={styles.block}>
            <ThemedText type="smallBold" themeColor="textSecondary">
              {blocks.length === 1 ? '1 number blocked' : `${blocks.length} numbers blocked`}
            </ThemedText>
            {blocks.length === 0 ? (
              <ThemedText themeColor="textSecondary">
                Nobody blocked. Add a number if you&apos;d rather not ask that person for a vouch.
              </ThemedText>
            ) : (
              <ThemedView style={styles.list}>
                {blocks.map((row) => (
                  <ThemedView
                    key={row.blocked_phone_hash}
                    style={[styles.row, { backgroundColor: theme.backgroundElement }]}>
                    <ThemedView style={styles.rowBody}>
                      <ThemedText type="smallBold">{row.note || 'Blocked number'}</ThemedText>
                      <ThemedText type="small" themeColor="textSecondary">
                        Blocked {formatBlockedOn(row.created_at)}
                      </ThemedText>
                    </ThemedView>
                    <Button
                      label={confirmingHash === row.blocked_phone_hash ? 'Tap again' : 'Unblock'}
                      variant="soft"
                      loading={removingHash === row.blocked_phone_hash}
                      onPress={() => handleRemovePress(row.blocked_phone_hash)}
                      style={styles.rowButton}
                    />
                  </ThemedView>
                ))}
              </ThemedView>
            )}
          </ThemedView>
        </ScrollView>
      </KeyboardAvoidingView>
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
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    borderRadius: Spacing.three,
    padding: Spacing.three,
    minHeight: 56,
  },
  rowBody: {
    flex: 1,
    gap: Spacing.half,
    backgroundColor: 'transparent',
  },
  rowButton: {
    alignSelf: 'center',
    minHeight: 44,
    paddingHorizontal: Spacing.three,
  },
  formError: {
    color: '#B3261E',
  },
});
