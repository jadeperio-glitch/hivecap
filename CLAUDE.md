# HiveCap — Claude Code Context

## What this is

AI-powered horse racing intelligence platform. Beta launch anchored to Kentucky Derby 2026 (May 3, 2026). Open signup. Tagline: "The Sharpest Mind at the Window."

---

## Stack

- **Framework:** Next.js 14 (App Router)
- **Hosting:** Vercel (GitHub connected)
- **Database:** Supabase — project URL: `https://dptzgdtytmnknordnglb.supabase.co`
- **AI:** Anthropic Claude API (`@anthropic-ai/sdk ^0.27`, model `claude-sonnet-4-6`)
- **Auth:** Supabase Auth — open signup (invite code gate removed 2026-04-03)
- **Theming:** next-themes (defaults to dark, class-based)

---

## MVP Scope — ALL COMPLETE

1. User auth — **DONE**
2. Brain chat interface (Claude API) — **DONE**
3. Document upload to Brain — **DONE**
4. Community feed with posting — **DONE**

---

## Current build status (as of 2026-04-26, updated end-of-day)

### Pages

- `src/app/page.tsx` — landing page; async server component; nav adapts to auth state (Go to Brain vs Sign In + Get Access); Community Feed link visible to all
- `src/app/login/page.tsx` — Supabase signInWithPassword, redirects to `/brain`
- `src/app/signup/page.tsx` — open signup; username field (3–20 chars, `[a-zA-Z0-9_]`), Supabase signUp + immediate signIn, profile insert, redirects to `/brain`
- `src/app/brain/page.tsx` — streaming chat UI with typing indicator, auth guard, PDF drag-and-drop upload (ingestion pipeline flow — see below), document panel, conversation persistence (load most recent on page load), "Post to Feed" modal, nav links to Settings / Community Feed / Sign out; SHA-256 hash computed client-side before upload; after scan, Brain injects race-count prompt into chat and renders inline race selector buttons with actual race number + track + date labels; `pendingIngestion` state tracks races_pending / races_extracted until all done or dismissed; **coverage check response handling (NEW 2026-04-26):** `already_covered` response from `/api/ingest` injects coverage message into chat + renders 3 clickable prompt chips below message (gold-bordered, mirrors race-selector styling); chip click pre-fills input, chips clear on next message send; partial coverage response shows "races X covered — extracting Y" message then proceeds with normal race-selector flow for uncovered races only
- `src/app/feed/page.tsx` — community feed; compose box with project selector (no brain_verified toggle — feed posts always submit as brain_verified=false); 2000 char limit (none for admin); collapsed post cards (100-char preview, click to expand); real-time client-side search/filter; Brain badge on verified posts; trash icon delete button visible to post owner only (user_id comparison against authenticated session); optimistic removal on delete
- `src/app/settings/page.tsx` — auth-guarded settings; three sections: Identity (edit username, read-only email, change password), Brain (list + delete user_documents), Account (Delete Account with DELETE confirmation modal)
- `src/app/admin/coverage/page.tsx` — admin-only coverage marking UI; server component auth guard against `HIVECAP_ADMIN_USER_IDS`; redirects non-admin to `/`; renders client component with track dropdown, race date picker, race number + expected field size inputs, submit button; "Currently Marked Races" table showing performance count vs expected with green "Covered" / amber "Partial N/M" status badges; per-row Unmark button
- `src/app/admin/coverage/CoverageClient.tsx` — client component handling form state, POST/DELETE calls to `/api/admin/coverage`, table refresh on submit

### API routes

