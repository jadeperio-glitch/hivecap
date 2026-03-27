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

## Current build status (as of 2026-03-27)

### Pages

- `src/app/page.tsx` — landing page; async server component; nav adapts to auth state (Go to Brain vs Sign In + Get Access); Community Feed link visible to all
- `src/app/login/page.tsx` — Supabase signInWithPassword, redirects to `/brain`
- `src/app/signup/page.tsx` — invite code gate (`maxplayer`), username field (3–20 chars, `[a-zA-Z0-9_]`), Supabase signUp + immediate signIn, profile insert, redirects to `/brain`
- `src/app/brain/page.tsx` — streaming chat UI with typing indicator, auth guard, PDF drag-and-drop upload, document panel, conversation persistence (load most recent on page load), "Post to Feed" modal, nav links to Settings / Community Feed / Sign out
- `src/app/feed/page.tsx` — community feed; compose box with brain_verified toggle + project selector; collapsed post cards (100-char preview, click to expand); real-time client-side search/filter; Brain badge on verified posts
- `src/app/settings/page.tsx` — auth-guarded settings; three sections: Identity (edit username, read-only email, change password), Brain (list + delete user_documents), Account (Delete Account with DELETE confirmation modal)

### API routes

- `src/app/api/brain/route.ts` — Claude streaming route; fetches 20 most recent `brain_verified` posts as shared community intelligence (prepended to system prompt); fetches user's personal documents (appended after, labeled as higher priority); full conversation persistence (create/append); returns `X-Conversation-Id` header
- `src/app/api/posts/route.ts` — GET (all posts DESC, returns `username`); POST (auth-gated, looks up username from profiles, stores `username` + `user_email`, max 2000 chars)
- `src/app/api/upload/route.ts` — PDF upload; `pdf-parse@1.1.1` via `require("pdf-parse/lib/pdf-parse.js")`; stores extracted text in `user_documents`
- `src/app/api/results/route.ts` — The Racing API proxy (North America meets/entries/results)
- `src/app/api/account/delete/route.ts` — authenticated DELETE; uses admin client (service role key); explicit ordered deletes: messages → conversations → posts → user_documents → profile → auth.admin.deleteUser

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

### Tables

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

**`posts`** (`20260327_posts.sql` + `20260327_profiles.sql`)
- `id, user_id, user_email, username (nullable), project_id (nullable), conversation_id (nullable), content, brain_verified, created_at`
- RLS: authenticated users read all; users insert/delete own

---

## Rule D — Shared Brain layer (LIVE)

`brain_verified` posts from the community feed are injected into every Brain request as "Community Intelligence." System prompt order:

1. Base persona
2. Community Intelligence (20 most recent `brain_verified` posts, fetched via admin client)
3. Personal Documents (user's uploaded PDFs — labeled as higher priority)
4. Document instruction

Both community and personal context degrade gracefully — failures never block the Brain response.

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

## Next priorities (post-MVP)

1. **Rule D UI** — surface shared Brain intelligence visibly to users (e.g., "N community findings loaded" indicator in Brain header)
2. **Conversation management** — list/switch/delete conversations from the Brain UI
3. **Projects** — wire project creation UI (schema exists, feed selector exists, no creation flow yet)
4. **Racing API integration** — surface live meet data in Brain or a dedicated /races page
5. **Real-time feed** — Supabase Realtime subscription on posts table instead of full refetch on submit
6. **RAG / pgvector** — vector search over user documents for more precise context injection

---

## Open holes (do not guess — flag and skip)

- **H-10:** Real-time results feed source API
- **H-11:** Brain architecture (RAG vs vector DB vs hybrid)
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
