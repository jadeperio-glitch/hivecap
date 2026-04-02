# HiveCap — Claude Code Context

## What this is

AI-powered horse racing intelligence platform. Beta launch anchored to Kentucky Derby 2026 (May 3, 2026). Invite-only, 4–8 beta users. Tagline: "The Sharpest Mind at the Window."

---

## Stack

- **Framework:** Next.js 14 (App Router)
- **Hosting:** Vercel (GitHub connected)
- **Database:** Supabase — project URL: `https://dptzgdtytmnknordnglb.supabase.co`
- **AI:** Anthropic Claude API (`@anthropic-ai/sdk ^0.27`, model `claude-sonnet-4-5`)
- **Auth:** Supabase Auth with invite code gate (code: `maxplayer`)
- **Theming:** next-themes (defaults to dark, class-based)

---

## MVP Scope — ALL COMPLETE

1. User auth with invite code gate — **DONE**
2. Brain chat interface (Claude API) — **DONE**
3. Document upload to Brain — **DONE**
4. Community feed with posting — **DONE**

---

## Current build status (as of 2026-04-02)

### Pages

- `src/app/page.tsx` — landing page; async server component; nav adapts to auth state (Go to Brain vs Sign In + Get Access); Community Feed link visible to all
- `src/app/login/page.tsx` — Supabase signInWithPassword, redirects to `/brain`
- `src/app/signup/page.tsx` — invite code gate (`maxplayer`), username field (3–20 chars, `[a-zA-Z0-9_]`), Supabase signUp + immediate signIn, profile insert, redirects to `/brain`
- `src/app/brain/page.tsx` — streaming chat UI with typing indicator, auth guard, PDF drag-and-drop upload (ingestion pipeline flow — see below), document panel, conversation persistence (load most recent on page load), "Post to Feed" modal, nav links to Settings / Community Feed / Sign out; SHA-256 hash computed client-side before upload; after scan, Brain injects race-count prompt into chat and renders inline race selector buttons; `pendingIngestion` state tracks races_pending / races_extracted until all done or dismissed
- `src/app/feed/page.tsx` — community feed; compose box with brain_verified toggle + project selector; collapsed post cards (100-char preview, click to expand); real-time client-side search/filter; Brain badge on verified posts
- `src/app/settings/page.tsx` — auth-guarded settings; three sections: Identity (edit username, read-only email, change password), Brain (list + delete user_documents), Account (Delete Account with DELETE confirmation modal)

### API routes

- `src/app/api/brain/route.ts` — Claude streaming route; uses `messages.create({ stream: true })` (real Promise — API errors caught before response is returned); token budget enforced: 10 community posts × 300 chars, 5 docs × 3,000 chars, last 10 messages; full conversation persistence; returns `X-Conversation-Id` header; logs prompt budget on every request; context injection still reads `user_documents` (compat bridge — see ingestion section)
- `src/app/api/ingest/route.ts` — **new** PDF ingestion entry point (Steps 1–2b); receives `file` + client-computed `hash` (SHA-256); dedup check against `ingestion_log.pdf_hash`; lightweight Claude scan (doc type + race count + race date + track, 256 tokens); uploads extracted text to Supabase Storage `brain-ingestion/{user_id}/{hash}.txt`; inserts `pending_documents` + N `ingestion_jobs` (status: queued); returns `{ pending_document_id, document_type, total_races, race_date, track_name, races_pending }`
- `src/app/api/ingest/extract/route.ts` — **new** per-race extraction (Steps 3–10); receives `{ pending_document_id, race_index }`; downloads extracted text from storage; calls Claude with primary prompt (race 1) or follow-up prompt with horse context (races 2–N); validates JSON before any write; race resolution → horse resolution (merge logic) → performance write (source priority) → connections upsert; updates `ingestion_jobs` + `ingestion_log` + `pending_documents`; also inserts formatted summary into `user_documents` for Brain context compat; returns `{ status, message, races_extracted, races_pending }`
- `src/app/api/posts/route.ts` — GET (all posts DESC, returns `username`); POST (auth-gated, looks up username from profiles, stores `username` + `user_email`, max 2000 chars)
- `src/app/api/upload/route.ts` — **legacy** PDF upload; `pdf-parse@1.1.1` via `require("pdf-parse/lib/pdf-parse.js")`; stores extracted text in `user_documents`; not used by brain/page.tsx (replaced by /api/ingest flow) but left in place
- `src/app/api/results/route.ts` — The Racing API proxy (North America meets/entries/results)
- `src/app/api/account/delete/route.ts` — authenticated DELETE; uses admin client (service role key); explicit ordered deletes: messages → conversations → posts → user_documents → profile → auth.admin.deleteUser
- `src/app/api/health/route.ts` — GET; checks all env vars (presence only, no values exposed), live Supabase admin query, anon client connectivity; returns `{ healthy, env, supabase, supabase_anon }` — use for diagnosing 500s