- `src/app/api/brain/route.ts` — Claude streaming route; model `claude-sonnet-4-6`; uses `messages.create({ stream: true, tools: [web_search_20250305] })`; four-tier knowledge hierarchy in system prompt (Brain KB → Community Intelligence → web search → Claude expertise); `buildSchemaContext` queries horses + performance + connections from structured schema (single batch performance query, no N+1); relevance-scoped community posts (query-matched only, max 3 when schema present, 6+ char term threshold); Claude always called (no-data gate removed); stream handler skips `input_json_delta` events, forwards only `text_delta` to client; UI state messages filtered from conversation history; full conversation persistence; returns `X-Conversation-Id` header
- `src/app/api/ingest/route.ts` — PDF ingestion entry point (Steps 1–2b); receives `file` + client-computed `hash` (SHA-256); three-branch ownership dedup (Branch A: own → accept, Branch B: shared → accept, Branch C: other-user personal → allow full extraction); stale pending record cleanup (expired or stuck >2h with 0 races extracted → delete + allow fresh upload); lightweight Claude scan (doc type + race count + race date + track + actual race numbers, 256 tokens); **race coverage check (NEW 2026-04-26):** after scan, before storage upload, calls `checkRaceCoverage` from `src/lib/brain-coverage.ts`. Three response paths: (a) all races covered → returns `status: 'already_covered'` with message + suggested prompt chips, NO `pending_documents`, NO `ingestion_jobs`, NO Claude extraction; (b) partial coverage → filters `racesToQueue` to uncovered indices only, adds `coverage_partial` field to response so UI can show "races X covered, extracting Y"; (c) no coverage → existing flow unchanged. Hash dedup pre-check (Branches A/B/C) still runs FIRST — coverage check only fires on hash misses. Extracted text uploaded to Supabase Storage; inserts `pending_documents` + N `ingestion_jobs`; returns `{ pending_document_id, document_type, total_races, race_numbers, race_date, track_name, races_pending }` for normal flow, or `{ status: 'already_covered', message, races_covered, suggested_prompts }` for coverage hit
- `src/app/api/ingest/extract/route.ts` — per-race extraction (Steps 3–10); admin check at entry (isAdmin, brainLayer, textLimit); downloads extracted text from storage; PRIMARY_SYSTEM prompt with explicit odds parsing rules (ML column, decimal conversion table) and PP history extraction instructions; max_tokens 8192; post-extraction odds validation (< 0.5 nulled + flagged); race resolution → horse resolution (sire/dam conflict detection, tentative merge if pedigree absent) → performance write (source priority) → connections upsert; admin writes brain_layer='shared', non-admin writes brain_layer='personal'; admin uploads upgrade existing personal horse rows to shared; updates ingestion_jobs + ingestion_log + pending_documents; returns `{ status, message, races_extracted, races_pending }`
- `src/app/api/posts/route.ts` — GET (all posts DESC; live username resolved from profiles via admin client batch query — never the stale post-time snapshot; `user_id` included in response for client-side ownership checks); POST (auth-gated, max 2000 chars for non-admin, unlimited for admin; `brain_verified` derived server-side as `isAdmin || Boolean(conversation_id)` — client-supplied value ignored; admin posts always brain_verified=true; non-admin posts require a conversation_id; **Rule D write-back**: after successful insert where `brain_verified=true`, inserts a row into `brain_posts` via admin client — failure is non-fatal, warns only); DELETE (auth-gated; users can only delete their own posts; admins can delete any post by id)
- `src/app/api/user/role/route.ts` — GET; server-side admin check against `HIVECAP_ADMIN_USER_IDS`; returns `{ isAdmin: boolean }`; used by client components
- `src/app/api/admin/coverage/route.ts` — admin coverage marking; admin check at entry (403 for non-admin); POST marks `coverage_complete=true`, sets `expected_field_size`, `coverage_marked_by`, `coverage_marked_at`; GET returns marked races with batch-counted performance rows (single batch query, no N+1); DELETE unmarks (sets `coverage_complete=false`, nulls marked_by/marked_at, does not delete performance data); Supabase nested relation cast handles both array and object response shapes
- `src/app/api/racing/entries/diagnostic/route.ts` — GET diagnostic; calls NA meets → finds target track → tries Path B (NA entries endpoint) then falls back to Path A (/v1/racecards); returns raw response + `path_used`; params: `?date=YYYY-MM-DD&track=<name>`
- `src/app/api/upload/route.ts` — **legacy** PDF upload; not used by brain/page.tsx (replaced by /api/ingest flow) but left in place
- `src/app/api/results/route.ts` — The Racing API proxy (North America meets/entries/results)
- `src/app/api/account/delete/route.ts` — authenticated DELETE; explicit ordered deletes: messages → conversations → posts → user_documents → profile → auth.admin.deleteUser
- `src/app/api/health/route.ts` — GET; checks all env vars (presence only), live Supabase connectivity; returns `{ healthy, env, supabase, supabase_anon }`

### Lib

- `src/lib/supabase/client.ts` — browser client (createBrowserClient)
- `src/lib/supabase/server.ts` — server client (createServerClient + cookies())
- `src/lib/supabase/admin.ts` — admin client (service role key, no session persistence)
- `src/lib/racing-api.ts` — typed Racing API client; confirmed North America path: `/v1/north-america/meets`; functions: `getNorthAmericaMeets`, `getNorthAmericaEntries`, `getNorthAmericaResults`, `getResults`, `getRacecard`, `getUpcomingRaces`
- `src/lib/brain-coverage.ts` — `checkRaceCoverage({ track_id, race_date, race_numbers })` returns one `RaceCoverageResult` per requested race number. Uses admin client (service role) to bypass RLS — coverage check is global, not per-user. Single batch query for races + single batch query for performance counts (no N+1). Reason codes: `fully_covered` | `race_not_found` | `not_marked_complete` | `insufficient_rows`. A race is `fully_covered` only if BOTH `coverage_complete=true` AND `performance_count >= expected_field_size`

