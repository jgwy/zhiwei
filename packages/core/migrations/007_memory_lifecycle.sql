ALTER TABLE memory_versions
  ADD COLUMN IF NOT EXISTS source_type text NOT NULL DEFAULT 'inferred'
    CHECK (source_type IN ('explicit', 'confirmed', 'inferred', 'system')),
  ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'user'
    CHECK (scope IN ('user', 'project', 'conversation')),
  ADD COLUMN IF NOT EXISTS sensitivity text NOT NULL DEFAULT 'normal'
    CHECK (sensitivity IN ('normal', 'sensitive')),
  ADD COLUMN IF NOT EXISTS importance real NOT NULL DEFAULT 0.5
    CHECK (importance >= 0 AND importance <= 1),
  ADD COLUMN IF NOT EXISTS evidence_quote text,
  ADD COLUMN IF NOT EXISTS last_confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_used_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_memory_versions_scope_active
  ON memory_versions(user_id, scope, is_active, created_at DESC);

CREATE TABLE IF NOT EXISTS memory_events (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  memory_id uuid,
  version_id uuid,
  event_type text NOT NULL CHECK (event_type IN ('created', 'updated', 'confirmed', 'promoted', 'superseded', 'withdrawn', 'expired', 'used')),
  content_hash text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_memory_events_user_created
  ON memory_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_events_memory_created
  ON memory_events(memory_id, created_at DESC);
