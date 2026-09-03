ALTER TABLE users ALTER COLUMN settings SET DEFAULT
  '{"memoryEnabled":true,"shortTermMemoryEnabled":true,"longTermMemoryEnabled":true,"emotionTrackingEnabled":true,"skillEvolutionEnabled":true,"returnNotesEnabled":true}'::jsonb;

UPDATE users
SET settings = settings || jsonb_build_object(
  'shortTermMemoryEnabled', COALESCE((settings->>'memoryEnabled')::boolean, true),
  'longTermMemoryEnabled', COALESCE((settings->>'memoryEnabled')::boolean, true)
)
WHERE NOT (settings ? 'shortTermMemoryEnabled')
   OR NOT (settings ? 'longTermMemoryEnabled');

ALTER TABLE memory_versions
  ADD COLUMN IF NOT EXISTS source_type text NOT NULL DEFAULT 'inferred'
    CHECK (source_type IN ('user_stated', 'inferred', 'system')),
  ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'user'
    CHECK (scope IN ('user', 'conversation')),
  ADD COLUMN IF NOT EXISTS scope_key text,
  ADD COLUMN IF NOT EXISTS sensitivity text NOT NULL DEFAULT 'normal'
    CHECK (sensitivity IN ('normal', 'sensitive')),
  ADD COLUMN IF NOT EXISTS evidence_quote text,
  ADD COLUMN IF NOT EXISTS confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_used_at timestamptz,
  ADD COLUMN IF NOT EXISTS parent_version_id uuid REFERENCES memory_versions(id) ON DELETE SET NULL;

ALTER TABLE memory_versions DROP CONSTRAINT IF EXISTS memory_versions_status_check;
ALTER TABLE memory_versions
  ADD CONSTRAINT memory_versions_status_check
    CHECK (status IN ('pending', 'accepted', 'active', 'superseded', 'rejected', 'withdrawn', 'expired'));

UPDATE memory_versions mv
SET scope = 'conversation',
    scope_key = evidence.conversation_id::text,
    valid_until = LEAST(
      COALESCE(mv.valid_until, mv.created_at + interval '7 days'),
      mv.created_at + interval '7 days'
    )
FROM (
  SELECT DISTINCT ON (me.memory_version_id)
    me.memory_version_id,
    msg.conversation_id
  FROM memory_evidence me
  JOIN messages msg ON msg.id = me.message_id AND msg.user_id = me.user_id
  ORDER BY me.memory_version_id, msg.created_at DESC
) evidence
WHERE mv.id = evidence.memory_version_id AND mv.tier = 'short';

UPDATE memory_versions
SET status = 'expired', is_active = false
WHERE tier = 'short' AND scope_key IS NULL AND status = 'active';

UPDATE memory_versions
SET scope = 'user', scope_key = NULL
WHERE tier = 'long';

WITH ranked AS (
  SELECT id, row_number() OVER (PARTITION BY memory_id ORDER BY created_at DESC, id DESC) AS position
  FROM memory_versions
  WHERE status = 'active'
)
UPDATE memory_versions mv
SET status = 'superseded', is_active = false
FROM ranked
WHERE mv.id = ranked.id AND ranked.position > 1;

ALTER TABLE memory_versions DROP CONSTRAINT IF EXISTS memory_versions_active_consistency_check;
ALTER TABLE memory_versions
  ADD CONSTRAINT memory_versions_active_consistency_check
    CHECK (is_active = (status = 'active'));

ALTER TABLE memory_versions DROP CONSTRAINT IF EXISTS memory_versions_scope_semantics_check;
ALTER TABLE memory_versions
  ADD CONSTRAINT memory_versions_scope_semantics_check CHECK (
    status IN ('accepted', 'superseded', 'rejected', 'withdrawn', 'expired')
    OR (tier = 'short' AND scope = 'conversation' AND scope_key IS NOT NULL AND valid_until IS NOT NULL)
    OR (tier = 'long' AND scope = 'user' AND scope_key IS NULL)
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_versions_one_active
  ON memory_versions(memory_id) WHERE status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_versions_one_pending
  ON memory_versions(memory_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_memory_versions_recall_scope
  ON memory_versions(user_id, status, scope, scope_key, tier, created_at DESC);

CREATE TABLE IF NOT EXISTS memory_events (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  memory_id uuid REFERENCES memories(id) ON DELETE CASCADE,
  version_id uuid REFERENCES memory_versions(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN (
    'created', 'candidate_created', 'updated', 'confirmed', 'superseded',
    'rejected', 'withdrawn', 'expired', 'used', 'embedding_updated'
  )),
  actor text NOT NULL CHECK (actor IN ('user', 'model', 'system')),
  trace_id text,
  content_hash text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_memory_events_user_created
  ON memory_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_events_memory_created
  ON memory_events(memory_id, created_at DESC);

CREATE TABLE IF NOT EXISTS memory_operations (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  operation text NOT NULL,
  request_hash text NOT NULL,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, idempotency_key)
);
