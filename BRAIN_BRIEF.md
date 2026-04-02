# HiveCap Brain Ingestion Architecture — Claude Code Build Brief
April 2, 2026 · Confidential

All architectural decisions are locked. No open design questions remain. This is a build session.

---

## 1. Architecture Overview

The Quinella Brain is a structured Supabase knowledge base. It is not a RAG system at beta. Claude API handles extraction on upload — structured fields write to typed columns, narrative content writes to notes text fields. The Brain is queryable as a database, not a document store. pgvector is installed but dormant — activates post-Derby as the narrative layer.

### Three Ingestion Patterns

| Pattern | Channels | Storage |
|---|---|---|
| Structured extract | User uploads, DRF/Equibase API, Racing API results | Supabase typed columns |
| Narrative extract | News sources, social (post-Derby), community notes | notes text field → pgvector post-Derby |
| Brain output feedback | Community posts (Rule D), saved outputs | Direct write-back to schema |

### Beta Status

| Component | Status |
|---|---|
| Structured extraction (user uploads) | ACTIVE |
| Racing API (live results) | ACTIVE |
| DRF / Equibase API | DEFERRED — pending commercial agreement |
| News source ingestion | ACTIVE — manual curation into notes field |
| Social media firehose | DEFERRED — post-Derby with pgvector |
| Community post write-back (Rule D) | ACTIVE |
| pgvector / RAG | INSTALLED — DORMANT |

---

## 2. Supabase Schema

Build all tables in the order listed. Original PDFs are never stored — only extracted derivative data persists.

### 2.1 horses
Master entity. Every other table references this. One row per unique horse confirmed by name + sire + dam.

| Field | Type | Notes |
|---|---|---|
| id | uuid | PK |
| name | text | Canonical name |
| sire | text | |
| dam | text | |
| dam_sire | text | Broodmare sire |
| trainer | text | Current |
| jockey | text | Current |
| owner | text | |
| age | integer | |
| sex | text | C / F / G / M / H / R |
| color | text | |
| foaling_date | date | |
| notes | text | Narrative overflow — trainer quotes, barn notes |
| canonical_source | text | Highest trust source that confirmed this record |
| merge_confirmed | boolean | True = sire/dam match confirmed, not just name match |
| source | text | upload / racing_api / equibase / drf |
| brain_layer | text | shared / personal |
| uploaded_by | uuid | FK → users (null if shared) |
| created_at | timestamp | |

### 2.2 races
One row per race. Always resolved before horse on ingestion.

| Field | Type | Notes |
|---|---|---|
| id | uuid | PK |
| track_id | uuid | FK → tracks |
| race_date | date | |
| race_number | integer | |
| race_name | text | null if unnamed |
| distance | text | e.g. '1 1/16m' |
| surface | text | dirt / turf / synthetic |
| condition | text | fast / good / yielding / soft / firm |
| purse | integer | null if not found |
| class_level | text | G1 / G2 / G3 / Stakes / Allowance / Claiming / Maiden |
| claiming_price | integer | null if not claiming |
| field_size | integer | |
| notes | text | Race recap, stewards notes — narrative only |
| source | text | |
| created_at | timestamp | |

### 2.3 performance
Core join table. One row per horse per race. Each figure gets its own source label — never blend figures from different sources.

| Field | Type | Notes |
|---|---|---|
| id | uuid | PK |
| horse_id | uuid | FK → horses |
| race_id | uuid | FK → races |
| post_position | integer | |
| finish_position | integer | |
| lengths_beaten | decimal | |
| beyer_figure | integer | null if unavailable — NEVER zero |
| beyer_source | text | 'DRF' / 'user_upload' / null |
| equibase_speed_fig | integer | |
| equibase_source | text | |
| timeform_rating | integer | |
| timeform_source | text | |
| frac_quarter | text | String — e.g. ':22.65' — display only |
| frac_quarter_sec | decimal | Numeric — e.g. 22.65 — compute only |
| frac_half | text | |
| frac_half_sec | decimal | |
| frac_three_quarters | text | |
| frac_three_quarters_sec | decimal | |
| final_time | text | |
| final_time_sec | decimal | |
| running_style | text | E / EP / PS / C / S |
| weight_carried | integer | |
| odds | decimal | Morning line or final |
| beaten_lengths_at_call_1 | decimal | |
| beaten_lengths_at_call_2 | decimal | |
| trip_notes | text | Narrative — e.g. 'Sat fourth, four-wide turn' |
| trouble_line | text | null if clean trip |
| brain_layer | text | shared / personal |
| uploaded_by | uuid | FK → users |
| source | text | |
| created_at | timestamp | |