### Components

- `src/components/ThemeProvider.tsx` — next-themes wrapper
- `src/components/ThemeToggle.tsx` — sun/moon toggle
- `src/components/HiveCapLogo.tsx` — crowned bee SVG + HIVE/CAP wordmark; `variant="dark"`: HIVE → `#FFFFFF`, CAP → `#F5C800`, 1.5px white stroke on bee body/head; `variant="light"`: HIVE → `#F5F2EC`; props: `size` (sm/md/lg), `variant` (light/dark), `markOnly` (boolean)

### Middleware

- `middleware.ts` — protects `/brain`, `/feed`, `/settings` (redirect to `/login` if unauthenticated); redirects authenticated users away from `/login` and `/signup` to `/brain`; never redirects `/` or `/api/*`

---

## Supabase schema

All migrations in `supabase/migrations/`. Run each in Supabase SQL Editor in order.

### Storage

**`brain-ingestion`** bucket (`20260402_brain_schema.sql`) — holds extracted text files (not raw PDFs) at path `{user_id}/{pdf_hash}.txt`; private; per-user RLS; expires via `pending_documents.expires_at`

### MVP tables

**`auth.users`** — managed by Supabase Auth

**`profiles`** (`20260327_profiles.sql`)
- `id UUID PRIMARY KEY REFERENCES auth.users ON DELETE CASCADE`
- `username TEXT NOT NULL UNIQUE`
- `created_at TIMESTAMPTZ DEFAULT now()`
- RLS: authenticated read all; users insert/update own

**`projects`** (`20260327_projects.sql`)
- `id, user_id, name, description, created_at`
- RLS: full CRUD scoped to owner

**`conversations`** (`20260327_conversations.sql`)
- `id, user_id, title, created_at, updated_at`
- RLS: full CRUD scoped to owner

**`messages`** (`20260327_conversations.sql`)
- `id, conversation_id, user_id, role (user|assistant), content, created_at`
- `conversation_id REFERENCES conversations ON DELETE CASCADE`
- RLS: SELECT + INSERT scoped to owner

**`user_documents`** (`20260327_projects.sql`)
- `id, user_id, filename, extracted_text, project_id (nullable), created_at`
- RLS: full CRUD scoped to owner
- **Status:** compat bridge removed — nothing in the application writes to or reads from this table anymore. Brain context reads structured schema directly. Table still exists in the DB; migration to drop it is a future cleanup task. `account/delete/route.ts` still references it in the delete cascade — leave until table is dropped.

**`posts`** (`20260327_posts.sql` + `20260327_profiles.sql`)
- `id, user_id, user_email, username (nullable), project_id (nullable), conversation_id (nullable), content, brain_verified, created_at`
- RLS: authenticated users read all; users insert/delete own

### Brain ingestion tables (`20260402_brain_schema.sql`)

**`tracks`** — reference table; `id, name, abbreviation, location, surface_types text[]`; RLS: authenticated read/insert/update

**`horses`** — master entity; one row per unique horse confirmed by name + sire + dam; key fields: `name, sire, dam, dam_sire, trainer, jockey, owner, age, sex, color, foaling_date, notes, canonical_source, merge_confirmed boolean, source, brain_layer (shared|personal), uploaded_by uuid`; RLS: shared rows visible to all authenticated; personal rows scoped to owner

**`races`** — one row per race; always resolved before horse on ingestion; key fields: `track_id FK→tracks, race_date, race_number, race_name, distance, surface, condition, purse, class_level, claiming_price, field_size, notes, source`; **coverage tracking (added 2026-04-26):** `expected_field_size INTEGER NULL`, `coverage_complete BOOLEAN NOT NULL DEFAULT FALSE`, `coverage_marked_by UUID REFERENCES auth.users`, `coverage_marked_at TIMESTAMPTZ`; partial index `idx_races_coverage_lookup` on `(track_id, race_date, race_number) WHERE coverage_complete = TRUE` for fast coverage check lookups; RLS: authenticated read all

**`performance`** — core join table; one row per horse per race; key fields: `horse_id FK→horses, race_id FK→races`; per-figure source labels: `beyer_figure + beyer_source, equibase_speed_fig + equibase_source, timeform_rating + timeform_source`; dual-format fractions: `frac_quarter text + frac_quarter_sec decimal` (same for half, three-quarters, final); `running_style (E|EP|PS|C|S), trip_notes, trouble_line, brain_layer, uploaded_by, source`; `beyer_figure` NEVER zero-filled — null = not available; RLS: shared visible to all, personal scoped to owner

