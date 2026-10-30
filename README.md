# VOUCH

Trades & services directory for Trinidad & Tobago where trust comes from your
own phone contacts: **"Recommended by someone you know."**

The authoritative build spec is [docs/VOUCH-BUILD-SPEC.md](docs/VOUCH-BUILD-SPEC.md).
`VOUCH` is a codename — never hardcode the brand name in logic.

## Where to start

- **The concept:** spec [§1](docs/VOUCH-BUILD-SPEC.md#1-product-overview)
  — the one-liner, the core mechanic, and the product decisions that are
  locked (positive-only vouches, contacts never leave the phone, invites
  are always a person pressing send). Then §5 (what's deliberately left
  for V2) and §7 (what the founders still have to decide). One addition
  since the spec: M12 uses a small AI model for search-by-need and for
  checking vouch comments — see [HANDOVER §5](docs/HANDOVER.md).
- **Where the build stands:** [HANDOFF.md](HANDOFF.md) — what's shipped,
  what's left, and what each remaining item is waiting on. The decisions
  log and per-module notes are in [docs/HANDOVER.md](docs/HANDOVER.md).
- **Changing code:** [AGENTS.md](AGENTS.md) (iron rules, commands,
  gotchas; `CLAUDE.md` imports it), then the fresh-clone setup below.
  HANDOVER §2 covers moving to a new machine account.

## Status

Feature-complete against everything that can be built and proven locally:
M0–M9, M11 and M12 are shipped, plus the provider-independent half of M10
(the billing lifecycle). Still to come: the payment provider's checkout and
webhook (waiting on founder decisions), hosting, and a pass on real phones.
Module-by-module proof and the remaining steps are in [HANDOFF.md](HANDOFF.md).

## Layout

```
apps/mobile         Expo SDK 57 (React Native, expo-router) — the product
apps/web            Next.js 16 — vouch links (/v/[token], M7) + admin (M9)
packages/shared     Phone normalize/hash contract, referral codes, zod schemas, M12 policy, DB types
supabase/           Migrations, edge functions, local config
scripts/acceptance  One server-side suite per module; `pnpm verify:acceptance` runs them all
```

Rule that everything hangs on: **one phone implementation.** Mobile, web and
edge functions all import `packages/shared/src/phone.ts`. `hashPhone` =
sha256 of the full E.164 string including `+`, lowercase hex. Never fork it.

## Fresh-clone setup (~15 min, mostly downloads)

Prereqs: Node 22+, pnpm 9+ (`corepack enable`), a running Docker daemon
(Docker Desktop on this Mac; `brew install colima docker && colima start
--cpu 4 --memory 8` is the fallback), and the Supabase CLI
(`brew install supabase/tap/supabase`).

```sh
pnpm install
pnpm db:start                 # first run downloads ~2GB of images
cp apps/mobile/.env.example apps/mobile/.env
cp supabase/functions/.env.example supabase/functions/.env   # add a TypeSafe key here to exercise M12's model features; optional
pnpm functions:serve          # keep running in its own terminal
pnpm --filter @vouch/mobile start   # Expo dev server → i for iOS sim, a for Android
```

Checks: `pnpm test && pnpm typecheck` (same as CI), then
`pnpm verify:acceptance` for the full clean-database proof.

### Signing in locally

No SMS is sent locally. Use a test number; the code is always `123456`:

| Phone | OTP |
|---|---|
| +1 868 555 0001 … 0005 | `123456` |

Real numbers won't work locally (the SMS provider is a dummy). On a physical
device, point `EXPO_PUBLIC_SUPABASE_URL` at your machine's LAN IP instead of
127.0.0.1.

### Local quirks (all deliberate)

- `pnpm functions:serve` wraps `supabase functions serve` with
  `TMPDIR=$HOME/.cache/supabase-tmp` — under Colima, macOS's default
  `/var/folders` temp dir can't be mounted into the VM. Harmless under
  Docker Desktop.
- `[analytics]` is disabled in `supabase/config.toml` for the same class of
  mount issue. Product analytics use the `events` table, so nothing is lost.
- `[auth.sms.twilio]` has dummy credentials: GoTrue refuses to issue OTPs
  with no provider enabled, even for test numbers. The hosted project will
  use Twilio Verify with real credentials set in the dashboard.
- After `supabase db reset`, if the first sign-in returns a 502, run
  `docker restart supabase_kong_vouch`.

## Scripts (root)

| Script | Does |
|---|---|
| `pnpm test` / `pnpm typecheck` | Whole workspace (same as CI) |
| `pnpm db:start` / `db:stop` / `db:reset` | Local Supabase lifecycle |
| `pnpm db:types` | Regenerate `packages/shared/src/database.types.ts` after migrations |
| `pnpm functions:serve` | Edge functions with the TMPDIR fix |
| `pnpm verify:acceptance` | Clean-DB run of every module's acceptance suite |
