-- M6: invites, referrals & free-month credits (spec §3/M6). Also pulls
-- private_blocks forward from M9 (spec §3) because M6's contact picker
-- pre-filters a trader's vouch-request contact list against it.

-- ---------------------------------------------------------------------------
-- invites — bearer-capability tokens (spec §3). Tokens are never publicly
-- listable; resolution only via the resolve-invite edge function (service
-- role, anon-callable). No client writes: create-invite (service role) is
-- the only writer.
-- ---------------------------------------------------------------------------
create table public.invites (
  id uuid primary key default gen_random_uuid(),
  inviter_user_id uuid not null references public.users (id),
  kind text not null check (kind in ('vouch_request', 'join_invite')),
  trader_id uuid references public.trader_profiles (id),
  token text unique not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  -- vouch_request invites always name the trader being vouched for;
  -- join_invite is trader-agnostic (matches create-invite's own branching).
  constraint invites_trader_id_matches_kind check (
    (kind = 'vouch_request' and trader_id is not null) or
    (kind = 'join_invite' and trader_id is null)
  )
);

create index invites_inviter_idx on public.invites (inviter_user_id);

alter table public.invites enable row level security;

create policy "inviter reads own invites" on public.invites
  for select to authenticated
  using (inviter_user_id = auth.uid());

grant select on public.invites to authenticated;
grant all on public.invites to service_role;

-- ---------------------------------------------------------------------------
-- private_blocks — pulled forward from M9 (spec §3): a trader's own list of
-- phone hashes to exclude from their vouch-request contact picker (M6/M7).
-- Purely private data: never visible to anyone but the trader, including
-- admins by default. Owner reads/writes directly (no edge function needed —
-- there's no cross-user data here to protect).
-- ---------------------------------------------------------------------------
create table public.private_blocks (
  trader_user_id uuid not null references public.users (id),
  blocked_phone_hash text not null,
  note text,
  created_at timestamptz not null default now(),
  primary key (trader_user_id, blocked_phone_hash)
);

alter table public.private_blocks enable row level security;

create policy "owner reads own blocks" on public.private_blocks
  for select to authenticated
  using (trader_user_id = auth.uid());

create policy "owner inserts own blocks" on public.private_blocks
  for insert to authenticated
  with check (trader_user_id = auth.uid());

create policy "owner deletes own blocks" on public.private_blocks
  for delete to authenticated
  using (trader_user_id = auth.uid());

grant select, insert, delete on public.private_blocks to authenticated;
grant all on public.private_blocks to service_role;

-- ---------------------------------------------------------------------------
-- referrals — add the referred phone's fingerprint (M6.3 farming defense):
-- a phone number can only ever earn one credited referral, even across
-- account deletion + re-signup with the same number (M1.4 frees the number
-- but the fingerprint survives on the old, now-anonymized row).
-- ---------------------------------------------------------------------------
alter table public.referrals add column referred_phone_hash text;

-- the farming check probes "has this phone already earned a credit"
create index referrals_credited_phone_idx on public.referrals (referred_phone_hash)
  where credited = true;
