# VOUCH — agent context

Trades and services directory for Trinidad & Tobago. Trust comes from the
customer's own phone contacts ("recommended by someone you know"), matched
by hashed phone numbers. **`VOUCH` is a codename — never hardcode the brand
in logic.**

Where things are written down:

- Requirements: [docs/VOUCH-BUILD-SPEC.md](docs/VOUCH-BUILD-SPEC.md). Build in its module order; don't build V2 items.
- Current state, blockers, next steps: [HANDOFF.md](HANDOFF.md) — **read first when picking up work.**
- Decisions log and per-module notes (the "why" and the landmines): [docs/HANDOVER.md](docs/HANDOVER.md).
- Fresh-clone setup and local sign-in: [README.md](README.md).

## Stack and layout

pnpm monorepo, Node 22+. TypeScript throughout.

| Path | What |
|---|---|
| `apps/mobile` | Expo SDK 57 (React Native 0.86, expo-router). The product. Monochrome placeholder design system in `src/components/ui/*`, 56px touch targets. |
| `apps/web` | Next.js 16 (App Router, Tailwind v4): `/v/[token]` no-install vouch flow, `/join` referral landing, `/admin` (flags, lookup, taxonomy, rings, metrics). Root `/` is a placeholder splash. |
| `packages/shared` | The spine: `phone.ts` (normalize + hash contract), `referral.ts`, `invites.ts` (every outbound message template), `schemas.ts`/`taxonomy.ts` (zod — the API contract), `understanding.ts` (M12 questions, thresholds, fail-open policy), generated `database.types.ts`. |
| `supabase/` | 12 migrations, 16 Deno edge functions (`_shared/notify.ts` is the only push path, `_shared/typesafe.ts` the only model call), `config.toml`. Local stack = Supabase CLI on Docker. |
| `scripts/acceptance/` | One server-side suite per module (`test-m1` … `test-m12`), fixtures, perf seeds, `run-all.sh`. |
| `.github/workflows/ci.yml` | Typecheck + unit tests on every push. CI runs neither lint nor the acceptance suites. |

Outside services: Supabase (hosted project planned, East US), Twilio Verify
(planned, real sign-in codes), Expo push, WhatsApp share links, TypeSafe's
Jev model (M12; pinned `jev-1.13.0`), a payment provider (undecided).

## Iron rules

1. **One phone implementation.** Everything imports `packages/shared/src/phone.ts`. `hashPhone` = sha256 of the full E.164 string including `+`, lowercase hex. Never fork, reimplement, or change the hash contract.
2. Raw contact data never reaches the server — client-side hashes only. Nothing about phones or contacts ever goes to TypeSafe either.
3. Positive-only reviews. No negative paths in schema or UI (the M12 comment guard enforces this for free text).
4. Anything touching another user's data = edge function (service role). Clients get RLS + column-scoped grants only.
5. **Every migration must GRANT explicitly** — this Supabase version does not auto-expose new tables/functions to `anon`/`authenticated`/`service_role`.
6. Shared zod schemas in `packages/shared` are the API contract for mobile, web, and edge functions.
7. Each module ships with a server-side acceptance suite in `scripts/acceptance/` and one git commit, pushed to GitHub.

## Commands

```sh
# Docker Desktop is the daemon on this Mac; `colima start --cpu 4 --memory 8` only if none is installed
pnpm db:start / db:stop / db:reset
pnpm functions:serve              # edge functions; wraps the TMPDIR workaround; run in YOUR OWN terminal
pnpm test && pnpm typecheck       # same as CI
pnpm verify:acceptance            # clean-DB run of every module's suite (RESETS the local DB)
pnpm db:types                     # regen types after ANY migration — commit the result
pnpm --filter @vouch/mobile start # Expo dev server
```

Local sign-in: test numbers `+1868555000{1..5}`, OTP always `123456`. Real
SMS is impossible locally (dummy Twilio creds — deliberate). Browser
verification: `.claude/launch.json` entries `mobile-web` (8081), `web`
(3000) and `web-3100` (port 3000 is often held by another project).

## Conventions

- **Model routing (James's standing rule):** the strongest model decides — it fixes the design, writes the brief AND the module's acceptance suite independently, reviews every diff and runs verification. A lower model (James's current pick: the latest Sonnet) executes from the briefs. Executors never edit `scripts/acceptance/`; when a check looks wrong they stop and argue with evidence. Nothing commits without reviewer-run verification.
- Module shape: migration (with GRANTs) → edge functions → shared schemas → screens → suite green from a clean DB → docs (HANDOFF + HANDOVER) → one commit → push.
- Edge functions: per-function `deno.json` for npm imports (the `config.toml` `import_map` is not honored); explicit `entrypoint` in `config.toml`; `.ts` extensions on shared imports; `verify_jwt = false` only for public or cron functions (`resolve-invite`; `run-nudges` and `run-billing-lifecycle` guarded by `x-cron-secret`).
- Secrets: `supabase/functions/.env` (gitignored; template `.env.example`). Never print, log, or commit a key. Hosted keys go in Supabase Edge Function secrets, never in the mobile bundle. Only the public local demo keys live in the repo.
- Date math uses UTC components (`setUTCMonth`, `Date.UTC`); `run-all.sh` pins `TZ=UTC`.
- Anything written for James (worksheet, ledger questions): plain language, no jargon or acronyms.
- `.claude/build-ledger.yaml` and `.claude/project-brief.yaml` are local and deliberately uncommitted (James decides per repo); `.claude/launch.json` is committed.
- Parallel executors share the one local database and acceptance runs reset it — serialize resets, and tell executors not to run `verify:acceptance` or `db reset`.

## Gotchas that already bit us

- Expo SDK 57 / Next 16 postdate model training — read `node_modules/next/dist/docs/` (repo root) and docs.expo.dev/versions/v57.0.0 before writing app code. Next 16: `params`/`searchParams` are async in server components; wrap per-request fetches shared with `generateMetadata` in React `cache()`; web tsconfig needs `allowImportingTsExtensions`.
- SDK 57's `expo-contacts` main entry ships throwing stubs — import `expo-contacts/legacy`. `expo-notifications` is lazy-imported so web never evaluates the push stack; push registration is inert until `extra.eas.projectId` exists. `Alert` is a no-op on web.
- Phone validation uses `isPossible()` not `isValid()` — Google's pattern metadata rejects real exchanges (e.g. NANP 555). Don't "fix" this.
- `supabase functions serve` needs `TMPDIR` inside `$HOME` (use `pnpm functions:serve`, never the raw command). A functions server started from inside a Claude session stops when the turn ends.
- After `supabase db reset`, Kong can keep a stale route to the restarted auth container (502 "invalid response from upstream" at the first login): `docker restart supabase_kong_vouch`.
- `docker exec` needs `-i` for stdin/heredocs.
- M12: questions and thresholds live ONLY in `packages/shared/src/understanding.ts`; edge functions call `_shared/typesafe.ts`, which never throws and never logs what it sent. No key or an outage = keyword search + unchecked vouches, by design.
- In-app-browser automation: synthetic clicks on RN-web Pressables can silently no-op. Verify with a DOM `element.click()` via `javascript_exec` before suspecting the app.
- Expo web export: `AsyncStorage` must not be touched during Node SSR (`storage: Platform.OS === 'web' ? undefined : AsyncStorage`).
