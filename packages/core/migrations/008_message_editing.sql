ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS history_revision bigint NOT NULL DEFAULT 0;

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS edited_at timestamptz,
  ADD COLUMN IF NOT EXISTS edit_count integer NOT NULL DEFAULT 0;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS profile_stale boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS skill_stale boolean NOT NULL DEFAULT false;

ALTER TABLE memory_versions
  ADD COLUMN IF NOT EXISTS source_conversation_id uuid REFERENCES conversations(id),
  ADD COLUMN IF NOT EXISTS source_message_id uuid,
  ADD COLUMN IF NOT EXISTS source_message_sequence bigint;

ALTER TABLE profile_snapshots
  ADD COLUMN IF NOT EXISTS source_conversation_id uuid REFERENCES conversations(id),
  ADD COLUMN IF NOT EXISTS source_message_sequence bigint;

ALTER TABLE return_notes
  ADD COLUMN IF NOT EXISTS source_message_id uuid,
  ADD COLUMN IF NOT EXISTS source_message_sequence bigint;

ALTER TABLE personal_skill_versions
  ADD COLUMN IF NOT EXISTS source_conversation_id uuid REFERENCES conversations(id),
  ADD COLUMN IF NOT EXISTS source_message_sequence bigint,
  ADD COLUMN IF NOT EXISTS evidence_message_ids uuid[] NOT NULL DEFAULT '{}';

ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_status_check;
ALTER TABLE jobs
  ADD CONSTRAINT jobs_status_check
  CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled'));

CREATE INDEX IF NOT EXISTS idx_messages_conversation_sequence_edit
  ON messages(conversation_id, sequence_no);
CREATE INDEX IF NOT EXISTS idx_memory_versions_source_sequence
  ON memory_versions(source_conversation_id, source_message_sequence);
CREATE INDEX IF NOT EXISTS idx_profile_snapshots_source_sequence
  ON profile_snapshots(source_conversation_id, source_message_sequence);
CREATE INDEX IF NOT EXISTS idx_return_notes_source_sequence
  ON return_notes(conversation_id, source_message_sequence);
CREATE INDEX IF NOT EXISTS idx_skill_versions_source_sequence
  ON personal_skill_versions(source_conversation_id, source_message_sequence);

WITH origins AS (
  SELECT DISTINCT ON (evidence.memory_version_id)
         evidence.memory_version_id, message.id AS message_id,
         message.conversation_id, message.sequence_no
  FROM memory_evidence AS evidence
  JOIN messages AS message ON message.id = evidence.message_id
  ORDER BY evidence.memory_version_id, message.created_at DESC, message.id DESC
)
UPDATE memory_versions AS version
SET source_conversation_id = origin.conversation_id,
    source_message_id = origin.message_id,
    source_message_sequence = origin.sequence_no
FROM origins AS origin
WHERE version.id = origin.memory_version_id
  AND version.source_message_id IS NULL;

WITH sources AS (
  SELECT DISTINCT ON (note.id) note.id AS note_id,
         message.id AS message_id, message.sequence_no
  FROM return_notes AS note
  JOIN messages AS message
    ON message.conversation_id = note.conversation_id
   AND message.created_at <= note.created_at
  ORDER BY note.id, message.sequence_no DESC
)
UPDATE return_notes AS note
SET source_message_id = source.message_id,
    source_message_sequence = source.sequence_no
FROM sources AS source
WHERE note.id = source.note_id
  AND note.source_message_id IS NULL;
