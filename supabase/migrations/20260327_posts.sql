-- MVP #4: Community feed posts
-- Run in Supabase SQL Editor (Dashboard → SQL Editor → New query)

CREATE TABLE IF NOT EXISTS posts (
  id              UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id         UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  user_email      TEXT        NOT NULL,
  project_id      UUID        REFERENCES projects(id) ON DELETE SET NULL,
  conversation_id UUID        REFERENCES conversations(id) ON DELETE SET NULL,
  content         TEXT        NOT NULL,
  brain_verified  BOOLEAN     DEFAULT false NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT now() NOT NULL
);

ALTER TABLE posts ENABLE ROW LEVEL SECURITY;

-- All authenticated users can read all posts (public feed)
CREATE POLICY "Authenticated users can read posts"
  ON posts FOR SELECT
  USING (auth.role() = 'authenticated');

-- Users can only insert their own posts
CREATE POLICY "Users can insert own posts"
  ON posts FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Users can delete their own posts
CREATE POLICY "Users can delete own posts"
  ON posts FOR DELETE
  USING (auth.uid() = user_id);
