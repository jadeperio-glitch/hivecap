-- HiveCap Brain Schema — Ingestion System
-- Run in Supabase SQL Editor in order.
-- All decisions locked per BRAIN_BRIEF.md (H-11 closed).

-- ─────────────────────────────────────────────────────────────────────────────
-- STORAGE BUCKET
-- brain-ingestion: holds extracted text (not raw PDFs) until expires_at.
-- If INSERT fails because bucket already exists, the DO NOTHING handles it.
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('brain-ingestion', 'brain-ingestion', false, 52428800)
ON CONFLICT (id) DO NOTHING;

-- Users can upload/read their own extracted text files
CREATE POLICY "brain_ingestion_insert" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'brain-ingestion'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

CREATE POLICY "brain_ingestion_select" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'brain-ingestion'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

CREATE POLICY "brain_ingestion_delete" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'brain-ingestion'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- 2.4 tracks
-- Reference table — no user ownership, all authenticated users read.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tracks (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT        NOT NULL,
  abbreviation  TEXT,
  location      TEXT,
  surface_types TEXT[]
);

ALTER TABLE tracks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tracks_read" ON tracks
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "tracks_insert" ON tracks
  FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "tracks_update" ON tracks
  FOR UPDATE TO authenticated USING (true);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2.1 horses
-- brain_layer: shared = visible to all authenticated; personal = owner only.
-- uploaded_by: null when brain_layer = 'shared'.
-- merge_confirmed: true when sire+dam match confirmed on dedup.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS horses (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name             TEXT        NOT NULL,
  sire             TEXT,
  dam              TEXT,
  dam_sire         TEXT,
  trainer          TEXT,
  jockey           TEXT,
  owner            TEXT,
  age              INTEGER,
  sex              TEXT,
  color            TEXT,
  foaling_date     DATE,
  notes            TEXT,
  canonical_source TEXT,
  merge_confirmed  BOOLEAN     DEFAULT false,
  source           TEXT,
  brain_layer      TEXT        DEFAULT 'personal',
  uploaded_by      UUID        REFERENCES auth.users(id),
  created_at       TIMESTAMPTZ DEFAULT now() NOT NULL
);

ALTER TABLE horses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "horses_read" ON horses
  FOR SELECT TO authenticated
  USING (brain_layer = 'shared' OR uploaded_by = auth.uid());

CREATE POLICY "horses_insert" ON horses
  FOR INSERT TO authenticated
  WITH CHECK (uploaded_by = auth.uid() OR uploaded_by IS NULL);

CREATE POLICY "horses_update" ON horses
  FOR UPDATE TO authenticated
  USING (uploaded_by = auth.uid() OR brain_layer = 'shared');

-- ─────────────────────────────────────────────────────────────────────────────
-- 2.2 races
-- Always resolved before horse on ingestion (Step 4 before Step 5).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS races (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  track_id       UUID        REFERENCES tracks(id),
  race_date      DATE        NOT NULL,
  race_number    INTEGER     NOT NULL,
  race_name      TEXT,
  distance       TEXT,
  surface        TEXT,
  condition      TEXT,
  purse          INTEGER,
  class_level    TEXT,
  claiming_price INTEGER,
  field_size     INTEGER,
  notes          TEXT,
  source         TEXT,
  created_at     TIMESTAMPTZ DEFAULT now() NOT NULL
);

ALTER TABLE races ENABLE ROW LEVEL SECURITY;

CREATE POLICY "races_read" ON races
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "races_insert" ON races
  FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "races_update" ON races
  FOR UPDATE TO authenticated USING (true);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2.3 performance
-- One row per horse per race. Each figure has its own source label.
-- beyer_figure NEVER zero-filled — null = not available.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS performance (
  id                          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  horse_id                    UUID        NOT NULL REFERENCES horses(id),
  race_id                     UUID        NOT NULL REFERENCES races(id),
  post_position               INTEGER,
  finish_position             INTEGER,
  lengths_beaten              DECIMAL,
  beyer_figure                INTEGER,
  beyer_source                TEXT,
  equibase_speed_fig          INTEGER,
  equibase_source             TEXT,
  timeform_rating             INTEGER,
  timeform_source             TEXT,
  frac_quarter                TEXT,
  frac_quarter_sec            DECIMAL,
  frac_half                   TEXT,
  frac_half_sec               DECIMAL,
  frac_three_quarters         TEXT,
  frac_three_quarters_sec     DECIMAL,
  final_time                  TEXT,
  final_time_sec              DECIMAL,
  running_style               TEXT,
  weight_carried              INTEGER,
  odds                        DECIMAL,
  beaten_lengths_at_call_1    DECIMAL,
  beaten_lengths_at_call_2    DECIMAL,
  trip_notes                  TEXT,
  trouble_line                TEXT,
  brain_layer                 TEXT        DEFAULT 'personal',
  uploaded_by                 UUID        REFERENCES auth.users(id),
  source                      TEXT,
  created_at                  TIMESTAMPTZ DEFAULT now() NOT NULL
);

ALTER TABLE performance ENABLE ROW LEVEL SECURITY;

CREATE POLICY "performance_read" ON performance
  FOR SELECT TO authenticated
  USING (brain_layer = 'shared' OR uploaded_by = auth.uid());

