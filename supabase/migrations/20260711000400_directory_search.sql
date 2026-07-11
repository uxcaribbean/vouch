-- M3: the directory. A definer view for public trader data (including the
-- contact phone, exposed ONLY while status = 'active' — listing yourself is
-- consenting to be contacted; lapsing revokes it, spec M2.3/M3.5) and the
-- search RPC behind every results list.

create view public.trader_directory as
select
  tp.id as trader_id,
  tp.user_id,
  tp.status,
  tp.business_name,
  tp.bio,
  tp.photo_url,
  tp.created_at,
  u.display_name,
  u.avatar_url,
  case when tp.status = 'active' then u.phone_e164 end as phone_e164
from public.trader_profiles tp
join public.users u on u.id = tp.user_id
where tp.status in ('active', 'lapsed')
  and u.deleted_at is null;

grant select on public.trader_directory to anon, authenticated;

-- ---------------------------------------------------------------------------
-- search_traders: trade + region → ranked cards. Works logged out.
--
-- Region semantics: a trader serving region 1 ("Trinidad") serves everywhere;
-- searching region 1 / null means "All Trinidad".
--
-- Sort contract (spec M3.4): friend-vouch count desc, total vouch count
-- desc, newest — lapsed last within their band. friend/vouch counts are 0
-- until M4/M5 land; those migrations CREATE OR REPLACE this function with
-- the real aggregates. The column contract here is what clients bind to.
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
    tp.id,
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
      where tt.trader_id = tp.id),
    (select array_agg(r.name order by r.sort)
       from trader_regions tr
       join regions r on r.id = tr.region_id
      where tr.trader_id = tp.id),
    0,  -- vouch_count: real aggregate arrives with M5
    0   -- friend_vouch_count: arrives with M4
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
    (tp.status = 'active') desc,
    tp.created_at desc
  limit least(coalesce(p_limit, 50), 100)
  offset greatest(coalesce(p_offset, 0), 0)
$$;

grant execute on function public.search_traders to anon, authenticated;