### Lib

- `src/lib/supabase/client.ts` — browser client (createBrowserClient)
- `src/lib/supabase/server.ts` — server client (createServerClient + cookies())
- `src/lib/supabase/admin.ts` — admin client (service role key, no session persistence)
- `src/lib/racing-api.ts` — typed Racing API client; confirmed North America path: `/v1/north-america/meets` (hyphen); functions: `getNorthAmericaMeets`, `getNorthAmericaEntries`, `getNorthAmericaResults`

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

**`brain-ingestion`** bucket (`20260402_brain_schema.sql`) — holds extracted text files (not raw PDFs) at path `{user_id}/{pdf_hash}.txt`; private; per-user RLS; expires via `pending_documents.expires_at` (rows purged by pipeline, not bucket policy)

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
- **Role going forward:** compat bridge — `/api/ingest/extract` inserts a formatted summary here after each extraction so `brain/route.ts` context injection continues to work unchanged. Will be replaced when Brain context query is updated to read structured schema directly.

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

**`ingestion_log`** — audit trail and dedup anchor; every write logged here regardless of outcome; `user_id, source, source_ref, pdf_hash, horse_id FK→horses, race_id FK→races, status (success|partial|failed), notes`; `pdf_hash` is the SHA-256 checked in Step 2a — duplicate hash with status=success short-circuits all extraction

**`pending_documents`** — holds scan results until fully extracted or expired; `user_id, pdf_hash, document_type, total_races, race_date, races_extracted integer[], races_pending integer[], storage_ref, expires_at`; `expires_at = MAX(race_date, created_at) + 24 hours`; extracted schema rows never expire — only this reference falls away; RLS: scoped to owner

**`ingestion_jobs`** — one row per race per document; `ingestion_log_id FK→ingestion_log (nullable, set after Step 9), user_id, pdf_hash, race_index, total_races, status (queued|processing|success|partial|failed), error_notes`; jobs are isolated — failure on one does not affect others; RLS: scoped to owner

---

## Rule D — Shared Brain layer (LIVE)

`brain_verified` posts from the community feed are injected into every Brain request as "Community Intelligence." System prompt order:

1. Base persona
2. Community Intelligence (10 most recent `brain_verified` posts, each truncated to 300 chars — ≤3,000 chars total, fetched via admin client)
3. Personal Documents (5 most recent docs from `user_documents`, each truncated to 3,000 chars — ≤15,000 chars total, labeled as higher priority)
4. Document instruction

Conversation history capped at last 10 messages. Both context sections degrade gracefully — failures never block the Brain response.

Prompt budget logged on every request:
```
[brain] prompt budget — system: N chars | community: N chars | docs: N chars | messages: N
```

**Note on context source:** Layer 3 currently reads `user_documents`. Ingestion-extracted data is bridged into `user_documents` by `/api/ingest/extract` as a formatted summary after each race extraction. When the Brain context query is updated to read directly from the structured schema (`horses`, `performance`, `races`), this bridge is removed.

### Known Brain API issue (resolved 2026-03-28)
`messages.stream()` returns a `MessageStream` synchronously — the HTTP call fires lazily inside `for await`, inside `ReadableStream.start()`, AFTER the response is committed. API errors hit `controller.error()` with zero bytes sent, which Next.js converts to an opaque 500. Fixed by switching to `messages.create({ stream: true })` which is a real Promise — errors throw at `await` time, before any Response is returned.

---

## Brain Ingestion Architecture (LIVE as of 2026-04-02)

The Quinella Brain is a structured Supabase knowledge base. Not RAG at beta — Claude extracts structured fields into typed columns on upload. pgvector installed but dormant; activates post-Derby as the narrative layer.

### Ingestion pipeline

Two API routes, two phases:

**Phase 1 — `/api/ingest` (Steps 1–2b):**
1. Client computes SHA-256 hash before sending (Web Crypto API — `crypto.subtle.digest`)
2. Step 2a: Hash checked against `ingestion_log.pdf_hash` — duplicate with status=success returns immediately, file never transferred again
3. PDF text extracted via `pdf-parse`; unrecognized docs (scanned images, no text) return 422
4. Lightweight Claude scan (single call, 256 max tokens): document type + total races + race date + track name/abbreviation
5. Extracted text uploaded to Supabase Storage `brain-ingestion/{user_id}/{hash}.txt` (raw PDF never stored)
6. `pending_documents` row created; N `ingestion_jobs` rows created (status: queued)
7. Returns scan result; Brain injects race-count prompt into chat UI