### 2.4 tracks

| Field | Type | Notes |
|---|---|---|
| id | uuid | PK |
| name | text | e.g. 'Churchill Downs' |
| abbreviation | text | e.g. 'CD' |
| location | text | |
| surface_types | text[] | e.g. ['dirt','turf'] |

### 2.5 track_profiles
Updated daily during meet. Average fractions computed from performance table decimal columns.

| Field | Type | Notes |
|---|---|---|
| id | uuid | PK |
| track_id | uuid | FK → tracks |
| meet_date | date | |
| distance | text | |
| surface | text | |
| condition | text | |
| wire_to_wire_pct | decimal | % races won on lead |
| avg_frac_quarter | text | |
| avg_frac_half | text | |
| avg_frac_three_quarters | text | |
| speed_bias | text | speed-favoring / neutral / closer-favoring |
| rail_position | text | inside / outside / middle |
| notes | text | |
| source | text | |
| created_at | timestamp | |

### 2.6 connections
Career stats only. Meet-level stats computed dynamically from performance table — never stored here.

| Field | Type | Notes |
|---|---|---|
| id | uuid | PK |
| name | text | |
| role | text | trainer / jockey |
| win_pct | decimal | Career |
| itm_pct | decimal | In the money % — career |
| roi | decimal | Career |
| specialty_distance | text | |
| specialty_surface | text | |
| notes | text | Quotes, reputation notes |
| source | text | |
| updated_at | timestamp | |

### 2.7 brain_posts
Community posts — Rule D write-back.

| Field | Type | Notes |
|---|---|---|
| id | uuid | PK |
| user_id | uuid | FK → users |
| content | text | The analysis |
| brain_generated | boolean | True = eligible for Brain feedback loop |
| migrated_to_shared | boolean | Rule D trigger |
| horse_id | uuid | FK → horses (optional) |
| race_id | uuid | FK → races (optional) |
| paywalled | boolean | |
| created_at | timestamp | |

### 2.8 ingestion_log
Every write to the Brain is logged here. Audit trail and duplicate detection.

| Field | Type | Notes |
|---|---|---|
| id | uuid | PK |
| source | text | upload / racing_api / drf / equibase / community |
| source_ref | text | Filename, API event ID, post ID |
| pdf_hash | text | SHA-256 hash — computed client-side before upload |
| horse_id | uuid | FK → horses (if resolved) |
| race_id | uuid | FK → races (if resolved) |
| status | text | success / partial / failed |
| notes | text | Extraction warnings and flags |
| created_at | timestamp | |

### 2.9 pending_documents
Holds uploaded documents scanned but not yet fully extracted. Supports demand-driven extraction.

| Field | Type | Notes |
|---|---|---|
| id | uuid | PK |
| user_id | uuid | FK → users |
| pdf_hash | text | |
| document_type | text | |
| total_races | integer | From Step 2b lightweight scan |
| race_date | date | Extracted during Step 2b — drives expiry calculation |
| races_extracted | integer[] | e.g. [1, 3] — tracks which races done |
| races_pending | integer[] | e.g. [2,4,5,6,7,8,9,10] |
| storage_ref | text | Temporary Supabase storage reference |
| expires_at | timestamp | MAX(race_date, created_at) + 24 hours |
| created_at | timestamp | |

### 2.10 ingestion_jobs
One row per race extraction job. Jobs run sequentially, each isolated — a failure on one job does not affect others.

| Field | Type | Notes |
|---|---|---|
| id | uuid | PK |
| ingestion_log_id | uuid | FK → ingestion_log |
| user_id | uuid | FK → users |
| pdf_hash | text | |
| race_index | integer | 1 of N |
| total_races | integer | N |
| status | text | queued / processing / success / partial / failed |
| error_notes | text | What failed and why |
| created_at | timestamp | |

---

## 3. Ingestion Pipeline

Architecture: Next.js API route (not Edge Function). Async extraction — user gets immediate processing status, UI updates as each job completes. Steps 3–10 repeat for each race job in the queue.

