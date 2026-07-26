-- M8: notifications & nudges (spec §3/M8). Contract under test:
-- scripts/acceptance/test-m8.mjs.
--
-- The observable of this module is notification_log: EVERY send decision is
-- recorded, including the ones that decided not to send. Toggles and the
-- 2-pushes/week cap are enforced server-side (spec M8 "Rules"), in
-- supabase/functions/_shared/notify.ts — never in the client.
--
-- Three tables:
--   push_tokens        — the device registry (own-device data: direct client
--                        writes, no edge function needed)
--   notification_prefs — per-type opt-out; an ABSENT row means enabled
--   notification_log   — the audit trail + the input to the cap check

-- ---------------------------------------------------------------------------
-- push_tokens — Expo push tokens, one row per (user, device token). This is
-- the user's own device data, not anyone else's, so iron rule 4 doesn't
-- apply: the client registers and revokes its own token directly under RLS.
-- ---------------------------------------------------------------------------
create table public.push_tokens (
  user_id uuid not null references public.users (id),
  token text not null,
  platform text not null check (platform in ('ios', 'android')),
  created_at timestamptz not null default now(),
  primary key (user_id, token)
);

alter table public.push_tokens enable row level security;

create policy "owner reads own tokens" on public.push_tokens
  for select to authenticated
  using (user_id = auth.uid());

create policy "owner registers own tokens" on public.push_tokens
  for insert to authenticated
  with check (user_id = auth.uid());

-- Re-registering an existing token is a normal app-launch event (Expo hands
-- back the same token), so the owner may also touch their own row — that is
-- what makes an idempotent upsert from the device legal.
create policy "owner refreshes own tokens" on public.push_tokens
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "owner revokes own tokens" on public.push_tokens
  for delete to authenticated
  using (user_id = auth.uid());

grant select, insert, update, delete on public.push_tokens to authenticated;
grant all on public.push_tokens to service_role;

-- ---------------------------------------------------------------------------
-- notification_prefs — one row per (user, type) ONLY when the user has
-- opted out (or explicitly opted back in). Absent row = enabled, so a fresh
-- account needs no backfill and new types default on.
-- ---------------------------------------------------------------------------
create table public.notification_prefs (
  user_id uuid not null references public.users (id),
  type text not null check (type in (
    'vouch_received',
    'referral_credited',
    'contacts_joined_traders',
    'sync_nudge'
  )),
  enabled boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (user_id, type)
);

create trigger notification_prefs_updated_at
  before update on public.notification_prefs
  for each row execute function public.set_updated_at();

alter table public.notification_prefs enable row level security;

create policy "owner reads own prefs" on public.notification_prefs
  for select to authenticated
  using (user_id = auth.uid());

create policy "owner sets own prefs" on public.notification_prefs
  for insert to authenticated
  with check (user_id = auth.uid());

create policy "owner updates own prefs" on public.notification_prefs
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

grant select, insert, update on public.notification_prefs to authenticated;
grant all on public.notification_prefs to service_role;

-- ---------------------------------------------------------------------------
-- notification_log — one row per send DECISION, never more, never fewer:
--   sent         delivered to Expo
--   no_token     nothing to deliver to
--   error        Expo rejected it or the request failed
--   skipped_pref the user turned this type off
--   skipped_cap  the 2/week non-transactional cap was already spent
-- Writes are service-role only (the cap is worthless if a client can forge
-- or delete rows); owners may read their own history.
-- ---------------------------------------------------------------------------
create table public.notification_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id),
  type text not null,
  title text,
  body text,
  data jsonb not null default '{}',
  status text not null check (status in (
    'sent',
    'no_token',
    'error',
    'skipped_pref',
    'skipped_cap'
  )),
  created_at timestamptz not null default now()
);

-- serves both cap counting (user + status + window) and the per-type
-- cooldown lookups the digests run for every candidate.
create index notification_log_user_type_created_idx
  on public.notification_log (user_id, type, created_at);

alter table public.notification_log enable row level security;

create policy "owner reads own notification log" on public.notification_log
  for select to authenticated
  using (user_id = auth.uid());

grant select on public.notification_log to authenticated;
grant all on public.notification_log to service_role;
