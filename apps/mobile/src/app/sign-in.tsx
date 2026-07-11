import { normalizePhone } from '@vouch/shared';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Button } from '@/components/ui/button';
import { TextField } from '@/components/ui/text-field';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { supabase } from '@/lib/supabase';

export default function SignInScreen() {
  const router = useRouter();
  const [raw, setRaw] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Trinidad numbers get the +1 868 prefix visually; typing "+" switches to
  // full international entry (spec M1.1).
  const international = raw.trim().startsWith('+');

  async function submit() {
    setError(null);
    const e164 = normalizePhone(raw);
    if (!e164) {
      setError("That doesn't look like a phone number. Try 555-1234 or the full number with country code.");
      return;
    }
    setBusy(true);
    const { error: otpError } = await supabase.auth.signInWithOtp({ phone: e164 });
    setBusy(false);
    if (otpError) {
      setError(
        otpError.message.includes('rate')
          ? 'Too many tries — give it a minute and try again.'
          : "We couldn't send the code. Check the number and try again.",
      );
      return;
    }
    router.push({ pathname: '/verify', params: { phone: e164 } });
  }

  return (
    <ThemedView style={styles.container}>
      <KeyboardAvoidingView
        style={styles.inner}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ThemedView style={styles.content}>
          <ThemedText type="subtitle">What&apos;s your number?</ThemedText>
          <ThemedText themeColor="textSecondary">
            We&apos;ll text you a one-time code. No passwords.
          </ThemedText>
          <TextField
            label="Phone number"
            prefix={international ? undefined : '+1 868'}
            placeholder={international ? '+44 7911 123456' : '555-1234'}
            keyboardType="phone-pad"
            autoFocus
            value={raw}
            onChangeText={(next) => {
              setRaw(next);
              if (error) setError(null);
            }}
            onSubmitEditing={submit}
            error={error}
          />
          <Button label="Text me the code" onPress={submit} loading={busy} />
        </ThemedView>
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
    flex: 1,
    padding: Spacing.four,
    gap: Spacing.three,
  },
});