| Step | Name | Detail |
|---|---|---|
| 1 | Upload trigger | User drops PDF in Personal Brain upload zone. Frontend computes SHA-256 hash client-side. Sends hash + file to Next.js API route. |
| 2 | Document type detection | Lightweight Claude API call: what type of document is this? Past performance → full protocol. Other recognized type → partial extraction + flag. Unrecognized → return error to user. |
| 2a | PDF hash check | Query ingestion_log for matching pdf_hash. If match found → skip to Step 10: 'Brain already has this document.' If no match → continue. Hash computed client-side — file never moves on a duplicate hit. |
| 2b | Job queue creation | Lightweight Claude API pre-scan: how many races, what is the race date? Creates N jobs in ingestion_jobs. Prompts user: 'I found N races on this card for [Date] at [Track]. Which race do you want to start with?' |
| 3 | Primary extraction | User selects a race. Claude API receives PDF + primary extraction prompt with race index. Returns structured JSON. Validate JSON structure before any write — malformed response logs and surfaces error, no partial write attempted. |
| 4 | Race resolution | Match on track + race_date + race_number. If match → use existing race_id. If no match → insert new races row. Race always resolved before horse. |
| 5 | Horse resolution | Pass 1: exact name match. Pass 2: confirm sire + dam. Both match → use existing horse_id, merge canonical_source if incoming is higher trust. Name matches but sire/dam don't → do NOT merge, create new row, flag in ingestion_log as potential name collision. No match → insert new row. |
| 6 | Performance write | Check for existing performance row on horse_id + race_id. If exists → apply source priority hierarchy. Higher trust overwrites lower trust. Lower trust logged, does not overwrite. If no row → insert. |
| 7 | Connections update | Check connections for trainer and jockey. If exists → update updated_at, merge career stats if incoming source is higher trust. If no match → insert new row. |
| 8 | Job status update | Mark job complete in ingestion_jobs. Update races_extracted and races_pending in pending_documents. Do not auto-extract next race — wait for user to select. |
| 9 | Ingestion log write | Write to ingestion_log regardless of outcome. Success / partial / failed all get a row. |
| 10 | User feedback | Success: 'Brain updated. [Horse] — Race [N] at [Track] added.' Partial: 'Brain updated with flags. Some fields flagged — check upload history.' Failed: 'We couldn't process this race. [Reason].' Duplicate: 'Brain already has this document.' |

---

## 4. Extraction Prompts

### 4.1 Primary Extraction Prompt

Used in Step 3. Passed to Claude API with the uploaded PDF.

```
You are the HiveCap Brain ingestion engine. Your job is to extract
structured data from horse racing documents — primarily past performance
sheets — and return a clean JSON object that maps to the HiveCap schema.

EXTRACTION ORDER:
1. Identify the race context first (track, date, race number, distance,
   surface, condition, class, purse)
2. Then extract the horse within that race context (name, connections,
   figures, fractions, finish, trip notes)
3. Then extract narrative content (trainer quotes, barn notes, trip notes)
   into notes fields

DOCUMENT TYPE DETECTION:
- If this is a past performance sheet: follow full extraction protocol
- If this is a result chart, race card, clocker report, or workout tab:
  extract what maps to the schema, flag document_type in response,
  return partial object with document_type noted
- If document type cannot be determined: return
  { "status": "unrecognized", "notes": "<describe what you see>" }

HARD RULES:
- Never hallucinate a value. If a field is not clearly present, return
  null for numbers, "" for strings.
- Never zero-fill. A Beyer of 0 is not the same as a missing Beyer.
  Missing = null + flag in extraction_flags.
- Never blend figures from different sources. Each figure gets its own
  source label.
- Fractions: always populate both string and decimal versions if present.
  String preserves original formatting. Decimal strips to numeric only.
  Example: ":22.65" → frac_quarter = ":22.65", frac_quarter_sec = 22.65
- trip_notes and trouble_line are narrative — capture verbatim.
- notes fields are for narrative overflow only. Do not put structured
  data in notes.
- If the document contains multiple races for the same horse (full PP
  history), extract the most recent race as the primary record and note
  additional races in extraction_flags as:
  { "field": "additional_races", "count": N,
    "note": "full history available — extract remaining races?" }

Return only the JSON object. No preamble, no explanation,
no markdown fences.
```

### 4.2 Multi-Race Follow-Up Prompt

Used in Step 3 for races 2 through N. Variables in {curly braces} are populated by the pipeline at call time.

