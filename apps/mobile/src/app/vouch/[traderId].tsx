import type { Tables } from '@vouch/shared';
import { Image } from 'expo-image';
import { Redirect, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, View } from 'react-native';
import Animated, { Keyframe } from 'react-native-reanimated';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Button } from '@/components/ui/button';
import { TextField } from '@/components/ui/text-field';
import { ToggleChip } from '@/components/ui/toggle-chip';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useAuth } from '@/lib/auth';
import { invokeFunction, supabase } from '@/lib/supabase';
import { TRADER_PROFILE_SELECT, tradeChipLabel, type TraderTradeJoin } from '@/lib/trader-profile';

type DirectoryRow = {
  trader_id: string;
  status: string;
  business_name: string | null;
  display_name: string | null;
  photo_url: string | null;
  avatar_url: string | null;
};

type LoadState = 'loading' | 'not_found' | 'ready';
type ExistingVouch = Pick<Tables<'vouches'>, 'id' | 'comment' | 'status'>;
type UpsertVouchResponse = { vouch: Tables<'vouches'>; created: boolean };

const MAX_COMMENT_LENGTH = 400;
const CONFIRM_RESET_MS = 4000;

/** Gate/error copy — the gate_not_met wording is exact per spec §M5 rule 3. */
const ERROR_COPY: Record<string, string> = {
  gate_not_met:
    'You can vouch for people you know — save their number or ask them for their vouch link.',
  rate_limited:
    'New accounts can give up to 5 vouches in their first day — try again tomorrow.',
  vouch_locked: "This vouch was removed by the VOUCH team and can't be re-posted.",
};
const FALLBACK_ERROR = 'Something went wrong sending your vouch. Try again.';

