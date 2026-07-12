# VOUCH — Handover / project state

_Last updated: 2026-07-12. Everything a new person (or a new AI session on a
different account) needs to continue this build with only this folder._

The authoritative requirements are [VOUCH-BUILD-SPEC.md](VOUCH-BUILD-SPEC.md).
This document records what's been built against it, the decisions taken along
the way, and where the landmines are. Repo conventions live in
[/CLAUDE.md](../CLAUDE.md); setup steps in [/README.md](../README.md).

## 1. Status at a glance

| Module | State | Commit | Proof |
|---|---|---|---|
| M0 Foundations | ✅ | `M0+M1` | 31 unit tests (`pnpm test`) |
| M1 Auth & identity | ✅ | `M0+M1` | `scripts/acceptance/test-m1.mjs` (21 checks) |
| M2 Trader profiles | ✅ | `M2` | `test-m2.mjs` (24 checks) |
| M3 Directory search | ✅ | `M3` | `test-m3.mjs` (11 checks) + perf P95 18.6ms @ 10k traders |
| M5 Vouches | **next** | — | — |
| M4 Contact sync | after M5 | — | — |
| M6→M10 | per spec order | — | — |

One git commit per module. `pnpm verify:acceptance` reruns every suite from a
clean DB — if that passes and `pnpm test && pnpm typecheck` pass, the world is
as this document describes.

## 2. First run for the new account (same computer)

Which scenario applies?

**A. Same macOS user, different AI/Claude account login** — the simple case:
nothing environmental changes. The Colima VM, local database, `.env` files,
and local AI-session state under `~/.claude` are all keyed to the macOS
user, not the AI account. Open this folder, start the stack if it isn't
running (`colima start`, `pnpm db:start`, `pnpm functions:serve`), continue
from §5. Skip the rest of this section.

**B. Different macOS account on this Mac** — two extra facts:

1. **Folder access:** this repo currently lives inside `/Users/james/`,
   which other macOS accounts cannot read by default. Either move the whole
   folder to `/Users/Shared/` (git history travels with it) or grant the
   new account read/write access. Update absolute paths in your head
   accordingly — nothing in the repo hardcodes the location.
2. Homebrew formulas (colima, docker, supabase) are machine-wide and already
   installed, **but the Colima VM and all Docker state are per-macOS-account**
   — the local database does not carry across and doesn't need to
   (migrations + seeds rebuild it; all data is disposable dev data).

```sh
colima start --cpu 4 --memory 8      # downloads a VM image on first run
cd "/Users/james/Local Code/vouch"
pnpm install
pnpm db:start                        # ~2GB image download on first run
cp apps/mobile/.env.example apps/mobile/.env
pnpm functions:serve                 # keep running in its own terminal
pnpm verify:acceptance               # should end with "All acceptance suites passed."
pnpm --filter @vouch/mobile start    # Expo; test numbers +18685550001..5, OTP 123456
```

Also note: any prior AI-session memory (task lists, `~/.claude` state) does
NOT transfer between accounts. This file + CLAUDE.md + the spec are the
complete transferable state, by design.

## 3. What exists, and where

- `packages/shared` — **the product's spine**: `phone.ts` (normalize +
  sha256 hash; the identity/matching contract), `referral.ts`,
  `schemas.ts`/`taxonomy.ts` (zod API contracts), generated
  `database.types.ts` (regen with `pnpm db:types` after any migration).
- `supabase/migrations/` — 4 migrations: taxonomy seeds (14 Trinidad regions,
  72 trades with search keywords), auth/users (+ `events` and
  `contact_hashes` pulled forward deliberately — see §4), trader profiles,
  directory search (`search_traders` RPC + `trader_directory` view).
- `supabase/functions/` — `complete-profile`, `delete-account`,
  `upsert-trader-profile`, `health`. Shared helpers in `_shared/`; each
  function has its own `deno.json` for npm imports and an explicit
  `entrypoint` in `config.toml`.
- `apps/mobile` — Expo SDK 57. Auth flow (sign-in → OTP → profile setup),
  settings (incl. account deletion), become-a-trader wizard, my/public
  trader profiles, directory home + search, Account tab. Design system is a
  deliberate monochrome placeholder (`components/ui/*`), 56px touch targets.
- `apps/web` — Next 16 placeholder only. Comes alive at M7 (`/v/[token]`)
  and M9 (`/admin`).
- `scripts/acceptance/` — the per-module server-side acceptance suites,
  fixtures, perf seed/cleanup SQL, and `run-all.sh`.
- `.github/workflows/ci.yml` — typecheck + tests; activates the moment this
  repo is pushed to GitHub (not yet created — deliberate, see §6).

Current demo data after `verify:acceptance`: Keisha Mohammed
(island-wide plumber, +18685550001) and James Testman (Arima plumber,
+18685550004).

## 4. Decisions taken during the build (and why)

**Product/architecture:**
- **Phone validation is possible-length (`isPossible`), not pattern-strict
  (`isValid`).** Google's metadata rejects entire real exchanges (it rejected
  the spec's own 555 test numbers). For a contact-matching product,
  over-strict validation silently breaks matching; OTP delivery is the real
  identity gate. Documented in `phone.ts` — do not "fix".
