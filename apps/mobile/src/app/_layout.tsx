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
          <Stack.Screen name="sign-in" options={{ title: 'Sign in' }} />
          <Stack.Screen name="verify" options={{ title: 'Enter code' }} />
          <Stack.Screen
            name="profile-setup"
            options={{ title: 'Your details', headerBackVisible: false, gestureEnabled: false }}
          />
          <Stack.Screen name="settings" options={{ title: 'Settings' }} />
        </Stack>
      </AuthProvider>
    </ThemeProvider>
  );
}
