-- MVP #3: Document upload to Brain
-- Run this once in your Supabase SQL editor (Dashboard → SQL Editor → New query)

CREATE TABLE IF NOT EXISTS user_documents (
  id            UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id       UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  filename      TEXT        NOT NULL,
  extracted_text TEXT       NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- Row-level security: users can only see and modify their own documents
ALTER TABLE user_documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own documents"
  ON user_documents FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own documents"
  ON user_documents FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own documents"
  ON user_documents FOR DELETE
  USING (auth.uid() = user_id);
