-- Race Coverage Check — Phase 1 schema additions
-- Run in Supabase SQL Editor after 20260402_brain_schema.sql.
--
-- Adds admin-attestation fields to races:
--   expected_field_size — how many horses admin expects in the fully-seeded race
--   coverage_complete   — admin's explicit "I'm done seeding this race" flag
--   coverage_marked_by  — which admin set the flag
--   coverage_marked_at  — when they set it
--
-- Both expected_field_size AND coverage_complete must be satisfied for the
-- coverage check in /api/ingest to short-circuit extraction.

ALTER TABLE races
  ADD COLUMN IF NOT EXISTS expected_field_size  INTEGER,
  ADD COLUMN IF NOT EXISTS coverage_complete    BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS coverage_marked_by   UUID REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS coverage_marked_at   TIMESTAMPTZ;

-- Partial index for coverage lookup — only covers the rows that matter.
-- Used by checkRaceCoverage in src/lib/brain-coverage.ts.
CREATE INDEX IF NOT EXISTS idx_races_coverage_lookup
  ON races (track_id, race_date, race_number)
  WHERE coverage_complete = TRUE;
