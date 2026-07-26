-- M4: contact sync & graph matching (the USP). Contract under test:
-- scripts/acceptance/test-m4.mjs. Real writes to contact_hashes only ever
-- happen through the sync-contacts edge function (service role) — clients
-- keep their existing read/delete-only grants from M1 (20260711000200).
--
-- This migration:
--   a. search_traders — viewer-aware friend_vouch_count via auth.uid(),
--      matched against contact_hashes; adds p_friends_only. The signature
--      changes (new boolean param ahead of the pagination args), so this is
--      DROP + CREATE, not CREATE OR REPLACE (Postgres cannot change an
--      existing function's parameter list in place).
--   b. trader_summary(p_trader_id) — a single JSON object (not a row) for
--      trader-profile screens: totals, per-trade breakdown, friend count,
--      up to 3 distinct friend voucher names.
--   c. contacts_on_vouch() — the reverse prompt: which of my contacts are
--      already traders I haven't vouched for yet.

-- ---------------------------------------------------------------------------
-- a. search_traders — same return columns as the M5 version; adds
--    p_friends_only. The friend join walks contact_hashes on its primary
--    key (owner_user_id, phone_hash), so it stays index-friendly.
-- ---------------------------------------------------------------------------
drop function public.search_traders(int, int, int, int);

create function public.search_traders(
  p_trade_id int default null,
  p_region_id int default null,
  p_friends_only boolean default false,
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
  with base as (
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
      -- null-safe for anon: auth.uid() is null -> short-circuits to 0
      -- without touching contact_hashes at all. DISTINCT vouchers, not vouch
      -- rows: the UI says "N people you know", and one contact vouching a
      -- trader on two trades is still one person.
      case when auth.uid() is null then 0 else (
        select count(distinct voucher.id)::int
        from vouches v
        join users voucher on voucher.id = v.voucher_user_id
        join contact_hashes ch
          on ch.owner_user_id = auth.uid()
         and ch.phone_hash = voucher.phone_hash
        where v.trader_id = tp.id and v.status = 'published'
      ) end as friend_vouch_count
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
  )
  select
    trader_id, user_id, display_name, business_name, photo_url, avatar_url,
    status, created_at, trade_names, region_names, vouch_count,
    friend_vouch_count
  from base
  -- friends-only applies only to logged-in callers; anon silently ignores
  -- the flag and gets normal results (spec M4.4, test-m4.mjs).
  where (not p_friends_only) or auth.uid() is null or friend_vouch_count > 0
  order by
    friend_vouch_count desc,
    vouch_count desc,
    (status = 'active') desc,
    created_at desc
  limit least(coalesce(p_limit, 50), 100)
  offset greatest(coalesce(p_offset, 0), 0)
$$;

grant execute on function public.search_traders to anon, authenticated;

-- ---------------------------------------------------------------------------
-- b. trader_summary — one JSON object per trader-profile screen. `returns
--    json` (not `setof`/`table`) so PostgREST delivers a single object, not
--    an array. Friend fields are 0/empty for anon or unsynced viewers —
--    never null. friend_vouch_count counts DISTINCT matched vouchers —
--    "N people you know" counts people, matching search_traders;
--    friend_voucher_names is up to 3 of those people's names.
-- ---------------------------------------------------------------------------
create or replace function public.trader_summary(p_trader_id uuid)
returns json
language sql
stable
security definer
set search_path = public
as $$
  with published as (
    select v.id, v.trade_id, v.voucher_user_id
    from vouches v
    where v.trader_id = p_trader_id and v.status = 'published'
  ),
  by_trade as (
    select t.name, count(*)::int as cnt
    from published p
    join trades t on t.id = p.trade_id
    group by t.name
  ),
  friend_vouch_rows as (
    -- empty when auth.uid() is null: nothing to match against.
    select p.id as vouch_id, voucher.id as voucher_id, voucher.display_name
    from published p
    join users voucher on voucher.id = p.voucher_user_id
    join contact_hashes ch
      on ch.owner_user_id = auth.uid()
     and ch.phone_hash = voucher.phone_hash
    where auth.uid() is not null
  ),
  friend_names as (
    select distinct voucher_id, display_name from friend_vouch_rows limit 3
  )
  select json_build_object(
    'vouch_count_total', (select count(*)::int from published),
    'vouch_count_by_trade',
      coalesce((select jsonb_object_agg(name, cnt) from by_trade), '{}'::jsonb),
    'friend_vouch_count', (select count(distinct voucher_id)::int from friend_vouch_rows),
    'friend_voucher_names',
      coalesce((select json_agg(display_name) from friend_names), '[]'::json)
  );
$$;

grant execute on function public.trader_summary to anon, authenticated;

-- ---------------------------------------------------------------------------
-- c. contacts_on_vouch — the reverse prompt: traders among the caller's
--    contacts they haven't already vouched for, excluding their own trader
--    profile. Empty for anon (auth.uid() is null -> the join never matches).
--    Grant is authenticated-only: anon gets no execute privilege at all.
-- ---------------------------------------------------------------------------
create or replace function public.contacts_on_vouch()
returns table (
  trader_id uuid,
  user_id uuid,
  display_name text,
  business_name text,
  photo_url text,
  avatar_url text,
  trade_names text[]
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
    (select array_agg(t.name order by t.name)
       from trader_trades tt
       join trades t on t.id = tt.trade_id
      where tt.trader_id = tp.id) as trade_names
  from trader_profiles tp
  join users u on u.id = tp.user_id
  join contact_hashes ch
    on ch.owner_user_id = auth.uid()
   and ch.phone_hash = u.phone_hash
  where auth.uid() is not null
    and tp.status in ('active', 'lapsed')
    and tp.onboarding_complete
    and u.deleted_at is null
    and tp.user_id <> auth.uid()
    and not exists (
      select 1 from vouches v
      where v.trader_id = tp.id
        and v.voucher_user_id = auth.uid()
        and v.status = 'published'
    )
  limit 20
$$;

grant execute on function public.contacts_on_vouch to authenticated;
