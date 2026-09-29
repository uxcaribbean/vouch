-- M12: plain-language understanding (TypeSafe / Jev). Contract under test:
-- scripts/acceptance/test-m12.mjs.
--
-- Two schema changes:
--   vouch_checks — the automatic comment check's moderation record. Kept OFF
--                  the public vouches table on purpose: vouches is world-
--                  readable, and a raw "complaint 0.62" score has no business
--                  next to a trader's public reputation. Admins-only on read;
--                  upsert-vouch (service role) is the only writer.
--   flags        — automatic checks queue flags with no human reporter, so
--                  reporter_user_id becomes nullable, guarded by a source
--                  column: a 'user' flag must still name its reporter.

-- ---------------------------------------------------------------------------
-- vouch_checks — one row per commented vouch (removed when the comment is
-- cleared). `unchecked` = the model was unavailable and the vouch published
-- fail-open. scores/model are null for unchecked rows.
-- ---------------------------------------------------------------------------
create table public.vouch_checks (
  vouch_id uuid primary key references public.vouches (id) on delete cascade,
  -- "check" is a reserved word: always quoted in SQL (PostgREST handles it).
  "check" text not null check ("check" in ('passed', 'flagged', 'unchecked')),
  scores jsonb,
  model text,
  checked_at timestamptz not null default now()
);

alter table public.vouch_checks enable row level security;

-- No client write policy: upsert-vouch (service role) is the only writer.
create policy "admin reads vouch checks" on public.vouch_checks
  for select to authenticated
  using (public.is_admin());

-- The grant is table-wide but RLS above is the real gate: a non-admin
-- authenticated caller gets zero rows, not an error. anon gets nothing.
grant select on public.vouch_checks to authenticated;
grant all on public.vouch_checks to service_role;

-- ---------------------------------------------------------------------------
-- flags — system-raised flags. Existing rows and policies are unchanged;
-- every pre-M12 row is a user report, which the default records.
-- ---------------------------------------------------------------------------
alter table public.flags
  add column source text not null default 'user'
    check (source in ('user', 'system'));

alter table public.flags alter column reporter_user_id drop not null;

alter table public.flags
  add constraint flags_reporter_required
  check (source = 'system' or reporter_user_id is not null);