**`track_profiles`** — updated daily during meet; `track_id FK→tracks, meet_date, distance, surface, condition, wire_to_wire_pct, avg_frac_quarter/half/three_quarters, speed_bias, rail_position, notes`; avg fractions computed from performance decimal columns, never stored raw

**`connections`** — career stats only; `name, role (trainer|jockey), win_pct, itm_pct, roi, specialty_distance, specialty_surface, notes, source, updated_at`; meet-level stats computed dynamically from performance table — never stored here

**`brain_posts`** — Rule D write-back (separate from `posts` table); `user_id, content, brain_generated boolean, migrated_to_shared boolean, horse_id FK→horses (nullable), race_id FK→races (nullable), paywalled boolean`; **status:** write-back LIVE as of 2026-04-08 — `POST /api/posts` inserts here whenever `brain_verified=true`; this table is currently write-only from the app (never read by `buildSchemaContext` or any route) — it is an audit log and future migration anchor only; Brain community intelligence reads directly from the `posts` table

**`ingestion_log`** — audit trail and dedup anchor; every write logged here regardless of outcome; `user_id, source, source_ref, pdf_hash, horse_id FK→horses, race_id FK→races, status (success|partial|failed), notes`

**`pending_documents`** — holds scan results until fully extracted or expired; `user_id, pdf_hash, document_type, total_races, race_date, races_extracted integer[], races_pending integer[], storage_ref, expires_at`; `expires_at = MAX(race_date end-of-day UTC, created_at) + 24 hours`; extracted schema rows never expire — only this reference falls away; RLS: scoped to owner

**`ingestion_jobs`** — one row per race per document; `ingestion_log_id FK→ingestion_log (nullable), user_id, pdf_hash, race_index, total_races, status (queued|processing|success|partial|failed), error_notes`; jobs are isolated; RLS: scoped to owner

---

## Admin seeding model (LIVE)

Two admin UUIDs set in `HIVECAP_ADMIN_USER_IDS` Vercel env var:
- `c362dc55-2d4e-4f17-9c46-bad0299e836e`
- `d1bc8479-d6c6-4fbd-a116-a695157acb6c`

Admin privileges:
- Extractions write `brain_layer = 'shared'` directly — no Rule D required
- Admin uploads upgrade existing `personal` horse rows to `shared`
- No text truncation limit (full document sent to Claude; non-admin capped at 12,000 chars)
- Unlimited community post character limit (non-admin capped at 2,000 chars)
- All admin posts are `brain_verified = true` regardless of whether a `conversation_id` is present (2026-04-08)
- `GET /api/user/role` returns `{ isAdmin: true }` — used by feed/page.tsx to hide char counter

---

## Hash dedup — three-branch ownership logic

Pre-check in `/api/ingest` before any PDF processing:

1. **Pending pre-check** — if user already has a `pending_documents` row for this hash:
   - `races_extracted` empty AND created >2h ago → stale/stuck, delete + allow fresh upload
   - `expires_at < now` → expired, delete + allow fresh upload
   - `races_extracted` non-empty → mid-pipeline, return `{ status: "ready" }`

2. **Branch A** — `ingestion_log` row exists where resolved horse has `uploaded_by = current_user` → silent accept
3. **Branch B** — resolved horse has `brain_layer = 'shared'` → silent accept (data accessible to all)
4. **Branch C** — resolved horse is another user's personal data → allow, run full extraction for current user

---

## Brain context query (LIVE)

`buildSchemaContext` in `brain/route.ts` — two execution paths; race-anchored runs first:

**Race-anchored path (added 2026-04-27, commit `c15168c`):**
- `extractRaceReference(query)` parses patterns like "race N", "race N at <track>", "race N on <date>", "Churchill on May 2". Returns `{ raceNumber, trackHint, dateHint }` or null. Date hints assumed 2026. Returns null if there is no race number AND the query lacks both a track and a date hint (prevents false positives on generic date mentions).
- `resolveRace(ref)` converts hints to a `races.id`: looks up track via `tracks.name ILIKE '%hint%'` (falls back to `abbreviation`), then queries `races` by `race_number + race_date + track_id`. Returns null if ambiguous or absent.
- When a race resolves: `buildRaceAnchoredContext(raceId)` fetches **all** performance rows for that race (no horse cap) with joined horse data, plus prior PP history for every horse in the field via a single batch query (no N+1). Connections stats included for all trainers/jockeys in the field.
- When a race ref is detected but does not resolve (or resolves to zero performance rows): `RACE_HALLUCINATION_GATE` is injected into the system prompt — explicitly tells Claude the Brain has no data for that race, forbids presenting any analysis as Brain Knowledge Base data, permits web search but requires it to be labeled.
- Vercel function logs: `[brain/schema] race ref detected:` and `[brain/schema] resolved race_id:` confirm parser + DB lookup for future debugging.

