# VOUCH — Build Specification v1.0

**Working title:** VOUCH (final name TBD — treat `VOUCH` as a codename/env variable, never hardcode the brand name in logic)
**Date:** 2026-07-11
**Audience:** This document is written for an AI coding agent (or junior team) to build from, module by module. Each module is self-contained, has explicit acceptance criteria, and declares its dependencies. Build modules in the order given. Do not build anything marked **V2** — it is listed only so you don't design it out.

---

## 1. Product overview

### 1.1 One-liner
A trades & services directory for Trinidad & Tobago, inspired by Checkatrade (https://www.checkatrade.com/) — but where Checkatrade's trust comes from institutional verification (ID checks, qualifications, criminal-record checks), VOUCH's trust comes from your own phone contacts: **"Recommended by someone you know."**

### 1.2 The core mechanic (read this twice)
1. Users sign up with their **phone number** (OTP). The phone number in E.164 form is the universal identity key.
2. Users may optionally sync their device contacts. Contacts are normalized to E.164 and **hashed client-side** before upload. The server stores only hashes.
3. When a customer views a trader, the system checks: *did anyone whose phone number is in this customer's contacts vouch for this trader?* If yes, the UI shows **"Vouched for by 3 people you know"** with their names (as known to the platform) — the single most important UI element in the product.
4. Traders grow the network: at signup a trader invites their contacts (user-initiated WhatsApp shares, never automatic sends) to (a) vouch for them and (b) join if they provide a service themselves. Referral codes grant +1 free month per successful signup.

### 1.3 Locked product decisions (do not revisit)
| Decision | Value |
|---|---|
| Launch market | Trinidad only (Tobago + Caribbean later). Default country code +1-868. |
| Revenue model | Trader subscription after free period. Customers free forever. Billing module can ship post-launch (everyone starts with ≥6 free months). |
| Review model | **Positive-only ("recommendations-only").** A user can *vouch* for a trader or stay silent. No negative reviews, no public star-criticism. Silence is the signal. |
| Two-way ratings | No public rating of customers. Traders get a **private** block/"wouldn't work for again" flag that never displays anywhere. |
| Score threshold | Aggregate signals (vouch counts are fine to show always; any future computed scores need ≥3 vouches). |
| Dimension ratings (price/quality/timeliness/cleanliness/honesty) | **V2.** MVP vouch = endorsement + optional comment. Design the schema to accommodate dimensions later (see 4.7). |
| Radius/map search | **V2.** MVP uses a fixed region list for Trinidad. |
| Invites | User-initiated WhatsApp share sheets with prewritten message + referral code. **Never** send messages automatically from a backend to a contact list. Bonus is earned on successful referred signup, not on sending. |
| Contact privacy | Raw contact books never leave the device. SHA-256 hashes of E.164 numbers only. Users can delete their synced hashes at any time. |
| Platforms | Native mobile app (iOS + Android) via one codebase, plus a lightweight web app for (a) vouching via an invite link with no install and (b) admin. |

### 1.4 What we copy from Checkatrade (and what we replace)
Copy: trade-category + location search; rich trader profile pages (photo, trades, areas served, reviews/vouches, "request contact"); browse-by-popular-category homepage; dual sign-up paths ("Find someone" vs "I'm a trader").
Replace: Checkatrade's "12 checks / Verified" institutional badges → **social verification** ("X people you know vouch for this trader"). No guarantees, no fixed-price booking, no job-estimate calculator (all V2+ at best).

---

## 2. Architecture & stack

Chosen for buildability by a small team/agent, low ops burden, and cheap hosting. If you substitute a component, keep the contracts in this spec identical.

| Layer | Choice | Notes |
|---|---|---|
| Mobile app | **Expo (React Native, TypeScript)** | One codebase → iOS + Android. Use Expo Router, Expo Contacts, Expo Notifications, expo-sharing/Linking for WhatsApp share. |
| Web (vouch links + admin) | **Next.js (TypeScript)**, deployed on Vercel or similar | Two surfaces in one app: `/v/[token]` public vouch flow, `/admin/*` gated dashboard. |
| Backend | **Supabase** | Postgres, phone-OTP auth (Twilio Verify provider), Row Level Security, Edge Functions (TypeScript/Deno) for all privileged logic, Storage for profile photos. |
| Push | Expo Push Notifications | Store Expo push tokens per device. |
| Transactional messages | OTP via Twilio Verify (through Supabase auth). No other SMS sending in MVP. |
| Analytics | PostHog (free tier) or simple Postgres event table (see M11). |
| Repo | pnpm monorepo: `apps/mobile`, `apps/web`, `packages/shared` (types, zod schemas, phone utils), `supabase/` (migrations, functions). |

**Rules for the builder:**
- All database access from clients goes through RLS-protected tables or Edge Functions. Anything involving another user's data (matching, invites, credit grants) is an Edge Function only.
- Every table gets `id uuid pk default gen_random_uuid()`, `created_at timestamptz default now()`, `updated_at` via trigger.
- Shared zod schemas in `packages/shared` are the single source of truth for API payloads; mobile and web import them.
- Phone normalization lives in `packages/shared/phone.ts`: input → E.164 with default region `TT` (use `libphonenumber-js`). Hashing: `sha256(e164)` lowercase hex. One implementation, used by mobile, web, and edge functions identically. **Write unit tests for this first — the whole product depends on it.** Cases: `868-555-1234`, `5551234`, `+18685551234`, `18685551234`, numbers with spaces/dashes/parens, foreign numbers (keep valid E.164, don't force +1868 onto already-international numbers).

---

## 3. Data model (Postgres)

Full schema up front so modules don't fight over it. Migrations may add tables incrementally per module, but column names below are contractual.

```sql
-- M1
users (
  id uuid pk,                    -- = auth.users.id
  phone_e164 text unique not null,
  phone_hash text unique not null,        -- sha256(phone_e164)
  display_name text not null,
  avatar_url text,
  home_region_id int references regions,
  contact_sync_enabled boolean default false,
  referral_code text unique not null,     -- 6-char human code, e.g. 'JAM4KQ'
  referred_by_user_id uuid references users,
  role text not null default 'user',      -- 'user' | 'admin'
  deleted_at timestamptz
)

-- M2
regions ( id int pk, name text, parent_id int null )   -- seeded: Trinidad regions
trades (
  id int pk, slug text unique, name text,
  category text,                 -- e.g. 'Home & Building', 'Auto', 'Personal & Tuition'
  status text default 'active',  -- 'active' | 'proposed' | 'merged'
  merged_into_id int null
)
trader_profiles (
  id uuid pk, user_id uuid unique references users,
  business_name text, bio text, photo_url text,
  status text default 'active',       -- 'active' | 'lapsed' | 'suspended' | 'hidden'
  visible boolean generated: status = 'active',
  free_until date not null,           -- signup date + 6 months + credits
  onboarding_complete boolean default false
)
trader_trades (
  id uuid pk, trader_id uuid references trader_profiles,
  trade_id int references trades,
  unique (trader_id, trade_id)
)
trader_regions (
  trader_id uuid references trader_profiles,
  region_id int references regions,
  primary key (trader_id, region_id)
)

-- M4
contact_hashes (
  owner_user_id uuid references users,
  phone_hash text not null,
  primary key (owner_user_id, phone_hash)
)   -- NO names, NO raw numbers, ever.

-- M5
vouches (
  id uuid pk,
  voucher_user_id uuid references users,
  trader_id uuid references trader_profiles,
  trade_id int references trades,
  comment text,                        -- optional, max 400 chars
  source text not null,                -- 'app' | 'weblink'
  status text default 'published',     -- 'published' | 'removed_by_user' | 'removed_by_admin'
  unique (voucher_user_id, trader_id, trade_id)
)

-- M6
invites (
  id uuid pk,
  inviter_user_id uuid references users,
  kind text not null,            -- 'vouch_request' | 'join_invite'
  trader_id uuid null,           -- for vouch_request: whose vouch is requested
  token text unique not null,    -- url-safe, 16+ chars
  expires_at timestamptz not null   -- 30 days
)
referrals (
  id uuid pk,
  referrer_user_id uuid references users,
  referred_user_id uuid unique references users,
  credited boolean default false
)
credit_ledger (
  id uuid pk, user_id uuid references users,
  months int not null,            -- +1 per referral; -N for admin corrections
  reason text not null,           -- 'signup_bonus' | 'referral' | 'admin'
  ref_id uuid null
)

-- M8
push_tokens ( user_id uuid, token text, platform text, primary key (user_id, token) )

-- M9
flags (
  id uuid pk, reporter_user_id uuid, subject_type text,  -- 'trader' | 'vouch' | 'user'
  subject_id uuid, reason text not null,                 -- enum: 'fake_profile','impersonation','wrong_number','spam','other'
  detail text, status text default 'open',               -- 'open' | 'resolved' | 'dismissed'
  resolved_by uuid, resolution_note text
)
private_blocks (
  trader_user_id uuid references users,   -- the trader doing the blocking
  blocked_phone_hash text not null,
  note text,                              -- private, never displayed
  primary key (trader_user_id, blocked_phone_hash)
)

-- M11
events ( id bigserial pk, user_id uuid null, name text, props jsonb, created_at timestamptz )
```

**Key derived queries (implement as Postgres functions / views):**
- `friend_vouches(customer_id, trader_id)` → vouches on that trader where `voucher.phone_hash IN (select phone_hash from contact_hashes where owner_user_id = customer_id)`.
- `trader_summary(trader_id, viewer_id)` → `{ vouch_count_total, vouch_count_by_trade, friend_vouch_count (0 if viewer has no sync), friend_voucher_names[] }`.

---

## 4. Modules

Build order: **M0 → M1 → M2 → M3 → M5 → M4 → M6 → M7 → M8 → M9 → M11 → M10.**
(M5 before M4 so vouching works before graph matching; M10 billing last — free months buy you time.)

---

### M0 — Foundations
**Purpose:** Repo, environments, CI, shared packages.

**Tasks**
1. pnpm monorepo scaffold as in §2. Expo app boots to a placeholder screen; Next.js app boots; Supabase project with local dev via `supabase start`.
2. `packages/shared`: `phone.ts` (normalize + hash, with the unit tests from §2), zod schemas file, TypeScript types generated from the DB (`supabase gen types`).
3. Seed migration: `regions` (Trinidad: Port of Spain, San Fernando, Chaguanas, Arima, Couva–Tabaquite–Talparo, Diego Martin, Mayaro–Rio Claro, Penal–Debe, Point Fortin, Princes Town, San Juan–Laventille, Sangre Grande, Siparia, Tunapuna–Piarco; plus placeholder parent "Tobago" disabled). `trades` seeded with ~60 entries mirroring Checkatrade's list plus local additions — categories: Home & Building (plumber, electrician, mason, carpenter, painter, roofer, tiler, welder, AC technician, appliance repair, pest control, landscaper/gardener, pool cleaning, sprinkler systems, fencing, locksmith...), Auto (mechanic, car wash/detailing, auto electrician, tyre shop...), Personal & Home services (babysitting, housekeeping, cook/catering, hair & beauty, tailoring...), Tuition (maths, chemistry, physics, English, music lessons...), Events, Tech & Office.
4. CI: typecheck + tests on PR. EAS build profiles for the mobile app.

**Acceptance criteria**
- `pnpm test` passes phone-normalization suite.
- Fresh clone → documented steps → running mobile app against local Supabase in <30 min.

---

### M1 — Auth & identity
**Purpose:** Phone-OTP signup/login; user profile; referral code generation.
**Depends:** M0.

**Flows**
1. **Signup/login (mobile):** enter phone (default +1 868 prefix UI, but accept full international) → OTP via Supabase phone auth → if new user: collect `display_name`, `home_region_id` (picker), optional avatar. On create: compute `phone_hash`, generate `referral_code` (6 chars, unambiguous alphabet), insert `credit_ledger` row `signup_bonus, +6`.
2. **Referral code at signup:** optional field "Have a code?" → if valid, set `referred_by_user_id` and create `referrals` row (crediting handled in M6).
3. **Session:** standard Supabase session handling; logged-out users can still browse the directory read-only (M3) — vouching, contact sync, and trader signup require login.
4. **Account deletion:** in-app "Delete my account" → Edge Function: soft-delete user (`deleted_at`), hard-delete `contact_hashes`, anonymize vouches (`display_name` → "A former member", keep the vouch row for count integrity), revoke sessions. Required for app-store approval.

**Acceptance criteria**
- New user in <60s on a real device; OTP retry & wrong-code paths handled.
- `users.phone_hash` always equals `sha256(normalize(phone))` — verified by test.
- Deletion removes all contact hashes and PII; vouch counts on traders unchanged.

---

### M2 — Trader profiles & taxonomy
**Purpose:** Any user can become a trader; trader profile data; the trades taxonomy incl. self-declared new services.
**Depends:** M1.

**Flows**
1. **"I provide a service" onboarding** (entry points: signup upsell screen, profile tab, invite deep links): create `trader_profiles` (free_until = today + 6 months), pick 1–5 trades from taxonomy with typeahead; pick regions served (multi-select, "All Trinidad" shortcut); business name optional (defaults to display name); photo optional but nudged; bio ≤ 300 chars.
2. **Self-declared service not in taxonomy:** user types free text → create `trades` row with `status='proposed'`, attach to trader immediately (visible on their profile, shown under "Other services" until approved). Admin curates in M9 (approve → active, or merge → existing trade; merging re-points `trader_trades` and `vouches.trade_id`). *Optional enhancement, not required for MVP:* an Edge Function that calls an LLM to suggest the closest existing trade before creating a proposed one.
3. **Trader statuses:** `active` (default), `lapsed` (free period ended, unpaid — set by M10 job; profile stays visible with vouches but contact actions hidden, replaced by "This trader's listing is inactive"), `suspended`/`hidden` (admin).
4. A trader is also always a regular user (can vouch for others, search, etc.).

**Screens (mobile):** Become-a-trader wizard (3 steps), My trader profile (edit), public Trader Profile screen (shared with M3).

**Acceptance criteria**
- User → trader in ≤3 screens. Multi-trade, multi-region persisted correctly.
- Proposed trades appear on profile immediately and in admin queue.
- Lapsed traders remain in search results but are visibly inactive and uncontactable.

---

### M3 — Directory: search & browse
**Purpose:** The Checkatrade-style find-a-trader experience. Works logged out; gets personal in M4.
**Depends:** M2.

**Flows**
1. **Home screen:** search bar ("What do you need? e.g. plumber"), grid of popular categories (seeded order), region selector defaulting to user's `home_region_id` (or "All Trinidad" logged out).
2. **Search:** trade (typeahead against taxonomy incl. synonyms — add a `trades.keywords text[]` column) + region → results list.
3. **Result card:** photo, name/business, trades chips, regions, **vouch count** ("12 vouches"), and — once M4 exists — the friend line ("2 people you know", styled prominently, always sorted to top).
4. **Sort order:** (a) friend-vouch count desc, (b) total vouch count desc, (c) newest. Lapsed traders sort last within their band.
5. **Trader profile screen:** header (photo, name, trades, regions, member-since), social-proof block (total vouches; friend vouches with names once M4 lands), vouch list (voucher display name, trade, comment, date — newest first), actions: **Call** / **WhatsApp** (deep link `wa.me/<phone>`) / **Vouch for this trader** / overflow → Report (M9). Contact actions hidden when lapsed.
6. **Empty states matter:** no results → "No {trade} vouched in {region} yet — invite one" with share CTA (M6).

**Acceptance criteria**
- Logged-out browse works end-to-end (read-only RLS policies).
- Search returns correct traders for trade+region combos; keywords match ("ac", "air condition" → AC technician).
- P95 search < 500ms with 10k traders (index `trader_trades`, `trader_regions`).

---

### M5 — Vouches
**Purpose:** The recommendation object. Positive-only.
**Depends:** M3.

**Rules (contractual)**
1. A vouch = (voucher, trader, trade) + optional comment ≤400 chars. One per (voucher, trader, trade). Vouching for a trader on trade A says nothing about trade B.
2. **Positive-only:** there is no negative path anywhere in UI or schema beyond a user deleting their own vouch. No star input in MVP. (Schema note for V2 dimensions: add a `vouch_scores(vouch_id, dimension text, score int)` table later; do not build now.)
3. **Anti-gaming gate:** to vouch from the app, the voucher must satisfy at least one: (a) trader's `phone_hash` is in the voucher's `contact_hashes` (they actually know them), (b) voucher arrived via a vouch-request invite token (M6/M7), or (c) voucher had a prior contact event with the trader in-app (tracked in `events`: tapped Call/WhatsApp on that profile ≥7 days ago). Enforced in an Edge Function — never client-side only. UI copy when gated: "You can vouch for people you know — save their number or ask them for their vouch link."
4. Voucher can edit comment or remove their vouch anytime. Removal decrements counts.
5. Self-vouching blocked (voucher_user_id ≠ trader.user_id). New accounts (<24h) can hold at most 5 vouches (rate-limit rings).
6. Trader is notified on new vouch (M8). Trader cannot reply publicly, cannot hide a vouch (only admin can, via flags).

**Screens:** Vouch composer (pick trade from that trader's list, optional comment, submit → confetti moment — this is the product's generosity loop, make it feel good).

**Acceptance criteria**
- Duplicate vouch blocked at DB and UI level; edit/remove works.
- Gate (rule 3) enforced server-side; bypass attempt via direct API returns 403.
- Vouch counts on cards/profiles update immediately.

---

### M4 — Contact sync & graph matching
**Purpose:** The USP. "People you know" everywhere.
**Depends:** M1, M5.

**Flows**
1. **Opt-in moment:** post-signup screen explains value plainly: "See which traders your own contacts vouch for. Names and numbers never leave your phone — only anonymous fingerprints." Buttons: Enable / Not now. Also reachable from Settings and from a contextual nudge on trader profiles ("Sync contacts to see if anyone you know vouches for people like this").
2. **Sync (client):** read contacts via Expo Contacts → extract all phone numbers → normalize (TT default) → dedupe → hash → upload the hash array to an Edge Function → server replaces that user's `contact_hashes` rows (full replace per sync, in batches of 500). Store nothing else. Re-sync on app foreground max once/24h, and manual "Re-sync now" in Settings.
3. **Matching (server):** the two derived queries in §3 power: friend line on result cards, friend block on profiles ("Vouched for by **Keisha Mohammed** and **2 others you know**" — names come from the platform's `users.display_name` of matched vouchers, *not* from the viewer's address book, so we never need contact names).
4. **"Recommended by someone I know" filter** on search results (toggle chip). Logged-in + synced only.
5. **Reverse prompt (in-app only, no messaging):** after sync, if any of the user's contact hashes match existing *traders*, show a screen: "3 people in your contacts are on VOUCH as traders — do you want to vouch for them?" → straight into M5 composer. This is the cheap, compliant version of the ramble's "we identified 10 people you know."
6. **Disable/delete:** Settings toggle → deletes all `contact_hashes` rows for the user immediately; UI reverts to generic mode. State reflected in `users.contact_sync_enabled`.
7. **Permissions hygiene:** iOS `NSContactsUsageDescription` and Play Console declarations must describe exactly this use. Never block core app usage on the permission (store rejection risk): the app must remain fully usable without sync (generic vouch counts only).

**Acceptance criteria**
- Two test accounts, B's number in A's phone: B vouches for trader T → A sees "1 person you know" on T within one sync cycle.
- Server never receives a raw number or contact name during sync (verify by inspecting the Edge Function contract + logs).
- Disable removes all hashes (row count = 0) and the friend UI disappears.
- App fully functional with permission denied.

---

### M6 — Invites, referrals & free-month credits
**Purpose:** The growth loop, done compliantly: user-initiated WhatsApp shares + referral credits.
**Depends:** M1, M4, M5.

**Flows**
1. **Vouch-request (trader → their contacts):** trader taps "Ask for vouches" → if contacts synced, show their contact list *locally on device* (names from the phone, never uploaded) with checkboxes, pre-filtering out numbers in `private_blocks`; trader selects people (the "pruning" from the concept — they simply don't select unhappy customers) → for the selection, app generates one `invites` row (kind `vouch_request`, token) → opens WhatsApp share per recipient (or a single share to a group/broadcast — MVP: one-by-one `wa.me/<number>?text=<msg>` loop with a "next" UI) with prewritten message: *"I'm on VOUCH as a {trade}. If you've used my work, a vouch takes 30 seconds: {link}. If you offer a service yourself, join free with my code {CODE}."* Link = `https://<domain>/v/{token}`.
2. **Join-invite (anyone → anyone):** generic "Invite a friend" share: *"Find trades & services vouched by people you actually know. Join free: {link with ?code=}"*.
3. **Referral crediting (Edge Function, on signup with code):** create `referrals` row → validate (referred user is new, phone not previously registered, not self) → `credit_ledger +1 referral` for referrer → if referrer is a trader, extend `free_until` by 1 month → push notification "Your free time just went up ⏫". Cap: 24 referral months/user/year. `credited=true`.
4. **No automatic sending, anywhere.** The backend never messages a contact. All outbound goes through the OS share sheet / WhatsApp deep link with the user pressing send.

**Acceptance criteria**
- Full loop on device: trader selects 3 contacts → 3 WhatsApp drafts open sequentially with correct link/code.
- Signup with code credits exactly +1 month once (idempotent; retries safe).
- Blocked numbers (private_blocks) never appear in the selection list.

---

### M7 — Web vouch flow (no-install)
**Purpose:** The person receiving a WhatsApp vouch request must be able to vouch in <60s without installing anything. This makes or breaks the loop.
**Depends:** M5, M6. Lives in `apps/web`.

**Flow `/v/[token]`:**
1. Resolve token → show trader card (photo, name, trade(s)) + "Vouch for {name}".
2. Phone OTP inline (same Supabase auth) → if number is new, minimal account: display name only (region optional, defaulted from trader's region). This person is now a real user — their vouch will match into contact graphs.
3. Vouch composer (trade preselect if trader has one trade; else pick) → submit (source `'weblink'`; invite token satisfies the M5 gate) → success screen: "Done. {name} thanks you." + two CTAs: "Do you offer a service? Join free — 6 months on us" (deep link to app-store/app with referral code) and "Find vouched traders near you" (app link).
4. Expired/used token → friendly explanation + app link.

**Acceptance criteria**
- Cold visitor → published vouch in under 60s on a mid-range Android phone over mobile data.
- Web-created users can later log into the mobile app with the same number and see their vouch.

---

### M8 — Notifications & nudges
**Purpose:** Close the loops.
**Depends:** M4–M7.

**Push (Expo) triggers**
- New vouch received (trader).
- Referral credited (+1 month).
- "X people in your contacts joined as traders recently — vouch for them?" (weekly max).
- Sync nudge for non-synced users: "Members near you have vouched {n} traders this month — sync contacts to see who *you* know." (max 1/every 2 weeks, stop after 3 dismissals).

**Rules:** every notification type individually toggleable in Settings; hard cap 2 pushes/user/week except transactional (vouch received, referral). No SMS/email in MVP (email is V2).

**Acceptance criteria:** triggers fire on real devices; caps and toggles enforced server-side (a `notification_log` check before send).

---

### M9 — Trust, safety & admin
**Purpose:** Keep the graph honest without a moderation army; admin tools.
**Depends:** M2, M5. Admin UI lives in `apps/web /admin` (role-gated).

**User-facing**
1. **Report** on trader profiles and individual vouches. Reasons: fake profile / impersonation / wrong number / spam / other + free text. Confirmation copy notes that vouches can't be reported merely for disagreement (positive-only system: there's nothing negative to dispute — flags are for *factual* problems only).
2. **Private block (traders):** from a job-gone-bad reality — trader enters or picks a number → stored as hash + private note in `private_blocks`. Effects: excluded from their vouch-request lists (M6); that's all in MVP. Never visible to anyone, including admins by default.

**Admin dashboard**
- Flag queue: view subject, actions (dismiss / remove vouch / hide trader / suspend user), resolution note; audit-logged.
- Taxonomy curation: proposed trades list → approve / rename / merge-into (runs the re-pointing migration from M2).
- User/trader lookup by phone or name; credit adjustments (`credit_ledger` with reason `admin`).
- Basic ring detection report (read-only SQL view, reviewed manually): clusters of accounts created within 48h that only vouch for one trader; accounts whose vouches all share a device/IP. No auto-punishment in MVP.

**Acceptance criteria**
- Removing a vouch via admin decrements counts and notifies no one (quiet removal).
- Merging trade B into A re-points all trader_trades and vouches, and B's slug 301s to A in search.
- Every admin action writes an audit row.

---

### M11 — Analytics & metrics (build before billing)
**Purpose:** Know whether the loop works before charging anyone.
**Depends:** everything above. Implementation: `events` table + a tiny `track(name, props)` helper in shared; optional PostHog mirror.

**Must-track events:** signup (source: organic/referral/weblink), contact_sync_enabled/disabled, search_performed (trade, region, results_count, friend_results_count), profile_viewed, contact_tapped (call/whatsapp), vouch_created (source), vouch_request_sent (count of recipients), invite_link_opened, referral_credited, trader_onboarded.

**North-star dashboard (simple SQL, admin page):**
- % of searches where ≥1 result has a friend vouch (**the** metric — the product works when this passes ~30%).
- Viral factor: new signups via referral ÷ total signups, weekly.
- Vouch conversion: vouch-request links opened → vouches published.
- Trader activation: traders with ≥3 vouches within 14 days of signup.

---

### M10 — Subscriptions & billing (ship last; can be post-launch)
**Purpose:** Traders pay after free months. Customers never pay.
**Depends:** M2, M6.

**Design now, integrate later:**
1. Everything hangs off `trader_profiles.free_until` (already extended by referral credits). Nightly job: `free_until < today` and no active subscription → status `lapsed` (+ push warning at T-30, T-7, T-1 days).
2. **Payment provider decision (flagged, needs founder input):** Stripe does not support Trinidad & Tobago merchants. Realistic options: **WiPay** (Caribbean-native, TTD), First Atlantic Commerce/PowerTranz, or club the app under a foreign entity + Stripe. Also note: if subscription is sold *inside* the iOS app, Apple requires IAP (30/15% cut) — common workaround is web-based checkout on the trader's account page (Netflix model), which is fine for a service consumed off-platform but copy must comply with current App Store rules. **MVP recommendation: web checkout via WiPay, monthly TTD price (founder to set; placeholder TT$60/mo ≈ US$9), single tier, unlimited trades/regions.**
3. Tables when built: `subscriptions(user_id, provider, provider_ref, status, current_period_end)` + webhook Edge Function.
4. Lapsed behavior (already built in M2/M3): listed, vouches intact, uncontactable.

**Acceptance criteria (when built):** trial→paid→cancelled→lapsed lifecycle correct across webhook retries; no customer-facing payment UI anywhere.

---

## 5. V2 backlog (do NOT build; design-compatible)
- Dimension ratings on vouches (price, quality, timeliness, cleanliness, honesty, communication) + weighted filter/sort ("recommended by people I know, best for price").
- Radius/map-based service areas & distance search (PostGIS).
- Second-degree graph ("vouched by a contact of John, who you know").
- Trader portfolios (photo galleries of jobs), quote requests / job posting.
- Tobago + regional expansion (region tree already supports it).
- Email channel, richer ring detection/auto-moderation, trader analytics ("your profile was seen 40 times"), featured placement upsell.

## 6. Non-functional requirements
- **Privacy:** raw contacts never uploaded (client hashes only); privacy policy page (web) required before store submission; data-deletion flow (M1.4) documented publicly; comply with T&T Data Protection Act basics (purpose limitation, right to erasure). Salt note: unsalted SHA-256 of phone numbers is industry-typical for contact matching but is brute-forceable — document this honestly in the privacy policy; V2 may move to a private-set-intersection approach.
- **Security:** RLS on every table; Edge Functions validate auth on every call; rate limits on OTP requests, sync uploads, vouch creation; no secrets in the mobile bundle.
- **Performance:** search P95 <500ms @ 10k traders / 1M contact hashes (index `contact_hashes(phone_hash)` and `(owner_user_id)`).
- **Offline/poor data:** the app must degrade gracefully on 3G — cache last search results, queue vouch submissions.
- **Accessibility & tone:** plain English, Trinidad-flavored copy welcome; large touch targets (many users are tradespeople on cheap Androids in bright sunlight).

## 7. Open items for the founders (not blockers for M0–M5)
1. Final name + domain (needed by M6 for links).
2. Subscription price point in TTD; payment provider choice (M10).
3. Seed strategy: first ~50 traders to onboard personally in Port of Spain before public launch.
4. Legal review of vouch copy + privacy policy (one-time, local counsel).
