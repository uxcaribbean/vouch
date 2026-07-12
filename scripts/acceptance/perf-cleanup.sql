-- Removes the synthetic traders created by perf-seed.sql.
delete from trader_profiles where user_id in
  (select id from users where phone_e164 like '+18683%');
delete from users where phone_e164 like '+18683%';
