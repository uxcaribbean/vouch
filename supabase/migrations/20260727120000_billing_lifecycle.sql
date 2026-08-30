-- M10: subscriptions & billing lifecycle (spec §M10). Provider-independent
-- core only — no WiPay/PowerTranz/Stripe integration yet (blocked on founder
-- decisions, spec §7). Contract under test: scripts/acceptance/test-m10.mjs.
--
-- subscriptions is the provider-agnostic record a future webhook will drive
-- (trial -> paid -> cancelled -> lapsed). run-billing-lifecycle (the cron
-- job) is the only writer of trader_profiles.status transitions caused by
-- billing state; clients never touch this table at all.

-- ---------------------------------------------------------------------------
-- subscriptions — one row per (provider, provider_ref), i.e. one row per
-- provider-side subscription object. `status in ('active','cancelled')` with
-- a future current_period_end both grant access: cancelling stops renewal
-- but honors the period already paid for (spec M10 acceptance: "trial→paid→
-- cancelled→lapsed lifecycle correct").
-- ---------------------------------------------------------------------------
create table public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id),
  provider text not null check (provider in ('wipay', 'powertranz', 'stripe', 'manual')),
  provider_ref text not null,
  status text not null check (status in ('active', 'cancelled', 'past_due', 'expired')),
  current_period_end timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, provider_ref)
);

create index subscriptions_user_period_idx
  on public.subscriptions (user_id, current_period_end);

create trigger subscriptions_updated_at
  before update on public.subscriptions
  for each row execute function public.set_updated_at();

-- RLS: owners may read their own billing state. No insert/update/delete
-- policy for any client role — the webhook (future) and this module's cron
-- job both write as service_role only (iron rule 4/5).
alter table public.subscriptions enable row level security;

create policy "owner reads own subscriptions" on public.subscriptions
  for select to authenticated
  using (user_id = auth.uid());

grant select on public.subscriptions to authenticated;
grant all on public.subscriptions to service_role;

-- ---------------------------------------------------------------------------
-- notification_prefs.type gains 'billing' — lapse/warning pushes from the
-- lifecycle job (run-billing-lifecycle) are individually toggleable like
-- every other type (spec M8 rule).
-- ---------------------------------------------------------------------------
alter table public.notification_prefs drop constraint notification_prefs_type_check;

alter table public.notification_prefs add constraint notification_prefs_type_check
  check (type in (
    'vouch_received',
    'referral_credited',
    'contacts_joined_traders',
    'sync_nudge',
    'billing'
  ));
