-- M11: the north-star metrics (spec §4/M11 "North-star dashboard"). Contract
-- under test: scripts/acceptance/test-m11.mjs.
--
-- One SECURITY DEFINER function, admin_metrics(), returning a single json
-- object with the four numbers the spec names. No new table, no edge
-- function: the `events` log (M0, spec §3) already holds everything, and the
-- admin dashboard wants one round trip.
--
-- Why events and not the mutable rows: a metric computed from
-- trader_profiles/vouches silently rewrites its own history when a row is
-- edited or a vouch is removed. The events log is append-only, so last
-- month's number stays last month's number.
--
-- Windows: rolling 30 days by created_at for the three event-based blocks.
-- Trader activation is deliberately ALL-TIME on the eligibility side — the
-- cohort question is "of every trader old enough to have had 14 days, how
-- many got to 3 vouches in that window", and clipping the cohort to 30 days
-- would answer a different (and much noisier) question each week.
--
-- Gating differs from admin_ring_report(): that one returns rows and can
-- honestly return zero of them to a non-admin. A metrics object has no
-- meaningful "empty" shape — all-zero numbers read as real data — so this
-- one raises instead. 42501 surfaces as 4xx through PostgREST for both anon
-- and authenticated non-admins.
-- ---------------------------------------------------------------------------
create or replace function public.admin_metrics()
returns json
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_window       constant interval := interval '30 days';
  v_activation   constant interval := interval '14 days';

  v_searches     bigint;
  v_with_friend  bigint;
  v_signups      bigint;
  v_referrals    bigint;
  v_opened       bigint;
  v_weblink      bigint;
  v_eligible     bigint;
  v_activated    bigint;
begin
  if not public.is_admin() then
    raise exception 'admin_required'
      using errcode = '42501',
            detail  = 'admin_metrics is restricted to admin accounts';
  end if;

  -- 1. Friend-search share — "% of searches where >= 1 result has a friend
  -- vouch". The denominator is searches that COULD have reported a friend
  -- result, i.e. events actually carrying the friend_results_count key.
  -- Events logged before the key existed (and any future search variant that
  -- does not compute it) are excluded from both sides rather than counted as
  -- misses; otherwise every schema change would dent the north-star metric.
  select
    count(*) filter (where e.props ? 'friend_results_count'),
    count(*) filter (where (e.props ->> 'friend_results_count')::int > 0)
  into v_searches, v_with_friend
  from events e
  where e.name = 'search_performed'
    and e.created_at >= now() - v_window;

  -- 2. Viral factor — referral signups / all signups. props.source is set by
  -- complete-profile ('referral' | 'organic').
  select
    count(*),
    count(*) filter (where e.props ->> 'source' = 'referral')
  into v_signups, v_referrals
  from events e
  where e.name = 'signup'
    and e.created_at >= now() - v_window;

  -- 3. Vouch conversion — vouch-request links opened -> vouches published
  -- through one. Numerator and denominator are different event names, so
  -- they are counted in one pass over the same window.
  select
    count(*) filter (where e.name = 'invite_link_opened'),
    count(*) filter (where e.name = 'vouch_created'
                       and e.props ->> 'source' = 'weblink')
  into v_opened, v_weblink
  from events e
  where e.name in ('invite_link_opened', 'vouch_created')
    and e.created_at >= now() - v_window;

  -- 4. Trader activation — "traders with >= 3 vouches within 14 days of
  -- signup". Eligible = the trader has HAD 14 days; a profile created
  -- yesterday is not a failure to activate, it is not yet measurable. Only
  -- published vouches count, and only those inside the trader's own first 14
  -- days, so the number cannot drift upward as old traders keep collecting.
  select
    count(*),
    count(*) filter (where cohort.early_vouches >= 3)
  into v_eligible, v_activated
  from (
    select
      (
        select count(*)
        from vouches v
        where v.trader_id = tp.id
          and v.status = 'published'
          and v.created_at >= tp.created_at
          and v.created_at <= tp.created_at + v_activation
      ) as early_vouches
    from trader_profiles tp
    where tp.created_at <= now() - v_activation
  ) cohort;

  -- Every ratio divides by nullif(denominator, 0): a null reads as "no data
  -- yet" in the dashboard, and it keeps division-by-zero (an error in
  -- Postgres, NaN in JS) out of the payload entirely.
  return json_build_object(
    'friend_search_share', json_build_object(
      'searches',           v_searches::int,
      'with_friend_result', v_with_friend::int,
      'share',              v_with_friend::float8 / nullif(v_searches, 0)
    ),
    'viral_factor', json_build_object(
      'total_signups',    v_signups::int,
      'referral_signups', v_referrals::int,
      'factor',           v_referrals::float8 / nullif(v_signups, 0)
    ),
    'vouch_conversion', json_build_object(
      'links_opened',     v_opened::int,
      'weblink_vouches',  v_weblink::int,
      'rate',             v_weblink::float8 / nullif(v_opened, 0)
    ),
    'trader_activation', json_build_object(
      'eligible_traders', v_eligible::int,
      'activated',        v_activated::int,
      'rate',             v_activated::float8 / nullif(v_eligible, 0)
    )
  );
end;
$$;

-- Rule 5: nothing is exposed without an explicit grant. anon and
-- authenticated both get execute so both get the same explicit
-- admin_required error rather than a 404 that looks like a deploy problem;
-- the raise above, not the grant, is the gate.
revoke all on function public.admin_metrics() from public;
grant execute on function public.admin_metrics() to anon, authenticated, service_role;