- **Hash contract:** sha256 over the full E.164 string *including* `+`,
  lowercase hex. Changing this orphans every stored `contact_hashes` row.
- **Trader phone exposure (approved by James):** `trader_directory` view
  exposes `phone_e164` only while `status='active'`. Listing yourself is
  consent to be contacted; lapsing revokes it. Suspended/hidden traders
  disappear from all public surfaces but stay visible to their owner.
- **Deletion model (M1.4):** no FK from `public.users` to `auth.users`; on
  delete we anonymize the profile row ("A former member", phone columns
  nulled — allowed via a deleted-only CHECK), purge `contact_hashes` and
  avatar files, then hard-delete the auth record (revokes sessions, frees
  the number for a fresh account). Vouch counts survive by design.
- **Schema pulled forward:** `events` (M11) and `contact_hashes` (M4) were
  created in the M1 migration — M5's anti-gaming gate needs prior-contact
  evidence and M1's deletion flow contractually purges contact hashes.
  M3's screens already record `contact_tapped` events, so gate condition
  (c) has real data from day one.
- **`search_traders` RPC column contract:** returns
  `vouch_count`/`friend_vouch_count`, currently hardcoded 0. M5 and M4 must
  `CREATE OR REPLACE` the function to fill them — clients already bind to
  these columns and light up without app changes. Same for the sort:
  friend desc → vouch desc → newest, lapsed last within band.
- **`upsert-trader-profile` uses full-replace semantics:** omitted cosmetic
  fields become NULL; trade/region sets are replaced wholesale. The wizard
  always submits complete state (prefilled in edit mode). Callers must never
  send partial payloads.
- **free_until** on trader creation = today + sum of `credit_ledger` months
  (signup bonus 6 + any referral months earned pre-trader). Updates never
  touch it; M6 referral crediting extends it directly.

**Environment (all local-only, all deliberate):**
- Supabase no longer auto-exposes new tables → **every migration carries
  explicit GRANTs** (also matches hosted default).
- Colima quirks: `functions serve` needs `TMPDIR` in `$HOME`
  (`pnpm functions:serve` wraps it); `[analytics]` disabled in config.toml
  (vector container needs an unsupported docker-socket mount).
- GoTrue refuses `/otp` with no SMS provider even for test numbers →
  `[auth.sms.twilio]` has dummy creds. Only the 5 test numbers work locally.
  The hosted project must use real Twilio Verify creds via env substitution.
- Edge functions: per-function `deno.json` (config.toml `import_map` is not
  honored), explicit `entrypoint`, `.ts` extensions on relative imports
  (shared package uses them everywhere for Deno compatibility).

**Process (James-approved):**
- Model routing: pattern-following mobile screens are delegated to Sonnet
  subagents with a detailed conventions brief (read the existing screens
  first; verify with typecheck + `expo export` + a browser walkthrough).
  Schema, RLS, edge functions, and verification stay on the strongest model.
- Each module: build → server acceptance suite → browser walkthrough →
  one commit. Local git only; GitHub later.

## 5. The next modules — what to know before starting

**M5 Vouches (next):** spec §M5. The gate (rule 3) is the tricky part — a
voucher must know the trader: (a) trader's phone_hash in voucher's
`contact_hashes` (test by seeding rows directly until M4), (b) invite token
(M6/M7 — can't be satisfied yet), or (c) `contact_tapped` event on that
trader ≥7 days old (events already flowing from M3; for tests, backdate
`events.created_at` directly). Enforce in an edge function, never
client-side. Also: unique (voucher, trader, trade); ≤400-char comment;
self-vouch blocked; new accounts (<24h) max 5 vouches; removal decrements
counts; `CREATE OR REPLACE search_traders` with real `vouch_count`; update
the trader profile screens' vouch placeholders; confetti moment on submit.

**M4 Contact sync:** batches of 500 hashes, full replace per sync, via edge
function only; `friend_vouches`/`trader_summary` derived queries (spec §3);
replace `friend_vouch_count` in the RPC; the reverse prompt ("N people you
know are traders — vouch for them"); `expo-contacts` permission copy per
spec M4.7; app must stay fully usable when permission is denied.

**Then:** M6 invites/referrals (never auto-send; `wa.me` share only), M7 web
vouch flow (first real `apps/web` work), M8 push, M9 admin, M11 analytics
dashboard, M10 billing last.

**Small known debts:** avatar upload UI deferred from M1 (bucket + policies
ready; photo upload exists in the trader wizard — reuse that pattern);
one pre-existing lint error in `apps/mobile/src/hooks/use-color-scheme.web.ts`
(Expo template file, `react-hooks/set-state-in-effect`).

## 6. Not set up yet (deliberately)

- **No hosted Supabase project** — local only. Going hosted needs: project
  creation, Twilio Verify credentials, applying migrations, deploying edge
  functions, real env files (never commit secrets; only the public local
  demo keys are in-repo).
- **No GitHub remote** — CI workflow is ready and fires on first push.
- **No EAS/Expo account wiring** — `eas.json` profiles exist.
- **Founder items open** (spec §7): final name + domain (blocks M6 links),
  TTD price + payment provider (M10), seed-trader strategy, legal review.