**Term-match + baseline path (fallback when no race ref detected):**
- Baseline: fetches horses where `uploaded_by = userId OR brain_layer = 'shared'` (up to **500** — raised from 50 on 2026-04-27; the 50-row cap caused silent misses once the shared Brain exceeded 50 horses; currently 214 shared horses and growing)
- Term match: `extractQueryTerms` (capitalized sequences) + lowercase fallback against the full 500-row baseline
- Single batch performance query: `.in("horse_id", horseIds)` + client-side Map grouping (no N+1)
- Renders top 15 horses with up to 5 prior performances each
- Includes all fraction fields: `frac_quarter/half/three_quarters` + `_sec` variants
- Connections stats for all trainers/jockeys in result set

Community intelligence:
- Source: reads directly from `posts` table where `brain_verified=true` — NOT from `brain_posts`
- Relevance filter: 6+ char term threshold (filters generic "Derby", "Race", "Stakes")
- Schema present: top 3 relevant posts at 200 chars each (`cappedCommunityContext`)
- Schema absent: full relevant list at 300 chars each (`relevantCommunityContext`)
- No-data gate removed — Claude is always called; web search fills gaps when Brain KB is empty

Web search:
- `web_search_20250305` tool passed to every `messages.create()` call
- Stream handler skips `input_json_delta` events; only `text_delta` forwarded to client
- `fullText` accumulated from text deltas only — safe to insert into Supabase as plain string

UI state messages filtered from conversation history before passing to Claude:
- "I found N race(s)...", "Brain updated", "Got it", "Select a race to extract", extraction failure messages

---

## Extraction prompts (LIVE)

**PRIMARY_SYSTEM** — full field extraction:
- Race-first ordering (track → horses → narrative)
- PP history: extract most recent prior race per horse from PP lines
- Dual fraction format: string (`:22.65`) + decimal (`22.65`) for all splits
- Odds: ML column explicit (read exact number, convert X-1 → decimal, never below 0.5)
- 3 most recent workouts only
- `max_tokens: 8192`; `stop_reason === 'max_tokens'` guard

**FOLLOW_UP_SYSTEM** — per-race index extraction for multi-race documents; includes horse context from primary pass for confirmation

Post-extraction validation: `odds < 0.5` → null + `odds_suspicious` extraction flag

---

## Brain Ingestion Architecture (LIVE as of 2026-04-02)

The Quinella Brain is a structured Supabase knowledge base. Not RAG at beta — Claude extracts structured fields into typed columns on upload. pgvector installed but dormant; activates post-Derby as the narrative layer.

### Ingestion pipeline

**Phase 1 — `/api/ingest` (Steps 1–2b):**
1. Client computes SHA-256 hash before sending (Web Crypto API — `crypto.subtle.digest`)
2. Stale/stuck pending pre-check (see hash dedup section above)
3. Three-branch ownership dedup check
4. PDF text extracted via `pdf-parse`
5. Lightweight Claude scan (256 max tokens): document type + total races + race numbers + race date + track
6. **Coverage check** (LIVE as of 2026-04-26): resolves track by name (ilike), calls `checkRaceCoverage`; Case A → short-circuit, return `already_covered`; Case B → filter racesToQueue to uncovered indices only; Case C → no-op
7. Extracted text uploaded to Storage `brain-ingestion/{user_id}/{hash}.txt` (skipped for Case A)
8. `pending_documents` row created with `races_pending = racesToQueue`; `ingestion_jobs` rows created for uncovered races only (skipped for Case A)
9. Returns scan result; Brain injects race-count prompt or coverage message + suggested prompt chips into chat UI

**Phase 2 — `/api/ingest/extract` (Steps 3–10):**
- Triggered by user selecting a race — one Claude call per user-selected race
- Admin check at entry: sets `isAdmin`, `brainLayer`, `textLimit`
- Downloads extracted text from Storage
- PRIMARY_SYSTEM (race 1) or FOLLOW_UP_SYSTEM (races 2–N)
- Validates JSON structure before any write
- Step 4: Race resolution (track → race, insert if new)
- Step 5: Horse resolution (name match → sire/dam conflict check; conflict = new row + flag; no pedigree data = tentative merge, `merge_confirmed=false`; confirmed = `merge_confirmed=true`)
- Step 6: Performance write (source priority — higher trust overwrites, lower trust logged only)
- Step 7: Connections upsert (career stats only)
- Steps 8–9: update `ingestion_jobs`, write `ingestion_log`
- Returns `{ status, message, races_extracted, races_pending }`

