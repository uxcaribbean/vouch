/**
 * Browser Supabase client for the no-install web vouch flow (spec M7).
 *
 * Deliberately mirrors apps/mobile/src/lib/supabase.ts: same env guard, same
 * `invokeFunction` error-unwrapping contract, so a screen written against one
 * behaves identically on the other. Anything touching another user's data
 * still goes through an Edge Function — this client only ever holds the anon
 * key plus the visitor's own session.
 *
 * Client-only: `createClient` reaches for localStorage, so every importer of
 * this module lives behind a `'use client'` boundary. Server components talk
 * to the API with plain `fetch` instead.
 */
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@vouch/shared";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  throw new Error(
    "Missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY — copy apps/web/.env.example to .env.local",
  );
}

export const supabase = createClient<Database>(url, anonKey, {
  auth: {
    autoRefreshToken: true,
    persistSession: true,
    // /v/{token} links never carry auth fragments; parsing them would only
    // add a race against the OTP step.
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
