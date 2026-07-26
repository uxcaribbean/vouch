import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useColorScheme } from 'react-native';

import { AnimatedSplashOverlay } from '@/components/animated-icon';
import { AuthProvider } from '@/lib/auth';

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const colorScheme = useColorScheme();
  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      <AuthProvider>
        <AnimatedSplashOverlay />
        <Stack>
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen name="search" options={{ title: 'Find someone' }} />
          <Stack.Screen name="sign-in" options={{ title: 'Sign in' }} />
          <Stack.Screen name="verify" options={{ title: 'Enter code' }} />
          <Stack.Screen
            name="profile-setup"
            options={{ title: 'Your details', headerBackVisible: false, gestureEnabled: false }}
          />
          <Stack.Screen name="settings" options={{ title: 'Settings' }} />
          <Stack.Screen name="sync-contacts" options={{ title: 'People you know' }} />
          <Stack.Screen name="become-a-trader" options={{ title: 'Offer your services' }} />
          <Stack.Screen name="my-trader-profile" options={{ title: 'My trader listing' }} />
          <Stack.Screen name="ask-for-vouches" options={{ title: 'Ask for vouches' }} />
          <Stack.Screen name="trader/[id]" options={{ title: '', headerShown: true }} />
          <Stack.Screen name="vouch/[traderId]" options={{ title: 'Vouch' }} />
        </Stack>
      </AuthProvider>
    </ThemeProvider>
  );
}
