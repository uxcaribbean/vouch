-- M1: users, referral scaffolding, credit ledger, account-deletion support.
-- Also created here (schema only, logic lands in later modules):
--   events         (M11 table, needed early for M5's anti-gaming gate)
--   contact_hashes (M4 table, needed by M1.4 account deletion)

-- ---------------------------------------------------------------------------
-- users — one row per auth.users row, id values are identical.
-- No FK to auth.users on purpose: account deletion hard-deletes the auth row
-- (revoking sessions, freeing the phone) while this row lives on anonymized
-- so vouch counts stay intact (spec M1.4).
-- ---------------------------------------------------------------------------
create table public.users (
  id uuid primary key,
  phone_e164 text unique,
  phone_hash text unique,
  display_name text not null,
  avatar_url text,
  home_region_id int references public.regions (id),
  contact_sync_enabled boolean not null default false,
  referral_code text unique not null check (char_length(referral_code) = 6),
  referred_by_user_id uuid references public.users (id),
  role text not null default 'user' check (role in ('user', 'admin')),
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- live accounts always carry a phone; only deleted rows may shed PII
  constraint phone_required_while_active
    check (deleted_at is not null or (phone_e164 is not null and phone_hash is not null))
);

create trigger users_updated_at
  before update on public.users
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- credit_ledger — months of free trader time. +6 signup bonus at profile
-- creation (M1), +1 per credited referral (M6), admin corrections (M9).
-- ---------------------------------------------------------------------------
create table public.credit_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id),
  months int not null,
  reason text not null check (reason in ('signup_bonus', 'referral', 'admin')),
  ref_id uuid,
  created_at timestamptz not null default now()
);

create index credit_ledger_user_idx on public.credit_ledger (user_id);

-- ---------------------------------------------------------------------------
-- referrals — row created at signup-with-code (M1); crediting is M6.
-- referred_user_id unique: a user can only ever be referred once.
-- ---------------------------------------------------------------------------
create table public.referrals (
  id uuid primary key default gen_random_uuid(),
  referrer_user_id uuid not null references public.users (id),
  referred_user_id uuid unique not null references public.users (id),
  credited boolean not null default false,
  created_at timestamptz not null default now()
);

create index referrals_referrer_idx on public.referrals (referrer_user_id);

-- ---------------------------------------------------------------------------
-- events — analytics + the M5 gate's "prior contact ≥7 days" evidence.
-- Spec M11 table, created early so tracking starts with the first build.
-- ---------------------------------------------------------------------------
create table public.events (
  id bigint generated always as identity primary key,
  user_id uuid references public.users (id),
  name text not null,
  props jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index events_user_name_idx on public.events (user_id, name, created_at);

-- ---------------------------------------------------------------------------
-- contact_hashes — sha256(E.164) fingerprints only. NO names, NO raw
-- numbers, ever. Sync logic is M4; the table exists now because account
-- deletion (M1.4) must hard-delete these rows.
-- ---------------------------------------------------------------------------
create table public.contact_hashes (
  owner_user_id uuid not null references public.users (id) on delete cascade,
  phone_hash text not null,
  created_at timestamptz not null default now(),
  primary key (owner_user_id, phone_hash)
);

-- graph matching scans by hash (spec §6: 1M hashes, P95 < 500ms)
create index contact_hashes_hash_idx on public.contact_hashes (phone_hash);

-- ---------------------------------------------------------------------------
-- Admin helper for later policies. SECURITY DEFINER so policies on users
-- itself can call it without RLS recursion.
-- ---------------------------------------------------------------------------
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.users
    where id = auth.uid() and role = 'admin' and deleted_at is null
  );
$$;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.users enable row level security;
alter table public.credit_ledger enable row level security;
alter table public.referrals enable row level security;
alter table public.events enable row level security;
alter table public.contact_hashes enable row level security;

-- users: read/update own row only. Row creation happens exclusively in the
-- complete-profile edge function (service role). Other people's names are
-- exposed via the public_profiles view below, never the table.
create policy "users read own row" on public.users
  for select to authenticated
  using (id = auth.uid());

create policy "users update own row" on public.users
  for update to authenticated
  using (id = auth.uid() and deleted_at is null)
  with check (id = auth.uid() and deleted_at is null);

-- Explicit grants (tables are not auto-exposed to API roles). Note users
-- gets NO grant for anon and only column-scoped update for authenticated:
-- identity, referral and role columns are edge-function/service-role
-- territory.
grant all on public.users, public.credit_ledger, public.referrals,
  public.events, public.contact_hashes to service_role;
grant usage, select on sequence public.events_id_seq to service_role;

grant select on public.users to authenticated;
grant update (display_name, avatar_url, home_region_id, contact_sync_enabled)
  on public.users to authenticated;
grant select on public.credit_ledger to authenticated;
grant select on public.referrals to authenticated;
grant select, insert on public.events to authenticated;
grant usage on sequence public.events_id_seq to authenticated;
grant select, delete on public.contact_hashes to authenticated;
grant execute on function public.is_admin() to anon, authenticated;

-- credit_ledger / referrals: visible to their owner, written only by
-- edge functions (service role).
create policy "own credit rows" on public.credit_ledger
  for select to authenticated
  using (user_id = auth.uid());

create policy "own referrals" on public.referrals
  for select to authenticated
  using (referrer_user_id = auth.uid() or referred_user_id = auth.uid());

-- events: clients may record their own events; only admins read.
create policy "insert own events" on public.events
  for insert to authenticated
  with check (user_id = auth.uid());

create policy "admin reads events" on public.events
  for select to authenticated
  using (public.is_admin());

-- contact_hashes: owner can see and delete their fingerprints (Settings →
-- disable sync). Uploads go through the sync edge function only (M4).
create policy "own hashes read" on public.contact_hashes
  for select to authenticated
  using (owner_user_id = auth.uid());

create policy "own hashes delete" on public.contact_hashes
  for delete to authenticated
  using (owner_user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- public_profiles — the only publicly readable projection of users.
-- Deliberately a definer-style view (owner bypasses users RLS): it exposes
-- exactly the columns the product shows on vouches and trader cards.
-- ---------------------------------------------------------------------------
create view public.public_profiles as
  select
    id,
    display_name,
    avatar_url,
    created_at,
    (deleted_at is not null) as is_deleted
  from public.users;

grant select on public.public_profiles to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Avatar storage: public-read bucket, users write only inside their own
-- <uid>/ folder.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true);

create policy "avatar upload to own folder" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "avatar update own folder" on storage.objects
  for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "avatar delete own folder" on storage.objects
  for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
