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

## MVP Scope (locked — do not expand)

1. User auth with invite code gate — **DONE**
2. Brain chat interface (Claude API) — **DONE**
3. Document upload to Brain — **NOT STARTED**
4. Community feed with posting — **NOT STARTED**

---

## Current build status (as of 2026-03-27)

### Done
- `src/app/page.tsx` — landing page (hero, feature grid, header, footer)
- `src/app/login/page.tsx` — Supabase signInWithPassword, redirects to `/brain`
- `src/app/signup/page.tsx` — invite code gate, Supabase signUp + immediate signIn, redirects to `/brain`
- `src/app/brain/page.tsx` — streaming chat UI with typing indicator, auth guard, sign out
- `src/app/api/brain/route.ts` — Claude API streaming route (Node.js runtime, ReadableStream)
- `src/lib/supabase/client.ts` + `server.ts` — browser and server Supabase clients
- `src/components/ThemeProvider.tsx` — next-themes wrapper
- `src/components/ThemeToggle.tsx` — sun/moon toggle button
- `src/components/HiveCapLogo.tsx` — crowned bee SVG + HIVE(black)CAP(amber) wordmark; props: `size` (sm/md/lg), `variant` (light/dark), `markOnly` (boolean)

### Pending / known gaps
- MVP #3: document upload — not started
- MVP #4: community feed — not started

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
- **Logo component:** `HiveCapLogo.tsx` — props: `size` (sm/md/lg), `variant` (light/dark), `markOnly` (boolean)

---

## Key terminology

- **Quinella Brain** — the ML-powered handicapping engine
- **The Oracle** — automated handicapping sub-brand
- **Rule D** — migration trigger from personal to shared Brain layer
- **UC-04** — wager outcome calculator
- **UC-09** — conversational ticket construction
- **The vig** — creator economy revenue share
- **Shared Brain / Personal Brain** — two-layer architecture

---

## Data sources

- **Beta data strategy:** user-uploaded PDFs + The Racing API for live results
- **Equibase / DRF:** B2B negotiations running in parallel — NOT blocking beta
- **Beyer Speed Figures:** DRF exclusive license — not available at beta
- **pgvector:** installed in Supabase but dormant — RAG deferred post-beta

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
