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

## Current build status (as of 2026-04-03)

### Pages

- `src/app/page.tsx` — landing page; async server component; nav adapts to auth state (Go to Brain vs Sign In + Get Access); Community Feed link visible to all
- `src/app/login/page.tsx` — Supabase signInWithPassword, redirects to `/brain`
- `src/app/signup/page.tsx` — open signup; username field (3–20 chars, `[a-zA-Z0-9_]`), Supabase signUp + immediate signIn, profile insert, redirects to `/brain`
- `src/app/brain/page.tsx` — streaming chat UI with typing indicator, auth guard, PDF drag-and-drop upload (ingestion pipeline flow — see below), document panel, conversation persistence (load most recent on page load), "Post to Feed" modal, nav links to Settings / Community Feed / Sign out; SHA-256 hash computed client-side before upload; after scan, Brain injects race-count prompt into chat and renders inline race selector buttons with actual race number + track + date labels; `pendingIngestion` state tracks races_pending / races_extracted until all done or dismissed
- `src/app/feed/page.tsx` — community feed; compose box with brain_verified toggle + project selector; 2000 char limit (none for admin); collapsed post cards (100-char preview, click to expand); real-time client-side search/filter; Brain badge on verified posts
- `src/app/settings/page.tsx` — auth-guarded settings; three sections: Identity (edit username, read-only email, change password), Brain (list + delete user_documents), Account (Delete Account with DELETE confirmation modal)

### API routes

- `src/app/api/brain/route.ts` — Claude streaming route; uses `messages.create({ stream: true })`; `buildSchemaContext` queries horses + performance + connections from structured schema (single batch performance query, no N+1); relevance-scoped community posts (query-matched only, max 3 when schema present, 6+ char term threshold); hard code-level no-data gate (no schema context AND no relevant community posts → fixed response, Claude never called); UI state messages filtered from conversation history; full conversation persistence; returns `X-Conversation-Id` header
- `src/app/api/ingest/route.ts` — PDF ingestion entry point (Steps 1–2b); receives `file` + client-computed `hash` (SHA-256); three-branch ownership dedup (Branch A: own → accept, Branch B: shared → accept, Branch C: other-user personal → allow full extraction); stale pending record cleanup (expired or stuck >2h with 0 races extracted → delete + allow fresh upload); lightweight Claude scan (doc type + race count + race date + track + actual race numbers, 256 tokens); extracted text uploaded to Supabase Storage; inserts `pending_documents` + N `ingestion_jobs`; returns `{ pending_document_id, document_type, total_races, race_numbers, race_date, track_name, races_pending }`
- `src/app/api/ingest/extract/route.ts` — per-race extraction (Steps 3–10); admin check at entry (isAdmin, brainLayer, textLimit); downloads extracted text from storage; PRIMARY_SYSTEM prompt with explicit odds parsing rules (ML column, decimal conversion table) and PP history extraction instructions; max_tokens 8192; post-extraction odds validation (< 0.5 nulled + flagged); race resolution → horse resolution (sire/dam conflict detection, tentative merge if pedigree absent) → performance write (source priority) → connections upsert; admin writes brain_layer='shared', non-admin writes brain_layer='personal'; admin uploads upgrade existing personal horse rows to shared; updates ingestion_jobs + ingestion_log + pending_documents; inserts formatted summary into user_documents (compat bridge — PENDING REMOVAL); returns `{ status, message, races_extracted, races_pending }`
- `src/app/api/posts/route.ts` — GET (all posts DESC); POST (auth-gated, max 2000 chars for non-admin, unlimited for admin)
- `src/app/api/user/role/route.ts` — GET; server-side admin check against `HIVECAP_ADMIN_USER_IDS`; returns `{ isAdmin: boolean }`; used by client components
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
- **Role going forward:** compat bridge only — `/api/ingest/extract` inserts a formatted summary here after each extraction so `brain/route.ts` context injection continues to work. PENDING REMOVAL when Brain context query is updated to read structured schema directly.

**`posts`** (`20260327_posts.sql` + `20260327_profiles.sql`)
- `id, user_id, user_email, username (nullable), project_id (nullable), conversation_id (nullable), content, brain_verified, created_at`
- RLS: authenticated users read all; users insert/delete own

### Brain ingestion tables (`20260402_brain_schema.sql`)

**`tracks`** — reference table; `id, name, abbreviation, location, surface_types text[]`; RLS: authenticated read/insert/update

**`horses`** — master entity; one row per unique horse confirmed by name + sire + dam; key fields: `name, sire, dam, dam_sire, trainer, jockey, owner, age, sex, color, foaling_date, notes, canonical_source, merge_confirmed boolean, source, brain_layer (shared|personal), uploaded_by uuid`; RLS: shared rows visible to all authenticated; personal rows scoped to owner