CREATE POLICY "performance_insert" ON performance
  FOR INSERT TO authenticated
  WITH CHECK (uploaded_by = auth.uid() OR uploaded_by IS NULL);

CREATE POLICY "performance_update" ON performance
  FOR UPDATE TO authenticated
  USING (uploaded_by = auth.uid() OR brain_layer = 'shared');

-- ─────────────────────────────────────────────────────────────────────────────
-- 2.5 track_profiles
-- Updated daily during meet. avg_frac values computed from performance decimals.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS track_profiles (
  id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  track_id                UUID        NOT NULL REFERENCES tracks(id),
  meet_date               DATE        NOT NULL,
  distance                TEXT,
  surface                 TEXT,
  condition               TEXT,
  wire_to_wire_pct        DECIMAL,
  avg_frac_quarter        TEXT,
  avg_frac_half           TEXT,
  avg_frac_three_quarters TEXT,
  speed_bias              TEXT,
  rail_position           TEXT,
  notes                   TEXT,
  source                  TEXT,
  created_at              TIMESTAMPTZ DEFAULT now() NOT NULL
);

ALTER TABLE track_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "track_profiles_read" ON track_profiles
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "track_profiles_insert" ON track_profiles
  FOR INSERT TO authenticated WITH CHECK (true);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2.6 connections
-- Career stats only. Meet-level computed dynamically from performance table.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS connections (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name                TEXT        NOT NULL,
  role                TEXT        NOT NULL,
  win_pct             DECIMAL,
  itm_pct             DECIMAL,
  roi                 DECIMAL,
  specialty_distance  TEXT,
  specialty_surface   TEXT,
  notes               TEXT,
  source              TEXT,
  updated_at          TIMESTAMPTZ DEFAULT now() NOT NULL
);

ALTER TABLE connections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "connections_read" ON connections
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "connections_insert" ON connections
  FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "connections_update" ON connections
  FOR UPDATE TO authenticated USING (true);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2.7 brain_posts
-- Community posts — Rule D write-back. Separate from existing posts table.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS brain_posts (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID        NOT NULL REFERENCES auth.users(id),
  content             TEXT        NOT NULL,
  brain_generated     BOOLEAN     DEFAULT false,
  migrated_to_shared  BOOLEAN     DEFAULT false,
  horse_id            UUID        REFERENCES horses(id),
  race_id             UUID        REFERENCES races(id),
  paywalled           BOOLEAN     DEFAULT false,
  created_at          TIMESTAMPTZ DEFAULT now() NOT NULL
);

ALTER TABLE brain_posts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "brain_posts_read" ON brain_posts
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "brain_posts_insert" ON brain_posts
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

CREATE POLICY "brain_posts_delete" ON brain_posts
  FOR DELETE TO authenticated USING (user_id = auth.uid());

-- ─────────────────────────────────────────────────────────────────────────────
-- 2.8 ingestion_log
-- Every write to the Brain is logged here — audit trail and dedup.
-- pdf_hash checked before any extraction runs (Step 2a).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ingestion_log (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        REFERENCES auth.users(id),
  source      TEXT        NOT NULL,
  source_ref  TEXT,
  pdf_hash    TEXT,
  horse_id    UUID        REFERENCES horses(id),
  race_id     UUID        REFERENCES races(id),
  status      TEXT        NOT NULL,
  notes       TEXT,
  created_at  TIMESTAMPTZ DEFAULT now() NOT NULL
);

ALTER TABLE ingestion_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ingestion_log_read" ON ingestion_log
  FOR SELECT TO authenticated USING (user_id = auth.uid());

CREATE POLICY "ingestion_log_insert" ON ingestion_log
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

-- ─────────────────────────────────────────────────────────────────────────────
-- 2.9 pending_documents
-- Uploaded documents scanned but not yet fully extracted.
-- expires_at = MAX(race_date, created_at) + 24 hours.
-- Extracted schema rows never expire — only this reference falls away.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS pending_documents (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID        NOT NULL REFERENCES auth.users(id),
  pdf_hash        TEXT        NOT NULL,
  document_type   TEXT,
  total_races     INTEGER,
  race_date       DATE,
  races_extracted INTEGER[]   DEFAULT '{}',
  races_pending   INTEGER[]   DEFAULT '{}',
  storage_ref     TEXT,
  expires_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT now() NOT NULL
);

ALTER TABLE pending_documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "pending_documents_own" ON pending_documents
  FOR ALL TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- ─────────────────────────────────────────────────────────────────────────────
-- 2.10 ingestion_jobs
-- One row per race extraction job. Jobs run sequentially per user selection.
-- A failure on one job does not affect other jobs.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ingestion_jobs (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  ingestion_log_id  UUID        REFERENCES ingestion_log(id),
  user_id           UUID        NOT NULL REFERENCES auth.users(id),
  pdf_hash          TEXT        NOT NULL,
  race_index        INTEGER     NOT NULL,
  total_races       INTEGER     NOT NULL,
  status            TEXT        DEFAULT 'queued',
  error_notes       TEXT,
  created_at        TIMESTAMPTZ DEFAULT now() NOT NULL
);

ALTER TABLE ingestion_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ingestion_jobs_own" ON ingestion_jobs
  FOR ALL TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());