### Source priority hierarchy

| Priority | Source | Notes |
|---|---|---|
| 5 — Highest | equibase | Official breed registry |
| 4 | drf | Official; Beyer Speed Figures exclusively here |
| 3 | racing_api | Live official results |
| 2 | user_upload | Third-party document — unverified |
| 1 — Lowest | community | Derivative intelligence |

### Document expiry

`expires_at = MAX(race_date T23:59:59Z, created_at) + 24 hours`. pg_cron job runs hourly to delete expired storage objects and `pending_documents` rows (`20260402_storage_cleanup_cron.sql`).

---

## Content seeded (as of 2026-04-03)

- **Wood Memorial** (Aqueduct, April 4, 2026) — full 13-horse field, `brain_layer = 'shared'`
- **Bluegrass Stakes** (Keeneland, April 4, 2026) — in progress

---

## Phase 2 — Gated data access (NOT YET BUILT)

- New `brain_layer = 'gated'` for admin-seeded premium data
- `user_data_access` table: `user_id, pdf_hash, horse_ids, race_id, granted_at`
- Upload act = proof of purchase = access unlock
- `buildSchemaContext` checks `user_data_access` before returning gated data

---

## Environment variables

Required in `.env.local` and Vercel (Settings → Environment Variables):

```
ANTHROPIC_API_KEY=...
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...        ← Supabase Dashboard → Settings → API → service_role
RACING_API_BASE_URL=https://api.theracingapi.com
RACING_API_USERNAME=...
RACING_API_PASSWORD=...
HIVECAP_ADMIN_USER_IDS=<uuid1>,<uuid2>   ← comma-separated; server-side only
```

`SUPABASE_SERVICE_ROLE_KEY` and `HIVECAP_ADMIN_USER_IDS` are server-side only — never expose to browser.

---

## Current branding

- **Font:** Space Grotesk 700 for wordmark/display; DM Sans for body; DM Mono for data/mono
- **Logo:** Crowned bumblebee mascot (amber body `#E8A800`, black stripes, white crown with gold jewels `#F5C800`, Wayfarer sunglasses) + inline HIVE (black) CAP (amber) wordmark
- **Palette:**
  - `--gold: #E8A800`
  - `--gold-light: #F5C800`
  - `--gold-dark: #C8960A`
  - `--surface: #F5F2EC`
  - `--ink: #0F0F0F`
  - `--muted: #6B6860`
  - `--border: #E0DDD6`
  - `--card: #FDFBF8`

---

## Key terminology

- **Quinella Brain** — the ML-powered handicapping engine
- **The Oracle** — automated handicapping sub-brand
- **Rule D** — write-back to `brain_posts` whenever a `brain_verified=true` post is created; fires in `POST /api/posts` via admin client; LIVE as of 2026-04-08; currently audit log only — does not affect Brain query context (which reads `posts` directly)
- **UC-04** — wager outcome calculator
- **UC-09** — conversational ticket construction
- **The vig** — creator economy revenue share
- **Shared Brain / Personal Brain** — two-layer architecture

---

## Data sources

- **Beta data strategy:** admin-seeded PDFs (brain_layer=shared) + user-uploaded PDFs + The Racing API for live results
- **The Racing API:** Basic Auth (base64 username:password); North America path confirmed: `/v1/north-america/meets`; NA entries endpoint `/v1/north-america/meets/{meetId}/entries` returns 401 on current plan — Path A fallback (`/v1/racecards`) available in diagnostic route
- **Equibase / DRF:** B2B negotiations running in parallel — NOT blocking beta
- **Beyer Speed Figures:** DRF exclusive license — not available at beta
- **pgvector:** installed in Supabase but dormant — RAG deferred post-beta

---

## Open build items — next session

