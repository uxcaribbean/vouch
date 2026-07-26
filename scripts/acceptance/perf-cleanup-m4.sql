-- Removes the M4 perf layer (run before perf-cleanup.sql).
delete from vouches where voucher_user_id in
  (select id from users where phone_e164 like '+18683%');
delete from contact_hashes where owner_user_id in
  (select id from users where phone_e164 like '+18683%');
delete from contact_hashes where owner_user_id =
  (select id from users where phone_e164 = '+18685550005');
update users set contact_sync_enabled = false
  where phone_e164 = '+18685550005';