```
You are the HiveCap Brain ingestion engine processing one race from a
multi-race document.

YOUR TASK:
Extract data for race {race_index} of {total_races} from this document.
Use the same extraction protocol as the primary pass but target only
this specific race.

RACE TARGETING:
- Documents are ordered chronologically — most recent race first
- Race 1 = most recent, Race {total_races} = oldest
- Focus exclusively on race {race_index}
- Do not extract data from any other race in the document
- If race {race_index} cannot be clearly identified, return:
  { "status": "race_not_found", "race_index": {race_index},
    "notes": "<describe what you see at this position>" }

CONTEXT FROM PRIMARY PASS:
Horse name: {horse_name}
Sire: {sire}
Dam: {dam}
Use this to confirm you are extracting the correct horse.
If the horse at race {race_index} does not match, flag it:
{ "field": "horse_mismatch",
  "reason": "Horse at race {race_index} does not match {horse_name}" }

Apply all hard rules from the primary extraction protocol.
Return only the JSON object. No preamble, no explanation,
no markdown fences.
```

---

## 5. Source Priority Hierarchy

Higher trust source wins on conflict. Lower trust data is logged but does not overwrite.

| Priority | Source | Rationale |
|---|---|---|
| 1 — Highest | Equibase | Official breed registry |
| 2 | DRF | Official — Beyer Speed Figures exclusively licensed here |
| 3 | The Racing API | Live official results |
| 4 | User upload | Third-party document — unverified |
| 5 — Lowest | Community post (Rule D) | Derivative intelligence |

Display rule: always show all available figures (Beyer, Equibase, Timeform) with source labels. Never silently blend or pick one.

---

## 6. Demand-Driven Extraction Flow

Extraction is triggered by user intent, not batch-processed on upload. Never extract races the user hasn't asked for.

### Upload Flow
- User uploads PDF
- Step 2: document type detection
- Step 2a: hash check — skip entirely if duplicate
- Step 2b: lightweight race count + race date scan
- Brain prompts: "I found [N] races on this card for [Date] at [Track]. Which race do you want to start with?"
- User selects a race → Steps 3–10 run for that race only
- One Claude API extraction call per user-selected race

### Conversation Re-Entry
- After a natural break, Brain checks pending_documents for unextracted races
- Brain prompts: "You've analyzed Race [N]. Want to dig into another race from this card?"
- User selects next race → extraction runs on demand

### Document Expiry
- expires_at = MAX(race_date, created_at) + 24 hours
- Pre-race card: held until race day + 24 hours
- Post-race card: expires 24 hours from upload
- UI nudge before expiry — no silent drops
- Extracted schema rows never expire — only the PDF reference in pending_documents falls away

---

## 7. Horse Merge Logic

### Match Check Flow
- Pass 1: exact name match against horses table
- Pass 2: confirm with sire + dam
- Both match → use existing horse_id, set merge_confirmed = true
- Name matches, sire/dam don't → do NOT merge, create new row, flag as potential name collision
- No name match → insert new horses row

### Merge Timing
- Raw extracted data (figures, fractions) compounds into shared Brain immediately on match
- User's analysis and findings stay personal until Rule D fires (user publishes a post)
- The underlying source document never migrates — only derivative intelligence

### Meet-Level Stats
- NOT stored in connections table
- Computed dynamically from performance table by filtering on track + meet date range
- Career stats only on connections — keeps table clean, avoids stale cached stats

---

## 8. Locked Decisions — H-11 Closed

| Decision | Resolution |
|---|---|
| Brain technical architecture | Structured Supabase schema. Claude API extraction on upload. No RAG at beta. pgvector dormant — activates post-Derby. |
| Duplicate horse resolution | Merge on upload. Name + sire/dam confirmation. Raw data enriches shared Brain immediately. User findings stay personal until Rule D. |
| Conflict resolution | Source priority: Equibase → DRF → Racing API → user upload → community post. Discrepancies logged, never silently overwritten. |
| Figure display | All available figures shown with source labels. Never blended. figure_source column per figure on performance table. |
| Fraction storage | Dual format. String for display, decimal for compute. Both populated on ingestion. |
| Connections stats | Career stats only. Meet-level computed dynamically from performance table. |
| Social ingestion | Deferred post-Derby. Manual curation into notes at beta. |
| Document upload limits | No limit on number of documents a user can upload. |
| Community chat limits | No limit on number of community chats. |
| Extraction trigger | Demand-driven. User selects which race to extract. One API call per user-selected race. |
| Pending document expiry | MAX(race_date, created_at) + 24 hours. UI nudge before deletion. Extracted rows never expire. |
| Ingestion infrastructure | Next.js API route. Async with per-job progress updates. |
| PDF deduplication | SHA-256 hash computed client-side. Checked against ingestion_log before any extraction runs. |

---

*H-11 is closed. All decisions are locked. Begin building the ingestion system.*
