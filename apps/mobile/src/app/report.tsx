/**
 * Report a listing or a vouch (spec M9.1).
 *
 * The whole point of the confirmation copy: flags are for FACTUAL problems.
 * VOUCH is positive-only, so "I disagree with this vouch" is deliberately not
 * a reason anyone can pick — the closed enum lives in submit-flag and is
 * mirrored (labels only) below.
 *
 * Params: subject_type ('trader' | 'vouch'), subject_id (uuid),
 * subject_label (what the user sees they're reporting).
 */
import { Redirect, useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Button } from '@/components/ui/button';
import { TextField } from '@/components/ui/text-field';
import { ToggleChip } from '@/components/ui/toggle-chip';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { useAuth } from '@/lib/auth';
import { invokeFunction } from '@/lib/supabase';

const MAX_DETAIL_LENGTH = 500;

/** Values mirror the flags.reason CHECK constraint; labels are ours. */
const REASONS = [
  { value: 'fake_profile', label: 'Fake profile' },
  { value: 'impersonation', label: 'Impersonation' },
  { value: 'wrong_number', label: 'Wrong number' },
  { value: 'spam', label: 'Spam' },
  { value: 'other', label: 'Something else' },
] as const;

type Reason = (typeof REASONS)[number]['value'];

const ERROR_COPY: Record<string, string> = {
  rate_limited: "You've reported a lot today — try again tomorrow.",
  subject_not_found: "That's not here any more — nothing to report.",
  unauthorized: 'Sign in to send a report.',
};
const FALLBACK_ERROR = 'Something went wrong sending your report. Try again.';

export default function ReportScreen() {
  const router = useRouter();
  const { session, initializing } = useAuth();
  const { subject_type: subjectType, subject_id: subjectId, subject_label: subjectLabel } =
    useLocalSearchParams<{
      subject_type?: string;
      subject_id?: string;
      subject_label?: string;
    }>();

  const [reason, setReason] = useState<Reason | null>(null);
  const [detail, setDetail] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  if (!initializing && !session) return <Redirect href="/sign-in" />;

  if (initializing || !session) {
    return (
      <ThemedView style={styles.container}>
        <ThemedView style={styles.loadingWrap}>
          <ActivityIndicator />
        </ThemedView>
      </ThemedView>
    );
  }

  const isVouch = subjectType === 'vouch';
  const subjectMissing = !subjectId || (subjectType !== 'trader' && subjectType !== 'vouch');

  if (subjectMissing) {
    return (
      <ThemedView style={styles.container}>
        <ThemedView style={styles.loadingWrap}>
          <ThemedText themeColor="textSecondary">There&apos;s nothing here to report.</ThemedText>
        </ThemedView>
      </ThemedView>
    );
  }

  async function handleSubmit() {
    if (!reason || busy) return;
    setBusy(true);
    setFormError(null);
    const { errorCode } = await invokeFunction('submit-flag', {
      subject_type: subjectType,
      subject_id: subjectId,
      reason,
      detail: detail.trim() || undefined,
    });
    setBusy(false);
    if (errorCode) {
      setFormError(ERROR_COPY[errorCode] ?? FALLBACK_ERROR);
      return;
    }
    setSent(true);
  }

  if (sent) {
    return (
      <ThemedView style={styles.container}>
        <ScrollView style={styles.inner} contentContainerStyle={styles.content}>
          <ThemedText type="subtitle">Thanks — we&apos;ll take a look.</ThemedText>
          <ThemedText themeColor="textSecondary">
            A real person reads every report. You won&apos;t hear back unless we need more from
            you, and the person you reported is never told who reported them.
          </ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            Vouches can&apos;t be reported just for disagreeing — VOUCH is positive-only. We check
            factual problems: fake profiles, wrong numbers, spam.
          </ThemedText>
          <Button label="Done" onPress={() => router.back()} />
        </ScrollView>
      </ThemedView>
    );
  }

  return (
    <ThemedView style={styles.container}>
      <ScrollView
        style={styles.inner}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled">
        <ThemedView style={styles.block}>
          <ThemedText type="subtitle">
            {isVouch ? 'Report this vouch' : 'Report this listing'}
          </ThemedText>
          {subjectLabel ? (
            <ThemedText themeColor="textSecondary">{subjectLabel}</ThemedText>
          ) : null}
          <ThemedText type="small" themeColor="textSecondary">
            Reports are for factual problems — a fake profile, a number that isn&apos;t theirs,
            spam. Disagreeing with a vouch isn&apos;t one: VOUCH only carries positive
            recommendations, so there&apos;s nothing negative to dispute.
          </ThemedText>
        </ThemedView>

        <ThemedView style={styles.block}>
          <ThemedText type="smallBold" themeColor="textSecondary">
            What&apos;s wrong?
          </ThemedText>
          <ThemedView style={styles.chipList}>
            {REASONS.map((option) => (
              <ToggleChip
                key={option.value}
                label={option.label}
                selected={reason === option.value}
                onPress={() => {
                  setReason(option.value);
                  setFormError(null);
                }}
              />
            ))}
          </ThemedView>
        </ThemedView>

        <ThemedView style={styles.block}>
          <ThemedView style={styles.detailWrap}>
            <TextField
              label="Tell us more (optional)"
              placeholder="What did you notice?"
              value={detail}
              onChangeText={(v) => setDetail(v.slice(0, MAX_DETAIL_LENGTH))}
              maxLength={MAX_DETAIL_LENGTH}
              multiline
              style={styles.detailInput}
            />
            <ThemedText type="small" themeColor="textSecondary" style={styles.counter}>
              {detail.length}/{MAX_DETAIL_LENGTH}
            </ThemedText>
          </ThemedView>

          {formError ? (
            <ThemedText type="small" style={styles.formError}>
              {formError}
            </ThemedText>
          ) : null}

          <Button
            label="Send report"
            onPress={handleSubmit}
            loading={busy}
            disabled={reason === null || busy}
          />
        </ThemedView>
      </ScrollView>
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
    padding: Spacing.four,
  },
  block: {
    gap: Spacing.three,
  },
  chipList: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  detailWrap: {
    gap: Spacing.one,
  },
  detailInput: {
    minHeight: 100,
    textAlignVertical: 'top',
  },
  counter: {
    textAlign: 'right',
  },
  formError: {
    color: '#B3261E',
  },
});
