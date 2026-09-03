ALTER TABLE memory_versions
  ADD COLUMN IF NOT EXISTS memory_kind text NOT NULL DEFAULT 'profile'
    CHECK (memory_kind IN ('profile', 'learning', 'misconception', 'episode')),
  ADD COLUMN IF NOT EXISTS scope_key text;

ALTER TABLE memory_versions
  DROP CONSTRAINT IF EXISTS memory_versions_status_check;

ALTER TABLE memory_versions
  ADD CONSTRAINT memory_versions_status_check
  CHECK (status IN ('pending', 'active', 'superseded', 'withdrawn'));

UPDATE memory_versions mv
SET memory_kind = 'episode',
    scope = 'conversation',
    scope_key = evidence.conversation_id::text,
    valid_until = COALESCE(mv.valid_until, mv.created_at + interval '7 days')
FROM (
  SELECT DISTINCT ON (me.memory_version_id)
    me.memory_version_id,
    msg.conversation_id
  FROM memory_evidence me
  JOIN messages msg ON msg.id = me.message_id
  ORDER BY me.memory_version_id, msg.created_at DESC
) evidence
WHERE mv.id = evidence.memory_version_id AND mv.tier = 'short';

UPDATE memory_versions
SET memory_kind = 'episode',
    scope = 'conversation',
    valid_until = COALESCE(valid_until, created_at + interval '7 days')
WHERE tier = 'short';

UPDATE memory_versions
SET memory_kind = 'profile', scope = 'user', scope_key = NULL
WHERE tier = 'long' AND (memory_kind = 'episode' OR scope = 'conversation');

ALTER TABLE memory_versions
  DROP CONSTRAINT IF EXISTS memory_versions_tier_semantics_check;

ALTER TABLE memory_versions
  ADD CONSTRAINT memory_versions_tier_semantics_check CHECK (
    (tier = 'short' AND memory_kind = 'episode' AND scope = 'conversation' AND valid_until IS NOT NULL)
    OR
    (tier = 'long' AND memory_kind <> 'episode' AND scope <> 'conversation')
  );

CREATE INDEX IF NOT EXISTS idx_memory_versions_recall_scope
  ON memory_versions(user_id, status, scope, scope_key, tier, created_at DESC);

UPDATE users
SET settings = settings || jsonb_build_object(
  'shortTermMemoryEnabled', COALESCE((settings->>'memoryEnabled')::boolean, true),
  'longTermMemoryEnabled', COALESCE((settings->>'memoryEnabled')::boolean, true)
)
WHERE NOT (settings ? 'shortTermMemoryEnabled') OR NOT (settings ? 'longTermMemoryEnabled');

ALTER TABLE users ALTER COLUMN settings SET DEFAULT
  '{"memoryEnabled":true,"shortTermMemoryEnabled":true,"longTermMemoryEnabled":true,"emotionTrackingEnabled":true,"skillEvolutionEnabled":true,"returnNotesEnabled":true}'::jsonb;