1. ~~**Remove user_documents compat bridge**~~ — **DONE 2026-04-04.** `extract/route.ts` write removed; `brain/route.ts` already read structured schema directly. Table still exists in DB — migration to drop it is a future cleanup.
2. ~~**Feed delete button**~~ — **DONE 2026-04-08.** Trash icon shows for post owner; DELETE route added; admin can delete any post.
3. ~~**Rule D write-back**~~ — **DONE 2026-04-08.** `POST /api/posts` inserts into `brain_posts` after every `brain_verified=true` post insert. Non-fatal (warns on failure). Currently audit log only.
4. ~~**Race coverage check**~~ — **DONE 2026-04-26.** Admin UI at `/admin/coverage`. Migration `20260426_race_coverage.sql` adds 4 columns to `races`. `/api/ingest` short-circuits on covered races, no extraction triggered. Validated end-to-end on Wood Memorial AND Kentucky Derby (2026-05-02 race 12 at Churchill Downs, 20-horse field after AE cleanup). User uploads of fully-covered races render coverage message + 3 clickable prompt chips, zero side effects.
5. ~~**Branch B response upgrade**~~ — **DONE 2026-04-26 (commit `ee607d0`).** `/api/ingest` Branch B now resolves race info from `ingestion_log.race_id` (added to the dedup query) and returns `status: 'already_covered'` with the same message + prompt chips shape as the coverage check. Validated end-to-end: non-admin user uploading a hash-match seeded PDF (Roxelana S.) gets the polished coverage card. Old log rows without race_id fall back to the bland "ready" message — backward-compatible. Frontend already handles the response shape, no UI changes needed.
6. ~~**Race-anchored Brain context + baseline cap fix**~~ — **DONE 2026-04-27 (commit `c15168c`).** Two stacked bugs confirmed via `/api/diagnostic/rls-check` (now deleted): RLS was never the issue — 214 shared horses and all 10 Race 5 performance rows were visible to non-admin users. Failure was entirely in `buildSchemaContext`: (1) 50-row baseline cap sliced off horses once shared Brain exceeded 50 entries; raised to 500. (2) No race-anchored context path — queries like "Race 5 at Churchill on May 2" contain no horse names and returned empty context even with full data present. Fixed by `extractRaceReference` + `resolveRace` + `buildRaceAnchoredContext` with hallucination gate for unresolvable refs. See Brain context query section above for full detail.
7. **Branch A response upgrade (NEW 2026-04-26)** — Branch A still returns the bland "Got it — ready to analyze" when the *original* uploader re-uploads their own seeded PDF. Same fix shape as Branch B: lookup race info via `ingestion_log.race_id`, return `already_covered`. Small ingest route change, no schema impact, no frontend impact. Worth doing for consistency — the original uploader is typically an admin doing testing/maintenance and is the most likely person to notice the inconsistency. Sits next to Branch B in `/api/ingest/route.ts`.
8. **Pending pre-check refinement (NEW 2026-04-26)** — `/api/ingest` short-circuits on any `pending_documents` row with non-empty `races_extracted` (treats it as "user is mid-pipeline"), even when the extraction is fully complete (`races_pending = []`). Stale completed pending rows mask the polished Branch B / coverage check UX until they expire 24h after race date. Fix: distinguish partial (`races_pending` non-empty → mid-pipeline, return ready) from complete (`races_pending` empty → fall through to dedup). Hit during Branch B verification on 2026-04-26 — manual `DELETE FROM pending_documents WHERE id = ...` worked as workaround. Low risk, ~30 min fix.
9. **Pending re-entry UI** — on Brain page load, check `pending_documents` for unexpired unextracted races; surface prompt in chat. Edge case but real (browser closes mid-extraction).
10. **PP history extraction** — extract prior race lines per horse (Beyer figures, fractions from past starts) as separate performance records.
11. **Phase 2 gated data access** — `brain_layer='gated'`, `user_data_access` table, upload = access unlock.
12. **Conversation management** — list/switch/delete conversations from Brain UI.
13. **Racing API entries integration** — build `/api/racing/entries` once Path A/B schema confirmed; write to `races` + `performance` + `horses` with `source='racing_api'`.
14. **Real-time feed** — Supabase Realtime subscription on posts instead of full refetch.
15. **Drop `user_documents` table** — migration to remove the table and its reference in `account/delete/route.ts` once confirmed nothing depends on it.
16. **Chunked extraction (Option B)** — replace single-call extraction with two-pass flow (race shell + horse roster, then loop horses N at a time). Solves the token wall on big fields without requiring manual page-by-page admin uploads. Post-Derby refactor. Reuses existing `PRIMARY_SYSTEM` for shell pass, needs new `HORSE_BATCH_SYSTEM` for horse passes. Watch for partial-write bugs (pass 1 succeeds, pass 2 fails mid-loop).
17. **AE / scratched / entered status modeling (H-25)** — `performance` table currently has no concept of whether a horse is in the active field. AE rows must be manually deleted today (see Derby ops note below). Schema migration adds `entry_status` enum to `performance`; `buildSchemaContext` filters to entered by default; coverage check counts only entered rows against expected_field_size. Required for any race with AEs to be cleanly handled. Manual deletion is the workaround for Derby 2026.
18. **RAG / pgvector** — post-Derby.