**Phase 2 — `/api/ingest/extract` (Steps 3–10):**
- Triggered by user selecting a race in chat — one Claude call per user-selected race
- Downloads extracted text from Storage; determines primary prompt (race 1) vs follow-up prompt (races 2–N, includes horse context from prior extraction)
- Claude returns structured JSON; validated before any write — malformed response logs failure, no partial write
- **Step 4 — Race resolution:** match on track name (ilike) + race_date + race_number; insert track/race if new
- **Step 5 — Horse resolution:** Pass 1 exact name match → Pass 2 sire+dam confirm; both match = merge + `merge_confirmed=true`; name matches but sire/dam differ = new row + collision flag in `ingestion_log.notes`; no match = insert
- **Step 6 — Performance write:** check for existing row on horse_id + race_id; apply source priority — higher trust overwrites, lower trust logged only
- **Step 7 — Connections:** upsert trainer + jockey by name + role; career stats only
- **Steps 8–9:** update `ingestion_jobs` status; write `ingestion_log` entry (success/partial/failed — always written)
- Backward compat: inserts formatted summary into `user_documents` so Brain context injection works without changes to `brain/route.ts`
- Returns `{ status, message, races_extracted, races_pending }` — UI updates race selector inline

### Source priority hierarchy

Higher number = higher trust. Lower trust never overwrites higher trust — logged only.

| Priority | Source | Notes |
|---|---|---|
| 5 — Highest | equibase | Official breed registry |
| 4 | drf | Official; Beyer Speed Figures exclusively here |
| 3 | racing_api | Live official results |
| 2 | user_upload | Third-party document — unverified |
| 1 — Lowest | community | Derivative intelligence |

All available figures (Beyer, Equibase, Timeform) always shown with source labels. Never silently blended.

### Demand-driven extraction

Extraction is triggered by user intent — never batch-processed. One Claude API call per user-selected race. After each extraction the Brain prompts for the next race; user can dismiss at any time. Conversation re-entry: on Brain page load, `pending_documents` checked for unextracted races still within expiry window.

### Document expiry

`expires_at = MAX(race_date, created_at) + 24 hours`. Pre-race card held until race day + 24h; post-race card expires 24h from upload. UI nudge before expiry. **Extracted schema rows never expire** — only the `pending_documents` reference and the Storage text file fall away.

---

## Environment variables

Required in `.env.local` and Vercel (Settings → Environment Variables):

```
ANTHROPIC_API_KEY=...
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...   ← Supabase Dashboard → Settings → API → service_role
RACING_API_BASE_URL=https://api.theracingapi.com
RACING_API_USERNAME=...
RACING_API_PASSWORD=...
```

`SUPABASE_SERVICE_ROLE_KEY` is required for Delete Account (`/api/account/delete`). Server-side only — never expose to browser.

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

- **Beta data strategy:** user-uploaded PDFs + The Racing API for live results
- **The Racing API:** Basic Auth (base64 username:password); North America path confirmed: `/v1/north-america/meets`; returns `{ meet_id, track_id, track_name, country, date }`
- **Equibase / DRF:** B2B negotiations running in parallel — NOT blocking beta
- **Beyer Speed Figures:** DRF exclusive license — not available at beta
- **pgvector:** installed in Supabase but dormant — RAG deferred post-beta

---

## Next priorities

1. **Brain context query update** — update `brain/route.ts` Layer 3 to query structured schema (`horses`, `performance`, `races`) instead of `user_documents`; remove `user_documents` compat bridge from `/api/ingest/extract`
2. **Pending document re-entry UI** — on Brain page load, check `pending_documents` for unexpired unextracted races; surface prompt in chat ("You have N unextracted races from [track] [date] — want to continue?")
3. **Rule D UI** — surface shared Brain intelligence visibly to users (e.g., "N community findings loaded" indicator in Brain header)
4. **Conversation management** — list/switch/delete conversations from the Brain UI
5. **Projects** — wire project creation UI (schema exists, feed selector exists, no creation flow yet)
6. **Racing API integration** — surface live meet data in Brain or a dedicated /races page; write results into `races` + `performance` tables via `racing_api` source
7. **Real-time feed** — Supabase Realtime subscription on posts table instead of full refetch on submit
8. **RAG / pgvector** — vector search over structured schema narrative fields post-Derby

---

## Open holes (do not guess — flag and skip)

- **H-10:** Real-time results feed source API
- ~~**H-11:** Brain architecture (RAG vs vector DB vs hybrid)~~ — **CLOSED 2026-04-02.** Structured Supabase schema. Claude API extraction on upload. No RAG at beta. pgvector dormant — activates post-Derby.
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
