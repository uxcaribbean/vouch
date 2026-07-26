-- M4 perf layer — run AFTER perf-seed.sql (needs its 10k ZPerf traders).
-- Adds: ~1M contact_hashes spread over the synthetic users, 20k published
-- vouches between them, and a 5k-contact book for the measured viewer
-- (+18685550005, "Nikki") with ~200 rows matching real voucher hashes.
-- Cleanup: perf-cleanup-m4.sql then perf-cleanup.sql.
begin;

-- 100 fingerprint rows per synthetic user ≈ 1M rows
insert into contact_hashes (owner_user_id, phone_hash)
select u.id, md5(u.id::text || g) || md5(g::text || u.id::text)
from users u
cross join generate_series(1, 100) g
where u.phone_e164 like '+18683%'
on conflict do nothing;

-- 20k published vouches between synthetic members and traders
insert into vouches (voucher_user_id, trader_id, trade_id, source, status)
select
  vu.id,
  tp.id,
  100,
  'app',
  'published'
from generate_series(1, 20000) i
join lateral (
  select id from users where phone_e164 = '+18683' || lpad(((i * 13) % 10000 + 1)::text, 6, '0')
) vu on true
join lateral (
  select tp.id from trader_profiles tp
  join users tu on tu.id = tp.user_id
  where tu.phone_e164 = '+18683' || lpad(((i * 31) % 10000 + 1)::text, 6, '0')
) tp on true
on conflict do nothing;

-- the measured viewer: 5k contacts, every 25th one a real synthetic member
insert into contact_hashes (owner_user_id, phone_hash)
select
  (select id from users where phone_e164 = '+18685550005'),
  case when g % 25 = 0
       then 'perfhash-' || (g * 3 % 10000 + 1)   -- matches users.phone_hash of ZPerf members
       else md5('viewer' || g) || md5(g::text || 'viewer') end
from generate_series(1, 5000) g
on conflict do nothing;

commit;
analyze contact_hashes; analyze vouches;
select (select count(*) from contact_hashes), (select count(*) from vouches);
