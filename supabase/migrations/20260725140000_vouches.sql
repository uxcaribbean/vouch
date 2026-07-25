-- M5: vouches — the recommendation object (spec §3/M5). Positive-only:
-- there is no negative path anywhere in this schema. All writes go through
-- the upsert-vouch / remove-vouch edge functions (service role) so the
-- anti-gaming gate and rate limit can never be bypassed via direct
-- REST/PostgREST writes — clients get read-only access via RLS.

create table public.vouches (
  id uuid primary key default gen_random_uuid(),
  voucher_user_id uuid not null references public.users (id),
  trader_id uuid not null references public.trader_profiles (id),
  trade_id int not null references public.trades (id),
  comment text check (comment is null or char_length(comment) <= 400),
  source text not null check (source in ('app', 'weblink')),
  status text not null default 'published'
    check (status in ('published', 'removed_by_user', 'removed_by_admin')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- one vouch per (voucher, trader, trade): vouching for a trade says
  -- nothing about the trader's other trades (spec M5.1).
  unique (voucher_user_id, trader_id, trade_id)
);

create trigger vouches_updated_at
  before update on public.vouches
  for each row execute function public.set_updated_at();

-- count aggregation for search_traders below (trader_id, status) and the
-- voucher's own "my vouches" lookups (voucher_user_id).
create index vouches_trader_status_idx on public.vouches (trader_id, status);
create index vouches_voucher_idx on public.vouches (voucher_user_id);

-- ---------------------------------------------------------------------------
-- Row Level Security — read-only for clients. Published vouches are public;
-- a voucher can also see their own rows in any status (so they can find and
-- edit/remove a 'removed_by_user' row, or see a 'removed_by_admin' lock).
-- No insert/update/delete policies for any client role: creation, editing,
-- republishing and removal are all edge-function (service role) only.
-- ---------------------------------------------------------------------------
alter table public.vouches enable row level security;

create policy "published vouches are public" on public.vouches
  for select using (status = 'published');

create policy "voucher reads own rows" on public.vouches
  for select to authenticated
  using (voucher_user_id = auth.uid());

grant select on public.vouches to anon, authenticated;
grant all on public.vouches to service_role;

-- ---------------------------------------------------------------------------
-- search_traders: CREATE OR REPLACE from M3 (20260711000400_directory_search)
-- with the same signature and column list. vouch_count is now the trader's
-- real count of published vouches (index-friendly scalar subselect against
-- vouches_trader_status_idx above); friend_vouch_count stays hardcoded 0
-- until M4. Sort contract (spec M3.4, M5): friend-vouch count desc, total
-- vouch count desc, newest — lapsed last within their band.
-- ---------------------------------------------------------------------------
create or replace function public.search_traders(
  p_trade_id int default null,
  p_region_id int default null,
  p_limit int default 50,
  p_offset int default 0
)
returns table (
  trader_id uuid,
  user_id uuid,
  display_name text,
  business_name text,
  photo_url text,
  avatar_url text,
  status text,
  created_at timestamptz,
  trade_names text[],
  region_names text[],
  vouch_count int,
  friend_vouch_count int
)
language sql
stable
security definer
set search_path = public
as $$
  select
    tp.id as trader_id,
    tp.user_id,
    u.display_name,
    tp.business_name,
    tp.photo_url,
    u.avatar_url,
    tp.status,
    tp.created_at,
    (select array_agg(t.name order by t.name)
       from trader_trades tt
       join trades t on t.id = tt.trade_id
      where tt.trader_id = tp.id) as trade_names,
    (select array_agg(r.name order by r.sort)
       from trader_regions tr
       join regions r on r.id = tr.region_id
      where tr.trader_id = tp.id) as region_names,
    (select count(*)::int
       from vouches v
      where v.trader_id = tp.id and v.status = 'published') as vouch_count,
    0 as friend_vouch_count  -- real aggregate arrives with M4
  from trader_profiles tp
  join users u on u.id = tp.user_id
  where tp.status in ('active', 'lapsed')
    and tp.onboarding_complete
    and u.deleted_at is null
    and (p_trade_id is null or exists (
      select 1 from trader_trades tt
      where tt.trader_id = tp.id and tt.trade_id = p_trade_id))
    and (p_region_id is null or p_region_id = 1 or exists (
      select 1 from trader_regions tr
      where tr.trader_id = tp.id and tr.region_id in (p_region_id, 1)))
  order by
    friend_vouch_count desc,
    vouch_count desc,
    (tp.status = 'active') desc,
    tp.created_at desc
  limit least(coalesce(p_limit, 50), 100)
  offset greatest(coalesce(p_offset, 0), 0)
$$;

grant execute on function public.search_traders to anon, authenticated;
