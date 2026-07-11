-- M2: trader profiles + trade/region junctions.
-- A trader is always also a regular user (spec M2.4); this is a 1:1
-- extension of users, keyed by user_id.

create table public.trader_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid unique not null references public.users (id),
  business_name text,
  bio text check (bio is null or char_length(bio) <= 300),
  photo_url text,
  status text not null default 'active'
    check (status in ('active', 'lapsed', 'suspended', 'hidden')),
  -- convenience flag per spec §3; note "publicly listed" is status in
  -- ('active','lapsed') — lapsed traders stay visible but uncontactable
  visible boolean generated always as (status = 'active') stored,
  free_until date not null,
  onboarding_complete boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger trader_profiles_updated_at
  before update on public.trader_profiles
  for each row execute function public.set_updated_at();

create table public.trader_trades (
  id uuid primary key default gen_random_uuid(),
  trader_id uuid not null references public.trader_profiles (id) on delete cascade,
  trade_id int not null references public.trades (id),
  created_at timestamptz not null default now(),
  unique (trader_id, trade_id)
);

create table public.trader_regions (
  trader_id uuid not null references public.trader_profiles (id) on delete cascade,
  region_id int not null references public.regions (id),
  created_at timestamptz not null default now(),
  primary key (trader_id, region_id)
);

-- M3 searches by trade+region (spec: P95 < 500ms @ 10k traders)
create index trader_trades_trade_idx on public.trader_trades (trade_id);
create index trader_regions_region_idx on public.trader_regions (region_id);

-- ---------------------------------------------------------------------------
-- RLS: the directory is public (logged-out browse), but suspended/hidden
-- traders vanish from everyone except themselves. All structural writes
-- (create, trade/region sets, status, free_until) go through the
-- upsert-trader-profile edge function; owners may edit only cosmetic
-- columns directly.
-- ---------------------------------------------------------------------------
alter table public.trader_profiles enable row level security;
alter table public.trader_trades enable row level security;
alter table public.trader_regions enable row level security;

create policy "listed traders are public" on public.trader_profiles
  for select using (status in ('active', 'lapsed'));

create policy "trader reads own profile" on public.trader_profiles
  for select to authenticated using (user_id = auth.uid());

create policy "trader edits own profile" on public.trader_profiles
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "junctions of listed traders are public" on public.trader_trades
  for select using (exists (
    select 1 from public.trader_profiles tp
    where tp.id = trader_id
      and (tp.status in ('active', 'lapsed') or tp.user_id = auth.uid())
  ));

create policy "region junctions of listed traders are public" on public.trader_regions
  for select using (exists (
    select 1 from public.trader_profiles tp
    where tp.id = trader_id
      and (tp.status in ('active', 'lapsed') or tp.user_id = auth.uid())
  ));

grant all on public.trader_profiles, public.trader_trades, public.trader_regions
  to service_role;
grant select on public.trader_profiles, public.trader_trades, public.trader_regions
  to anon, authenticated;
grant update (business_name, bio, photo_url)
  on public.trader_profiles to authenticated;
