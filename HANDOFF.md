# VOUCH — handoff (current state)

_Updated 2026-10-30. Last code commit: `7d47f6c` (M12, 2026-09-29);
everything since is documentation. Branch `main`, pushed to
https://github.com/uxcaribbean/vouch, CI green. Durable conventions are in
[AGENTS.md](AGENTS.md); the decisions log and per-module notes in
[docs/HANDOVER.md](docs/HANDOVER.md)._

## Where the build stands

Everything that can be built and proven on a laptop is built. Twelve
modules are shipped (M0–M9, M11, M12) plus the provider-independent half of
M10. Nothing is hosted, nothing has run on a physical phone, and no money
can move yet. All of that is waiting on James (decisions and accounts), not
on code.

| Module | State | Proof (`scripts/acceptance/` unless noted) |
|---|---|---|
| M0 Foundations | ✅ | `pnpm test` — 60 unit tests (phone contract 31, M12 policy 29) |
| M1 Auth & identity | ✅ | `test-m1.mjs` (21 checks) |
| M2 Trader profiles | ✅ | `test-m2.mjs` (24) |
| M3 Directory search | ✅ | `test-m3.mjs` (11) + perf P95 18.6ms @ 10k traders |
| M5 Vouches | ✅ | `test-m5.mjs` (24) + perf P95 25.8ms with live counts |
| M4 Contact sync | ✅ | `test-m4.mjs` (26) + perf P95 238.5ms @ 1M hashes (tightest margin; budget 500ms) |
| M6 Invites & referrals | ✅ | `test-m6.mjs` (24) |
| M7 Web vouch flow | ✅ | `test-m7.mjs` (15) + reviewer browser run |
| M8 Notifications | ✅ | `test-m8.mjs` (18) |
| M9 Trust, safety, admin | ✅ | `test-m9.mjs` (30) + reviewer browser run |
| M11 Analytics | ✅ | `test-m11.mjs` (10) |
| M10 Billing | ◐ lifecycle only | `test-m10.mjs` (26); provider checkout + webhook not built |
| M12 Plain-language understanding | ✅ | `test-m12.mjs` (36; live tier needs a TypeSafe key, fallback tier needs none) |

Verified on 2026-10-30 at HEAD: `pnpm typecheck` and `pnpm test` pass. The
last full clean-database acceptance run was at the M12 commit: 269 checks
green with the TypeSafe key present, 255 green with it removed. If
`pnpm verify:acceptance` and `pnpm test && pnpm typecheck` pass, the world is
as this document describes.

## In progress

Nothing is mid-flight. There is no uncommitted code. The only untracked
files are `.claude/build-ledger.yaml` and `.claude/project-brief.yaml`
(local by James's decision).

## What's left, and what it's waiting on

James's own view of this list is the plain-language worksheet
https://claude.ai/artifact/V4TwbnMyvMqdUdz7ipUVvf ("The finish line", 35
steps, in order). **Nothing is ticked as of 2026-10-30.** The worksheet is
private to James's Claude account; a session on another account cannot
read it and should ask him.

1. **Founder decisions (James; worksheet 1–4).** Final name, web address,
   monthly trader price in TT$ (spec placeholder TT$60), payment company
   (WiPay recommended; PowerTranz; Stripe only via a foreign entity). None
   decided.
2. **Accounts (James; worksheet 5–12).** Apple Developer (organization),
   Google Play (organization), merchant application, hosted Supabase
   project (East US), Twilio Verify, Expo, Vercel Pro or xCloud, his own
   TypeSafe key. Apple, Google and the merchant application are slow —
   start first.
3. **Go hosted (Claude, once 2 exists; worksheet 13–17).** Create/apply:
   migrations, 16 edge functions, Phone auth with Twilio Verify (James
   pastes the three Twilio values himself), `TYPESAFE_API_KEY` edge secret
   (James pastes), real `CRON_SECRET` plus a daily scheduler for
   `run-nudges` and `run-billing-lifecycle`, `EXPO_PUBLIC_WEB_BASE_URL` on
   the real domain, web app deployed with the domain attached. Hosted edge
   regions must be UTC or the date math reviewed.
4. **Device pass (worksheet 18–25).** `extra.eas.projectId` is absent from
   `apps/mobile/app.json` (`eas.json` profiles exist). Then: test builds,
   first real SMS code, native contacts read, WhatsApp vouch-request loop,
   "1 person you know", push notification, admin promotion
   (`update users set role='admin' where id=…` via service role), account
   deletion.
5. **Launch prep (worksheet 26–31).** Real design applied; privacy page
   (must disclose TypeSafe sees search wording and vouch comments, never
   phone numbers or contacts); local lawyer sign-off; paid Supabase (and
   Vercel) plans before real users; store submissions; first ~50 traders in
   person.