---

## Open holes (do not guess — flag and skip)

- **H-10:** Real-time results feed source API
- ~~**H-11:** Brain architecture~~ — **CLOSED 2026-04-02.** Structured Supabase schema. Claude API extraction on upload. No RAG at beta.
- **H-13:** Vig percentage
- **H-17:** Free tier query caps
- **H-22:** Brain export fee structure
- **H-23:** brain_verified editing threshold — how much can a user edit a Brain-generated post before it no longer qualifies for brain_verified=true and Rule D migration? Requires a defined policy and eventually a technical enforcement mechanism (e.g. similarity threshold between stored Brain output and submitted post content). Decision required before wide launch, not beta.
- **H-24:** "Post to Feed" smart shortcut — after a Brain response, offer a follow-up action: "Shrink to 2000 characters and post to feed?" Single click condenses the Brain output to 2000 chars and opens the Post to Feed modal pre-populated with the condensed version, brain_verified=true. Removes friction between good analysis and community publishing.
- **H-25:** AE / scratched / entered status modeling. `performance` table treats every row as a starter. Real-world races have AEs (also-eligibles) that don't run unless someone scratches. Workaround for Derby 2026: manually delete AE performance rows after admin seeding (preserve horse rows for fast recovery). Proper fix: add `entry_status` enum to `performance`, default `entered`, filter in `buildSchemaContext` and coverage check. Decision required before any future race with AEs is seeded.
- **H-26:** Coverage drift detection. If admin marks `coverage_complete=true` and someone later deletes performance rows (intentionally or via cascade), the coverage check correctly returns `not_covered (insufficient_rows)`, but the admin UI doesn't surface the drift. Add a "Drift" badge to the marked races table when actual_count != expected_field_size despite `coverage_complete=true`. Low priority — currently no automated process deletes performance rows.

---

## Build rules

- Do not resolve open holes — flag them and move on
- Do not expand MVP scope without explicit instruction
- Do not touch Supabase schema without confirmation
- Branding only changes: do not touch data, routing, or auth logic
- Keep all API keys in `.env.local` — never hardcode
- Pronunciation note for any voice/TTS work: Beyer → "BUY-er"

---

## Derby 2026 operational notes

**Kentucky Derby 2026 — seeded 2026-04-26.**

- `race_id`: `cb971314-71a7-432a-a6ba-82c887e00c7d`
- Track: Churchill Downs, Race 12, 2026-05-02
- Beyer par per DRF notes: 103
- Original PP upload: 24 horses (20 entered + 4 AEs)
- AEs deleted from `performance` post-seeding: Great White, Ocelli, Robusta, Corona de Oro
  - Horse rows preserved in `horses` table for fast recovery if any draw in
  - horse_ids: `8f4444f1-4ff6-4df5-a7b2-80526a7b7e84`, `0c2ca5b1-2416-4a29-9a06-1f6c80508673`, `1b00dca0-3e6b-4b69-86d7-521ea464cb04`, `bb7286f1-eb5d-403b-9da7-9e2e89b71885`
- Final `performance_count = 20` at `brain_layer = 'shared'`
- Coverage marked complete with `expected_field_size = 20`
- End-to-end validation: non-admin upload of full 6-page Derby PP → coverage check fires → "already covered" response → 3 prompt chips → Brain answers from seeded field. No extraction, no `pending_documents`, no `ingestion_jobs`, no `ingestion_log` writes.

**Seeding workflow used (Option A — page-by-page):**

1. Split Derby PP into 6 single-page PDFs (Chrome print-to-PDF, page range custom).
2. Upload each page sequentially as admin via `/brain` drag-and-drop.
3. Each page extraction resolves to the same `race_id` (track + date + race_number match).
4. After all 6 pages: verify `performance_count` matches expected entries via SQL.
5. If race has AEs, manually delete AE performance rows (preserve horse rows).
6. Mark coverage complete via `/admin/coverage` with `expected_field_size` = entered count.
7. Validate as non-admin in incognito — full PDF upload should hit coverage short-circuit.

**Reference PDF:** `HiveCap_PP_Seeding_SOP.pdf` (one-page printable SOP, generated 2026-04-26).

**Why page-by-page workflow:** single-call extraction hits `max_tokens` ceiling on large fields. Each Derby page contains 3–4 horses, comfortably under the 8192-token output limit. Chunked extraction (item 15 in open build items) replaces this manual workflow post-Derby.
