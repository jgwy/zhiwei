ALTER TABLE memory_versions DROP CONSTRAINT IF EXISTS memory_versions_scope_semantics_check;

UPDATE memory_versions
SET scope = 'user', scope_key = NULL
WHERE tier = 'short';

UPDATE memory_versions
SET valid_until = NULL
WHERE tier = 'long';

ALTER TABLE memory_versions
  ADD CONSTRAINT memory_versions_scope_semantics_check CHECK (
    status IN ('accepted', 'superseded', 'rejected', 'withdrawn', 'expired')
    OR (
      tier = 'short' AND scope = 'user' AND scope_key IS NULL
      AND valid_until IS NOT NULL
    )
    OR (
      tier = 'long' AND scope = 'user' AND scope_key IS NULL
      AND valid_until IS NULL
    )
  );

DROP INDEX IF EXISTS idx_memory_versions_recall_scope;
CREATE INDEX IF NOT EXISTS idx_memory_versions_recall
  ON memory_versions(user_id, status, tier, created_at DESC);

ALTER TABLE memory_events DROP CONSTRAINT IF EXISTS memory_events_event_type_check;
ALTER TABLE memory_events
  ADD CONSTRAINT memory_events_event_type_check CHECK (event_type IN (
    'created', 'candidate_created', 'updated', 'confirmed', 'superseded',
    'rejected', 'withdrawn', 'expired', 'used', 'embedding_updated',
    'promoted', 'consolidated', 'restored'
  ));

ALTER TABLE memory_events DROP CONSTRAINT IF EXISTS memory_events_actor_check;
ALTER TABLE memory_events
  ADD CONSTRAINT memory_events_actor_check
    CHECK (actor IN ('user', 'model', 'system', 'developer'));

ALTER TABLE memory_withdrawals
  ADD COLUMN IF NOT EXISTS version_id uuid REFERENCES memory_versions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS source_message_id uuid REFERENCES messages(id) ON DELETE SET NULL;

ALTER TABLE profile_snapshots
  ADD COLUMN IF NOT EXISTS schema_version text NOT NULL DEFAULT 'legacy-v1',
  ADD COLUMN IF NOT EXISTS source_memory_version_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  ADD COLUMN IF NOT EXISTS score_change_reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS sync_status text NOT NULL DEFAULT 'legacy';

ALTER TABLE profile_snapshots DROP CONSTRAINT IF EXISTS profile_snapshots_sync_status_check;
ALTER TABLE profile_snapshots
  ADD CONSTRAINT profile_snapshots_sync_status_check
    CHECK (sync_status IN ('legacy', 'syncing', 'current', 'stale', 'failed'));

CREATE TABLE IF NOT EXISTS memory_version_parents (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  child_version_id uuid NOT NULL REFERENCES memory_versions(id) ON DELETE CASCADE,
  parent_version_id uuid NOT NULL REFERENCES memory_versions(id) ON DELETE CASCADE,
  relation text NOT NULL CHECK (relation IN ('supersedes', 'promotes', 'consolidates', 'restores')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (child_version_id, parent_version_id),
  CHECK (child_version_id <> parent_version_id)
);
CREATE INDEX IF NOT EXISTS idx_memory_version_parents_user
  ON memory_version_parents(user_id, created_at DESC);

ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_type_check;
ALTER TABLE jobs
  ADD CONSTRAINT jobs_type_check CHECK (type IN (
    'reflection', 'profile_synthesis', 'session_summary', 'return_note',
    'evolve_skill', 'conversation_title', 'memory_embedding', 'memory_consolidation'
  ));
