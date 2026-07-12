-- Seeds 10k synthetic traders for the M3 search perf proof.
-- Clean up with perf-cleanup.sql. Synthetic rows are identifiable by
-- phone_e164 like '+18683%' and display_name prefix 'ZPerf'.
begin;
with new_users as (
  insert into users (id, phone_e164, phone_hash, display_name, home_region_id, referral_code)
  select gen_random_uuid(),
         '+18683' || lpad(i::text, 6, '0'),
         'perfhash-' || i,
         'ZPerf Trader ' || i,
         10 + (i % 14),
         'Z' || lpad(i::text, 5, '0')
  from generate_series(1, 10000) i
  returning id
),
new_traders as (
  insert into trader_profiles (user_id, free_until, onboarding_complete, status, business_name)
  select id, current_date + 180, true,
         case when random() < 0.05 then 'lapsed' else 'active' end,
         'Perf Biz'
  from new_users
  returning id
),
tt as (
  insert into trader_trades (trader_id, trade_id)
  select nt.id, t.trade_id
  from new_traders nt
  cross join lateral (
    select id as trade_id from trades where status = 'active'
    order by md5(nt.id::text || id::text) limit 1 + (abs(hashtext(nt.id::text)) % 3)
  ) t
)
insert into trader_regions (trader_id, region_id)
select nt.id, r.region_id
from new_traders nt
cross join lateral (
  select case when abs(hashtext(nt.id::text || 'r')) % 10 = 0 then 1
              else 10 + (abs(hashtext(nt.id::text || r_i::text)) % 14) end as region_id
  from generate_series(0, 1) r_i
) r
on conflict do nothing;
commit;
analyze trader_profiles; analyze trader_trades; analyze trader_regions; analyze users;