export default function VouchComposerScreen() {
  const router = useRouter();
  const theme = useTheme();
  const { session, profile, initializing } = useAuth();
  const { traderId, trade: tradeParam } = useLocalSearchParams<{ traderId: string; trade?: string }>();

  const [state, setState] = useState<LoadState>(() => (traderId ? 'loading' : 'not_found'));
  const [directory, setDirectory] = useState<DirectoryRow | null>(null);
  const [trades, setTrades] = useState<TraderTradeJoin[]>([]);
  const [selectedTradeId, setSelectedTradeId] = useState<number | null>(() =>
    tradeParam ? Number(tradeParam) : null,
  );

  const [existing, setExisting] = useState<ExistingVouch | null>(null);
  const [existingLoaded, setExistingLoaded] = useState(false);

  const [comment, setComment] = useState('');
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [showSuccess, setShowSuccess] = useState(false);

  useEffect(() => {
    if (!traderId) return;
    let cancelled = false;
    Promise.all([
      supabase
        .from('trader_directory')
        .select('trader_id,status,business_name,display_name,photo_url,avatar_url')
        .eq('trader_id', traderId)
        .maybeSingle(),
      supabase.from('trader_profiles').select(TRADER_PROFILE_SELECT).eq('id', traderId).maybeSingle(),
    ]).then(([dirRes, joinsRes]) => {
      if (cancelled) return;
      if (!dirRes.data) {
        setState('not_found');
        return;
      }
      setDirectory(dirRes.data as DirectoryRow);
      const joins = joinsRes.data as { trader_trades: TraderTradeJoin[] } | null;
      const traderTrades = joins?.trader_trades ?? [];
      setTrades(traderTrades);
      setSelectedTradeId((prev) => {
        const valid = prev != null && traderTrades.some((t) => t.trade_id === prev);
        if (valid) return prev;
        if (traderTrades.length === 1) return traderTrades[0].trade_id;
        return null;
      });
      setState('ready');
    });
    return () => {
      cancelled = true;
    };
  }, [traderId]);

  useEffect(() => {
    if (!session || selectedTradeId == null || !traderId) {
      setExisting(null);
      setExistingLoaded(true);
      return;
    }
    let cancelled = false;
    setExistingLoaded(false);
    supabase
      .from('vouches')
      .select('id,comment,status')
      .eq('voucher_user_id', session.user.id)
      .eq('trader_id', traderId)
      .eq('trade_id', selectedTradeId)
      .maybeSingle()
      .then(({ data }) => {
        if (cancelled) return;
        setExisting(data ?? null);
        setComment(data?.comment ?? '');
        setConfirmingRemove(false);
        setFormError(null);
        setExistingLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [session, traderId, selectedTradeId]);

  // Two-tap remove confirm auto-resets so a stray later tap can't remove.
  useEffect(() => {
    if (!confirmingRemove) return;
    const timer = setTimeout(() => setConfirmingRemove(false), CONFIRM_RESET_MS);
    return () => clearTimeout(timer);
  }, [confirmingRemove]);

  if (!initializing && !session) return <Redirect href="/sign-in" />;
  if (!initializing && session && !profile) return <Redirect href="/profile-setup" />;

  if (initializing || !session || !profile || state === 'loading') {
    return (
      <ThemedView style={styles.container}>
        <ThemedView style={styles.loadingWrap}>
          <ActivityIndicator />
        </ThemedView>
      </ThemedView>
    );
  }

  if (state === 'not_found' || !directory) {
    return (
      <ThemedView style={styles.container}>
        <ThemedView style={styles.loadingWrap}>
          <ThemedText themeColor="textSecondary">This listing isn&apos;t available.</ThemedText>
        </ThemedView>
      </ThemedView>
    );
  }

  const photoUrl = directory.photo_url || directory.avatar_url || null;
  const displayName = directory.business_name || directory.display_name || 'Trader';
  const traderFirstName = (directory.display_name || displayName).split(' ')[0];
  const isLocked = existing?.status === 'removed_by_admin';
  const isEdit = existing?.status === 'published';
  const isRepost = existing?.status === 'removed_by_user';
  const submitLabel = isEdit ? 'Update your vouch' : isRepost ? 'Re-post your vouch' : 'Send your vouch';

  async function handleSubmit() {
    if (!selectedTradeId || busy) return;
    setBusy(true);
    setFormError(null);
    const { data, errorCode } = await invokeFunction<UpsertVouchResponse>('upsert-vouch', {
      trader_id: traderId,
      trade_id: selectedTradeId,
      comment: comment.trim() || undefined,
    });
    setBusy(false);
    if (errorCode) {
      setFormError(ERROR_COPY[errorCode] ?? FALLBACK_ERROR);
      return;
    }
    if (data) {
      setExisting({ id: data.vouch.id, comment: data.vouch.comment, status: data.vouch.status });
    }
    setShowSuccess(true);
  }

  function handleRemovePress() {
    if (!confirmingRemove) {
      setConfirmingRemove(true);
      return;
    }
    void handleRemove();
  }

  async function handleRemove() {
    if (!selectedTradeId || removing) return;
    setRemoving(true);
    setFormError(null);
    const { errorCode } = await invokeFunction('remove-vouch', {
      trader_id: traderId,
      trade_id: selectedTradeId,
    });
    setRemoving(false);
    setConfirmingRemove(false);
    if (errorCode) {
      setFormError(ERROR_COPY[errorCode] ?? FALLBACK_ERROR);
      return;
    }
    router.back();
  }

  if (showSuccess) {
    return <ConfettiOverlay traderFirstName={traderFirstName} onDone={() => router.back()} />;
  }

  return (
    <ThemedView style={styles.container}>
      <ScrollView
        style={styles.inner}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled">
        <ThemedView style={styles.header}>
          {photoUrl ? (
            <Image source={{ uri: photoUrl }} style={styles.photo} contentFit="cover" />
          ) : (
            <ThemedView style={[styles.photo, styles.photoPlaceholder, { backgroundColor: theme.backgroundElement }]}>
              <ThemedText type="small" themeColor="textSecondary">
                No photo
              </ThemedText>
            </ThemedView>
          )}
          <ThemedText type="subtitle" style={styles.headerName}>
            {displayName}
          </ThemedText>
        </ThemedView>

        <ThemedView style={styles.block}>
          <ThemedText type="smallBold" themeColor="textSecondary">
            What did they help with?
          </ThemedText>
          {trades.length > 0 ? (
            <ThemedView style={styles.chipList}>
              {trades.map((t) => (
                <ToggleChip
                  key={t.trade_id}
                  label={tradeChipLabel(t)}
                  selected={selectedTradeId === t.trade_id}
                  onPress={() => setSelectedTradeId(t.trade_id)}
                />
              ))}
            </ThemedView>
          ) : (
            <ThemedText themeColor="textSecondary">This trader has no services listed yet.</ThemedText>
          )}
          {selectedTradeId == null && trades.length > 1 ? (
            <ThemedText type="small" themeColor="textSecondary">
              Pick which service they helped with above.
            </ThemedText>
          ) : null}
        </ThemedView>

        {selectedTradeId != null && existingLoaded ? (
          isLocked ? (
            <ThemedView style={styles.block}>
              <ThemedText type="small" style={styles.formError}>
                {ERROR_COPY.vouch_locked}
              </ThemedText>
            </ThemedView>
          ) : (
            <ThemedView style={styles.block}>
              <ThemedView style={styles.commentWrap}>
                <TextField
                  label="Say something (optional)"
                  placeholder="What did they do well?"
                  value={comment}
                  onChangeText={(v) => setComment(v.slice(0, MAX_COMMENT_LENGTH))}
                  maxLength={MAX_COMMENT_LENGTH}
                  multiline
                  style={styles.commentInput}
                />
                <ThemedText type="small" themeColor="textSecondary" style={styles.counter}>
                  {comment.length}/{MAX_COMMENT_LENGTH}
                </ThemedText>
              </ThemedView>

              {formError ? (
                <ThemedText type="small" style={styles.formError}>
                  {formError}
                </ThemedText>
              ) : null}

              <Button label={submitLabel} onPress={handleSubmit} loading={busy} disabled={busy || removing} />

              {isEdit ? (
                <Button
                  label={confirmingRemove ? 'Tap again to confirm' : 'Remove my vouch'}
                  variant="soft"
                  onPress={handleRemovePress}
                  loading={removing}
                  disabled={busy}
                />
              ) : null}
            </ThemedView>
          )
        ) : null}
      </ScrollView>
    </ThemedView>
  );
}

const PARTICLE_EMOJI = ['🎉', '⭐', '💛'];
const PARTICLE_COUNT = 12;
const OVERLAY_DURATION_MS = 1500;
const PARTICLE_DURATION_MS = 1200;

function ConfettiOverlay({ traderFirstName, onDone }: { traderFirstName: string; onDone: () => void }) {
  const theme = useTheme();

  useEffect(() => {
    const timer = setTimeout(onDone, OVERLAY_DURATION_MS);
    return () => clearTimeout(timer);
    // onDone is router.back — stable enough for a one-shot timer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const particles = useMemo(
    () =>
      Array.from({ length: PARTICLE_COUNT }, (_, i) => {
        const angle = (Math.PI * 2 * i) / PARTICLE_COUNT + (Math.random() - 0.5) * 0.5;
        const distance = 80 + Math.random() * 70;
        return {
          key: i,
          emoji: PARTICLE_EMOJI[i % PARTICLE_EMOJI.length],
          dx: Math.cos(angle) * distance,
          dy: Math.sin(angle) * distance,
          delay: Math.random() * 150,
        };
      }),
    [],
  );

  return (
    <ThemedView style={[styles.container, styles.overlayContainer]}>
      <View style={[StyleSheet.absoluteFill, styles.particleField]} pointerEvents="none">
        {particles.map((p) => {
          const keyframe = new Keyframe({
            0: { transform: [{ translateX: 0 }, { translateY: 0 }, { scale: 0.4 }], opacity: 0 },
            20: { opacity: 1, transform: [{ translateX: 0 }, { translateY: 0 }, { scale: 1.2 }] },
            100: {
              opacity: 0,
              transform: [{ translateX: p.dx }, { translateY: p.dy }, { scale: 0.7 }],
            },
          });
          return (
            <Animated.View
              key={p.key}
              entering={keyframe.duration(PARTICLE_DURATION_MS).delay(p.delay)}
              style={styles.particle}>
              <ThemedText style={styles.particleEmoji}>{p.emoji}</ThemedText>
            </Animated.View>
          );
        })}
      </View>
      <ThemedText type="title" style={styles.center}>
        Vouched!
      </ThemedText>
      <ThemedText type="subtitle" themeColor="textSecondary" style={styles.center}>
        {traderFirstName} thanks you.
      </ThemedText>
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
    gap: Spacing.four,
  },
  loadingWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  header: {
    alignItems: 'center',
    gap: Spacing.two,
  },
  headerName: {
    textAlign: 'center',
  },
  photo: {
    width: 72,
    height: 72,
    borderRadius: Spacing.three,
  },
  photoPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  block: {
    gap: Spacing.three,
  },
  chipList: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  commentWrap: {
    gap: Spacing.one,
  },
  commentInput: {
    minHeight: 100,
    textAlignVertical: 'top',
  },
  counter: {
    textAlign: 'right',
  },
  formError: {
    color: '#B3261E',
  },
  overlayContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.two,
    padding: Spacing.four,
  },
  particleField: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  particle: {
    position: 'absolute',
    top: '50%',
    left: '50%',
    width: 32,
    height: 32,
    marginLeft: -16,
    marginTop: -16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  particleEmoji: {
    fontSize: 28,
  },
  center: {
    textAlign: 'center',
  },
});
