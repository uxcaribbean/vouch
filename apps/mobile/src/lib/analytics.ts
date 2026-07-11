import type { Session } from '@supabase/supabase-js';

import { supabase } from '@/lib/supabase';

/**
 * Fire-and-forget event logging (spec M11 contract, used ahead of schedule
 * by M3 search/contact tracking). Logged-in only — skip silently when there
 * is no session, since search & browse must fully work logged out (M3).
 */
export async function trackEvent(
  session: Session | null,
  name: string,
  props: Record<string, string | number | boolean | null>,
): Promise<void> {
  if (!session) return;
  await supabase.from('events').insert({ user_id: session.user.id, name, props });
}