6. **Remaining code — M10 provider integration (worksheet 32–35).** Web
   checkout page on the trader's account (web, never iOS in-app purchase)
   and the provider webhook edge function. Contract is fixed in HANDOVER
   §5 "Remaining CODE": verify signature → upsert `subscriptions` on
   `(provider, provider_ref)` → run reactivation inline; idempotent under
   retries. The lifecycle suite already drives the state machine the
   webhook feeds.

## Key decisions (short form; full log in HANDOVER §4)

- Phone contract: sha256 of the full E.164 string incl. `+`, lowercase hex; validation is `isPossible()` (Google's `isValid()` rejects real exchanges). Changing either orphans every stored hash.
- Trader phone is public only while `status='active'` (`trader_directory` view). Lapsing revokes it.
- Deletion anonymizes the profile ("A former member"), purges hashes and avatars, hard-deletes the auth record; vouch counts survive.
- "N people you know" counts distinct people, not vouch rows.
- Every admin mutation goes through one audited edge function (`admin-action`); `admin_metrics()` raises for non-admins rather than returning zeros.
- `notification_log` is the enforcement record; 2 non-transactional pushes per week, server-enforced.
- Billing access = `free_until ≥ today` OR a subscription in (active, cancelled) with a future period end; cancelled honours the paid period.
- M12 scope boundary: TypeSafe handles only search-by-need, the vouch-comment guard and new-service matching — never the vouch gate, contact matching, counts/sort, billing or ring detection. Every call fails open.
- Process: the strongest model designs, writes the suite and reviews; a lower model (latest Sonnet, `claude-sonnet-5-5` for M12) executes. One commit per module, pushed.

## Known issues and debts

- Comment guard is stricter on mild wording than on praise: "Vouched from the web link — took a minute." scored complaint 0.30 (review line 0.5, refuse line 0.85). If real users get false refusals, adjust `COMMENT_BLOCK`/`COMMENT_REVIEW` in `understanding.ts` and re-run the live tier.
- `expo lint`: 5 errors + 1 warning (CI doesn't run lint). Details in HANDOVER §5 "Small known debts".
- Web root `/` still says the vouch flow is coming "soon" — stale copy, no logic.
- Avatar upload UI deferred (bucket + policies ready; reuse the trader-wizard photo pattern).
- M5: a concurrent create race returns 500 instead of folding into the edit path (composer disables submit while busy).
- `test-m11` is window-free and only agrees with the SQL's 30-day windows while fixtures are fresh.
- Local ops: Kong 502 after `db reset` → `docker restart supabase_kong_vouch`; port 3000 often taken → `web-3100` launch entry; a functions server started inside a Claude turn dies when the turn ends.
- Privacy: TypeSafe (US) keeps request data unless on their enterprise zero-retention plan; the privacy page and the lawyer step must cover it.

## Recent changes

- `0092c00` 2026-10-28 — docs: handover inventory refresh, reviewer's starting point (README, docs/HANDOVER.md).
- `7d47f6c` 2026-09-29 — **M12**: `supabase/migrations/20260929120000_plain_language.sql` (`vouch_checks`, `flags.source`), `supabase/functions/{interpret-need,suggest-trade}`, `_shared/typesafe.ts`, comment guard in `upsert-vouch`, `packages/shared/src/understanding.ts` + tests, `scripts/acceptance/test-m12.mjs`, search/become-a-trader/vouch screens (mobile), admin flags/taxonomy + `/v/[token]` copy (web).
- `a720169` 2026-08-30 — M10 lifecycle: `run-billing-lifecycle`, `subscriptions` table, `test-m10.mjs`.
- 2026-10-30 — context files reorganised: `AGENTS.md` (durable, imported by `CLAUDE.md`), this file (state), `docs/HANDOVER.md` (decisions + module notes only).

## Exact next steps for a fresh session

1. If `.claude/answers.md` exists with unticked entries, read them first (James's relayed answers and notes).
2. Read the worksheet's `steps` collection (ArtifactData on the URL above). Mirror any `done`/`done_on` into `.claude/build-ledger.yaml` steps `w-<id>`; read `note` fields for the name, domain, price, payment company and Expo username.
3. If the payment company and price are decided → build M10 provider integration: reviewer writes the design and `test-m13.mjs` (or extends `test-m10`), Sonnet executes, reviewer verifies, one commit.
4. If the hosted Supabase project and Twilio Verify exist → go hosted (step 3 above), then move `EXPO_PUBLIC_WEB_BASE_URL` and the invite templates off localhost.
5. If neither has moved: there is nothing to build. Don't invent scope; the optional debts above are the only code work available.
6. To work locally: start Docker Desktop, `pnpm db:start`, `pnpm functions:serve` in your own terminal, `pnpm verify:acceptance` (expect "All acceptance suites passed."), `pnpm --filter @vouch/mobile start`.
7. Before ending any session that changed the project: update this file, HANDOVER §5 if a module's landmines changed, the ledger's `next:` line, and commit + push.