**`races`** — one row per race; always resolved before horse on ingestion; key fields: `track_id FK→tracks, race_date, race_number, race_name, distance, surface, condition, purse, class_level, claiming_price, field_size, notes, source`; RLS: authenticated read all

**`performance`** — core join table; one row per horse per race; key fields: `horse_id FK→horses, race_id FK→races`; per-figure source labels: `beyer_figure + beyer_source, equibase_speed_fig + equibase_source, timeform_rating + timeform_source`; dual-format fractions: `frac_quarter text + frac_quarter_sec decimal` (same for half, three-quarters, final); `running_style (E|EP|PS|C|S), trip_notes, trouble_line, brain_layer, uploaded_by, source`; `beyer_figure` NEVER zero-filled — null = not available; RLS: shared visible to all, personal scoped to owner

**`track_profiles`** — updated daily during meet; `track_id FK→tracks, meet_date, distance, surface, condition, wire_to_wire_pct, avg_frac_quarter/half/three_quarters, speed_bias, rail_position, notes`; avg fractions computed from performance decimal columns, never stored raw

**`connections`** — career stats only; `name, role (trainer|jockey), win_pct, itm_pct, roi, specialty_distance, specialty_surface, notes, source, updated_at`; meet-level stats computed dynamically from performance table — never stored here

**`brain_posts`** — Rule D write-back (separate from `posts` table); `user_id, content, brain_generated boolean, migrated_to_shared boolean, horse_id FK→horses (nullable), race_id FK→races (nullable), paywalled boolean`

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

`buildSchemaContext` in `brain/route.ts`:
- Baseline: fetches horses where `uploaded_by = userId OR brain_layer = 'shared'` (up to 50)
- Term match: `extractQueryTerms` (capitalized sequences) + lowercase fallback against baseline horse names
- Single batch performance query: `.in("horse_id", horseIds)` + client-side Map grouping (no N+1)
- Includes all fraction fields: `frac_quarter/half/three_quarters` + `_sec` variants
- Connections stats for all trainers/jockeys in result set

Community intelligence (Rule D):
- Relevance filter: 6+ char term threshold (filters generic "Derby", "Race", "Stakes")
- Schema present: top 3 relevant posts at 200 chars each (`cappedCommunityContext`)
- Schema absent: full relevant list at 300 chars each (`relevantCommunityContext`)
- Gate: `!schemaContext && !relevantCommunityContext` → return fixed no-data message, Claude never called

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
6. Extracted text uploaded to Storage `brain-ingestion/{user_id}/{hash}.txt`
7. `pending_documents` row created; N `ingestion_jobs` rows created (status: queued)
8. Returns scan result; Brain injects race-count prompt into chat UI

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
- Backward compat: inserts formatted summary into `user_documents` — **PENDING REMOVAL**
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
- **Rule D** — migration trigger from personal to shared Brain layer; LIVE as of 2026-03-27
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

1. **Remove user_documents compat bridge** — update `brain/route.ts` to query structured schema (`horses`, `performance`, `races`) directly; remove write in `extract/route.ts` and read in `brain/route.ts`
2. **Pending re-entry UI** — on Brain page load, check `pending_documents` for unexpired unextracted races; surface prompt in chat
3. **PP history extraction** — extract prior race lines per horse (Beyer figures, fractions from past starts) as separate performance records
4. **Phase 2 gated data access** — `brain_layer='gated'`, `user_data_access` table, upload = access unlock
5. **Conversation management** — list/switch/delete conversations from Brain UI
6. **Racing API entries integration** — build `/api/racing/entries` once Path A/B schema confirmed; write to `races` + `performance` + `horses` with `source='racing_api'`
7. **Real-time feed** — Supabase Realtime subscription on posts instead of full refetch
8. **RAG / pgvector** — post-Derby

---

## Open holes (do not guess — flag and skip)

- **H-10:** Real-time results feed source API
- ~~**H-11:** Brain architecture~~ — **CLOSED 2026-04-02.** Structured Supabase schema. Claude API extraction on upload. No RAG at beta.
- **H-13:** Vig percentage
- **H-17:** Free tier query caps
- **H-22:** Brain export fee structure

---

## Build rules

- Do not resolve open holes — flag them and move on
- Do not expand MVP scope without explicit instruction
- Do not touch Supabase schema without confirmation
- Branding only changes: do not touch data, routing, or auth logic
- Keep all API keys in `.env.local` — never hardcode
- Pronunciation note for any voice/TTS work: Beyer → "BUY-er"
