import { Redirect, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Button } from '@/components/ui/button';
import { TextField } from '@/components/ui/text-field';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/lib/supabase';

const RESEND_COOLDOWN_S = 30;

export default function VerifyScreen() {
  const router = useRouter();
  const { phone } = useLocalSearchParams<{ phone: string }>();
  const { refreshProfile } = useAuth();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(RESEND_COOLDOWN_S);
  const submitting = useRef(false);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  if (!phone) return <Redirect href="/sign-in" />;

  async function verify(token: string) {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    const { error: verifyError } = await supabase.auth.verifyOtp({
      phone: phone!,
      token,
      type: 'sms',
    });
    if (verifyError) {
      submitting.current = false;
      setBusy(false);
      setCode('');
      setError("That code isn't right or has expired. Try again or resend.");
      return;
    }
    const profile = await refreshProfile();
    submitting.current = false;
    setBusy(false);
    router.replace(profile ? '/(tabs)' : '/profile-setup');
  }

  async function resend() {
    setError(null);
    setCode('');
    const { error: otpError } = await supabase.auth.signInWithOtp({ phone: phone! });
    if (otpError) {
      setError('Could not resend just yet — wait a moment and try again.');
      return;
    }
    setCooldown(RESEND_COOLDOWN_S);
  }

  return (
    <ThemedView style={styles.container}>
      <KeyboardAvoidingView
        style={styles.inner}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ThemedView style={styles.content}>
          <ThemedText type="subtitle">Check your messages</ThemedText>
          <ThemedText themeColor="textSecondary">
            We texted a 6-digit code to {phone}.
          </ThemedText>
          <TextField
            label="Code"
            placeholder="123456"
            keyboardType="number-pad"
            autoFocus
            maxLength={6}
            value={code}
            onChangeText={(next) => {
              setCode(next);
              if (error) setError(null);
              if (next.length === 6) verify(next);
            }}
            error={error}
          />
          <Button label="Verify" onPress={() => verify(code)} loading={busy} disabled={code.length !== 6} />
          <Button
            label={cooldown > 0 ? `Resend code (${cooldown}s)` : 'Resend code'}
            variant="soft"
            disabled={cooldown > 0}
            onPress={resend}
          />
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
