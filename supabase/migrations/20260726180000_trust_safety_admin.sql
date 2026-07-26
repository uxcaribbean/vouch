-- M9: trust, safety & admin (spec §3 flags block + §4/M9). Contract under
-- test: scripts/acceptance/test-m9.mjs.
--
-- Three moving parts:
--   flags       — user reports. Read by their reporter and by admins; never
--                 written by a client (submit-flag validates + inserts).
--   audit_log   — the record that every admin action happened. Exactly one
--                 row per successful admin action, written by admin-action
--                 (service role); admins-only on read.
--   users.suspended_at — the suspension switch. Deliberately outside the
--                 client's column-scoped UPDATE grant, so only an admin
--                 (via admin-action) can set or clear it.
--
-- Plus two SECURITY DEFINER functions: admin_ring_report() (manual-review
-- view, spec M9 "Basic ring detection") and admin_merge_trade() (the
-- taxonomy re-pointing migration from M2, run atomically).

-- ---------------------------------------------------------------------------
-- flags — factual problem reports only (spec M9.1: this is a positive-only
-- system, there is nothing negative to dispute). subject_id points into
-- trader_profiles / vouches / users depending on subject_type; all three are
-- uuid keys, so one column covers them.
-- ---------------------------------------------------------------------------
create table public.flags (
  id uuid primary key default gen_random_uuid(),
  reporter_user_id uuid not null references public.users (id),
  subject_type text not null check (subject_type in ('trader', 'vouch', 'user')),
  subject_id uuid not null,
  reason text not null check (reason in (
    'fake_profile',
    'impersonation',
    'wrong_number',
    'spam',
    'other'
  )),
  detail text,
  status text not null default 'open'
    check (status in ('open', 'resolved', 'dismissed')),
  resolved_by uuid references public.users (id),
  resolution_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger flags_updated_at
  before update on public.flags
  for each row execute function public.set_updated_at();

-- the admin queue is "open flags, oldest first"
create index flags_status_created_idx on public.flags (status, created_at);

alter table public.flags enable row level security;

-- The reporter can follow up on what they reported; admins see the queue.
-- No insert/update/delete policy for any client role: submit-flag and
-- admin-action (service role) are the only writers.
create policy "reporter reads own flags" on public.flags
  for select to authenticated
  using (reporter_user_id = auth.uid());

create policy "admin reads all flags" on public.flags
  for select to authenticated
  using (public.is_admin());

grant select on public.flags to authenticated;
grant all on public.flags to service_role;

-- ---------------------------------------------------------------------------
-- audit_log — spec M9 acceptance: "every admin action writes an audit row".
-- subject_id is uuid, so int-keyed subjects (trades) carry their id in meta
-- instead. Client writes are impossible by design; only admins can read.
-- ---------------------------------------------------------------------------
create table public.audit_log (
  id uuid primary key default gen_random_uuid(),
  admin_user_id uuid not null references public.users (id),
  action text not null,
  subject_type text,
  subject_id uuid,
  note text,
  meta jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index audit_log_created_idx on public.audit_log (created_at desc);

alter table public.audit_log enable row level security;

create policy "admin reads audit log" on public.audit_log
  for select to authenticated
  using (public.is_admin());

-- The grant is table-wide but RLS above is the real gate: a non-admin
-- authenticated caller gets zero rows, not an error.
grant select on public.audit_log to authenticated;
grant all on public.audit_log to service_role;

-- ---------------------------------------------------------------------------
-- users.suspended_at — set by admin-action's suspend_user, cleared by
-- unsuspend_user. Write paths (upsert-vouch, create-invite, sync-contacts)
-- refuse a suspended caller with 403 account_suspended. NOT added to the
-- authenticated column-scoped UPDATE grant from M1 — self-unsuspension is
-- not a feature.
-- ---------------------------------------------------------------------------
alter table public.users add column suspended_at timestamptz;

-- ---------------------------------------------------------------------------
-- admin_ring_report — spec M9: "clusters of accounts created within 48h
-- that only vouch for one trader". Read-only, reviewed by a human, no auto
-- punishment in MVP.
--
-- A trader is reported when >= 3 DISTINCT vouchers all satisfy:
--   * the voucher's account is less than 48h old, and
--   * every published vouch that voucher has is on this one trader.
--
-- `where public.is_admin()` sits inside the definer body so a non-admin
-- caller gets an empty result set rather than an error or other people's
-- data — the function is execute-granted to authenticated for the admin
-- dashboard's convenience.
-- ---------------------------------------------------------------------------
create or replace function public.admin_ring_report()
returns table (
  trader_id uuid,
  trader_name text,
  new_voucher_count int
)
language sql
stable
security definer
set search_path = public
as $$
  select
    tp.id as trader_id,
    u.display_name as trader_name,
    count(distinct v.voucher_user_id)::int as new_voucher_count
  from trader_profiles tp
  join users u on u.id = tp.user_id
  join vouches v on v.trader_id = tp.id and v.status = 'published'
  join users vu on vu.id = v.voucher_user_id
  where public.is_admin()
    and vu.created_at >= now() - interval '48 hours'
    and not exists (
      select 1
      from vouches other
      where other.voucher_user_id = v.voucher_user_id
        and other.status = 'published'
        and other.trader_id <> tp.id
    )
  group by tp.id, u.display_name
  having count(distinct v.voucher_user_id) >= 3
  order by count(distinct v.voucher_user_id) desc
$$;

grant execute on function public.admin_ring_report() to authenticated;

-- ---------------------------------------------------------------------------
-- admin_merge_trade — spec M2.2/M9: merging trade B into A re-points every
-- trader_trades and vouches row. Both tables carry uniqueness constraints
-- that the re-point can violate (a trader offering BOTH trades, a voucher
-- holding a vouch on both), so conflicting rows are dropped before the
-- update. One statement-atomic function rather than a sequence of PostgREST
-- calls: a half-merged taxonomy is worse than a failed one.
--
-- Callable only by service_role (admin-action). Clients never touch it.
-- ---------------------------------------------------------------------------
create or replace function public.admin_merge_trade(p_from int, p_into int)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- trader_trades: unique (trader_id, trade_id)
  delete from trader_trades tt
   where tt.trade_id = p_from
     and exists (
       select 1 from trader_trades keep
       where keep.trader_id = tt.trader_id and keep.trade_id = p_into
     );
  update trader_trades set trade_id = p_into where trade_id = p_from;

  -- vouches: unique (voucher_user_id, trader_id, trade_id). Status is
  -- irrelevant here — an admin-removed or self-removed row still occupies
  -- the slot, so it still conflicts.
  delete from vouches v
   where v.trade_id = p_from
     and exists (
       select 1 from vouches keep
       where keep.voucher_user_id = v.voucher_user_id
         and keep.trader_id = v.trader_id
         and keep.trade_id = p_into
     );
  update vouches set trade_id = p_into where trade_id = p_from;

  -- the merged trade keeps its row so old slugs can 301 to the target.
  update trades
     set status = 'merged', merged_into_id = p_into
   where id = p_from;
end;
$$;

revoke all on function public.admin_merge_trade(int, int) from public;
revoke all on function public.admin_merge_trade(int, int) from anon, authenticated;
grant execute on function public.admin_merge_trade(int, int) to service_role;
