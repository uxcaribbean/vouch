# VOUCH — agent context

Trades directory for Trinidad & Tobago; trust = "vouched by someone you
know" via hashed phone-contact matching. **`VOUCH` is a codename — never
hardcode the brand in logic.**

- Authoritative spec: [docs/VOUCH-BUILD-SPEC.md](docs/VOUCH-BUILD-SPEC.md). Build modules in its stated order; don't build V2 items.
- Full project state, decisions log, and per-module handover notes: [docs/HANDOVER.md](docs/HANDOVER.md) — **read this first when picking up work.**
- Status: M0–M5 shipped (one commit per module, pushed to GitHub). **Next: M6 (invites, referrals & credits), then M7.**

## Iron rules

1. **One phone implementation.** Everything imports `packages/shared/src/phone.ts`. `hashPhone` = sha256 of the full E.164 string including `+`, lowercase hex. Never fork or reimplement, never change the hash contract.
2. Raw contact data never reaches the server — client-side hashes only.
3. Positive-only reviews. No negative paths in schema or UI.
4. Anything touching another user's data = Edge Function (service role). Clients get RLS + column-scoped grants only.
5. **Every migration must GRANT explicitly** — this Supabase version does not auto-expose new tables/functions to `anon`/`authenticated`/`service_role`.
6. Shared zod schemas in `packages/shared` are the API contract for mobile, web, and edge functions.
7. Each module ships with a server-side acceptance suite in `scripts/acceptance/` and one git commit.

## Commands

```sh
# Any running Docker daemon works (Docker Desktop is active on this Mac);
# use colima only if none is installed:
colima start --cpu 4 --memory 8
pnpm db:start / db:stop / db:reset
pnpm functions:serve              # wraps the required TMPDIR workaround
pnpm test && pnpm typecheck       # same as CI
pnpm verify:acceptance            # clean-DB run of every module's suite
pnpm db:types                     # regen types after ANY migration
pnpm --filter @vouch/mobile start # Expo dev server
```

Local sign-in: test numbers `+1868555000{1..5}`, OTP always `123456`. Real
SMS is impossible locally (dummy Twilio creds — deliberate, see HANDOVER).

## Gotchas that already bit us

- Expo SDK 57 / Next 16 are newer than model training data — check
  `node_modules/next/dist/docs/` and docs.expo.dev/versions/v57.0.0 before
  writing app code; the templates' AGENTS.md files say the same.
- `supabase functions serve` needs `TMPDIR` inside `$HOME` under Colima
  (use `pnpm functions:serve`, never the raw command).
- Edge functions: per-function `deno.json` for npm imports (the config.toml
  `import_map` path is NOT honored); explicit `entrypoint` required in
  config.toml; shared code imports need explicit `.ts` extensions.
- Phone validation uses `isPossible()` not `isValid()` — Google's pattern
  metadata rejects real exchanges (e.g. NANP 555). Don't "fix" this.
- `docker exec` needs `-i` for stdin/heredocs.
- SDK 57's `expo-contacts` main entry ships THROWING STUBS (new class API);
  the working functional API is at `expo-contacts/legacy` — import that.
- In-app-browser automation: synthetic clicks on RN-web Pressables can
  silently no-op. Verify with a DOM `element.click()` via javascript_exec
  before suspecting the app.
