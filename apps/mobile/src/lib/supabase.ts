import "react-native-url-polyfill/auto";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@vouch/shared";
import { Platform } from "react-native";

const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  throw new Error(
    "Missing EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY — copy apps/mobile/.env.example to .env",
  );
}

export const supabase = createClient<Database>(url, anonKey, {
  auth: {
    // AsyncStorage's web shim breaks in Node during static export;
    // supabase-js's built-in default is environment-safe on web.
    storage: Platform.OS === "web" ? undefined : AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});

/**
 * Calls an edge function and unwraps our { error: "code" } JSON shape so
 * screens can branch on machine-readable codes instead of HTTP plumbing.
 */
export async function invokeFunction<T>(
  name: string,
  body: Record<string, unknown> = {},
): Promise<{ data: T | null; errorCode: string | null }> {
  const { data, error } = await supabase.functions.invoke<T>(name, { body });
  if (!error) return { data, errorCode: null };
  // FunctionsHttpError carries the Response; our functions always send JSON
  const context = (error as { context?: Response }).context;
  if (context) {
    try {
      const payload = await context.json();
      return { data: null, errorCode: payload.error ?? "unknown_error" };
    } catch {
      /* fall through */
    }
  }
  return { data: null, errorCode: "network_error" };
}
