#!/usr/bin/env bash
# Full acceptance run against the local stack, from a clean database.
# Prereqs: `pnpm db:start` and `pnpm functions:serve` running.
# Order matters: each suite leaves the DB in the state the next expects.
set -euo pipefail
cd "$(dirname "$0")/../.."

# Date math must agree with the UTC edge runtime regardless of the host's
# timezone (a London host once shifted month arithmetic across a DST
# boundary — found by the M9 executor).
export TZ=UTC

echo "— resetting local database (migrations + seeds reapply)"
supabase db reset

node scripts/acceptance/test-m1.mjs
node scripts/acceptance/fixtures-post-m1.mjs
node scripts/acceptance/test-m2.mjs
node scripts/acceptance/fixtures-post-m2.mjs
node scripts/acceptance/test-m3.mjs
node scripts/acceptance/test-m5.mjs
node scripts/acceptance/test-m4.mjs
node scripts/acceptance/test-m6.mjs
node scripts/acceptance/test-m7.mjs
node scripts/acceptance/test-m8.mjs
node scripts/acceptance/test-m9.mjs
node scripts/acceptance/test-m11.mjs

echo
echo "All acceptance suites passed."
echo "Optional: perf proof — see scripts/acceptance/README.md (seeds 10k traders)."
