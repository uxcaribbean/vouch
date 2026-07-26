# VOUCH

Trades & services directory for Trinidad & Tobago where trust comes from your
own phone contacts: **"Recommended by someone you know."**

The authoritative build spec is [docs/VOUCH-BUILD-SPEC.md](docs/VOUCH-BUILD-SPEC.md).
`VOUCH` is a codename — never hardcode the brand name in logic.

**Picking this project up fresh?** Read [docs/HANDOVER.md](docs/HANDOVER.md)
— full project state, decisions log, per-module notes, and first-run steps
for a new machine account. AI-session context lives in [CLAUDE.md](CLAUDE.md).

## Status

| Module | State |
|---|---|
| M0 Foundations | ✅ built |
| M1 Auth & identity | ✅ built (server flows verified end-to-end locally) |
| M2 Trader profiles | ✅ built (24 server-side acceptance checks) |
| M3 Directory search & browse | ✅ built (P95 18.6ms @ 10k traders; 11 search checks) |
| M5 Vouches | ✅ built (24-check suite; gate + rate limit server-enforced; P95 25.8ms with live counts) |
| M4 Contact sync & matching | ✅ built (26-check suite; P95 238.5ms @ 1M hashes — spec budget 500ms) |
| M6 Invites, referrals & credits | ✅ built (24-check suite; farming defense + 24/yr cap; gate (b) wired) |
| M7 Web vouch flow (no-install) | ✅ built (15-check suite; cold visitor → published vouch well under 60s) |
| M8 Notifications & nudges | next up |

## Layout

```
apps/mobile      Expo SDK 57 (React Native, expo-router) — the product
apps/web         Next.js 16 — vouch links (/v/[token], M7) + admin (M9)
packages/shared  Phone normalize/hash contract, referral codes, zod schemas, DB types
supabase/        Migrations, edge functions, local config
```

Rule that everything hangs on: **one phone implementation.** Mobile, web and
edge functions all import `packages/shared/src/phone.ts`. `hashPhone` =
sha256 of the full E.164 string including `+`, lowercase hex. Never fork it.

## Fresh-clone setup (~15 min, mostly downloads)

Prereqs: Node 22+, pnpm 9+ (`corepack enable`), Homebrew.

```sh
brew install colima docker supabase/tap/supabase
colima start --cpu 4 --memory 8

pnpm install
pnpm db:start                 # first run downloads ~2GB of images
cp apps/mobile/.env.example apps/mobile/.env
pnpm functions:serve          # keep running in its own terminal
pnpm --filter @vouch/mobile start   # Expo dev server → i for iOS sim, a for Android
```

Checks: `pnpm test` (phone-contract suite must pass) and `pnpm typecheck`.

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
  `TMPDIR=$HOME/.cache/supabase-tmp` — Colima can't mount macOS's default
  `/var/folders` temp dir into the VM.
- `[analytics]` is disabled in `supabase/config.toml` for the same class of
  Colima mount issue. Product analytics use the `events` table, so nothing
  is lost.
- `[auth.sms.twilio]` has dummy credentials: GoTrue refuses to issue OTPs
  with no provider enabled, even for test numbers. The hosted project will
  use Twilio Verify with real env-substituted credentials.

## Scripts (root)

| Script | Does |
|---|---|
| `pnpm test` / `pnpm typecheck` | Whole workspace (same as CI) |
| `pnpm db:start` / `db:stop` / `db:reset` | Local Supabase lifecycle |
| `pnpm db:types` | Regenerate `packages/shared/src/database.types.ts` after migrations |
| `pnpm functions:serve` | Edge functions with the Colima TMPDIR fix |
| `pnpm verify:acceptance` | Clean-DB run of every module's acceptance suite |
