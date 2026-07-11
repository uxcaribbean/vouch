import { createClient, type User } from "@supabase/supabase-js";

/** Privileged client — bypasses RLS. Edge functions only, never shipped. */
export function serviceClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

/** Resolves the calling user from the request's JWT, or null. */
export async function getAuthUser(req: Request): Promise<User | null> {
  const token = (req.headers.get("Authorization") ?? "").replace(
    /^Bearer\s+/i,
    "",
  );
  if (!token) return null;
  const client = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  const { data, error } = await client.auth.getUser(token);
  return error ? null : data.user;
}
