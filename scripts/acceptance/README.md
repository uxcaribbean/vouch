# Acceptance suites

Server-side acceptance tests for each shipped module, runnable by anyone
with the local stack up. These encode the spec's acceptance criteria —
run them after touching migrations, edge functions, or RLS.

```sh
pnpm db:start            # terminal 1 (once)
pnpm functions:serve     # terminal 2 (keep running)
pnpm verify:acceptance   # terminal 3 — resets the DB, runs every suite in order
```

`run-all.sh` wipes the local database (`supabase db reset`) — local data is
disposable by design. The suites are stateful and ordered; the small
`fixtures-post-*.mjs` steps recreate the demo members between suites
(Keisha Mohammed: island-wide plumber; James Testman: plumber in Arima).

All keys inside are the standard local-dev demo keys, identical on every
machine — nothing secret.

## Perf proof (optional, M3)

`perf-m3.mjs` measures `search_traders` P95 through PostgREST. It is only
meaningful at volume: seed ~10k synthetic traders first with
[perf-seed.sql](perf-seed.sql), then clean up:

```sh
docker exec -i supabase_db_vouch psql -U postgres -v ON_ERROR_STOP=1 < scripts/acceptance/perf-seed.sql
node scripts/acceptance/perf-m3.mjs        # anon search; expect P95 well under 500ms
docker exec -i supabase_db_vouch psql -U postgres < scripts/acceptance/perf-cleanup.sql
```

## Perf proof at spec scale (M4): 1M contact hashes

The spec's hard budget (§6): search P95 < 500ms at 10k traders / 1M contact
hashes with friend-matching active. Layer the M4 seed on top of the M3 one:

```sh
docker exec -i supabase_db_vouch psql -U postgres -v ON_ERROR_STOP=1 < scripts/acceptance/perf-seed.sql
docker exec -i supabase_db_vouch psql -U postgres -v ON_ERROR_STOP=1 < scripts/acceptance/perf-seed-m4.sql
node scripts/acceptance/perf-m4.mjs        # authed viewer with a 5k-contact book
docker exec -i supabase_db_vouch psql -U postgres < scripts/acceptance/perf-cleanup-m4.sql
docker exec -i supabase_db_vouch psql -U postgres < scripts/acceptance/perf-cleanup.sql
```
