ALTER TABLE users
  ADD COLUMN IF NOT EXISTS timezone text NOT NULL DEFAULT 'Asia/Shanghai';

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS sequence_no bigint;

WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY conversation_id
           ORDER BY created_at, id
         ) AS sequence_no
  FROM messages
)
UPDATE messages AS message
SET sequence_no = ranked.sequence_no
FROM ranked
WHERE message.id = ranked.id
  AND message.sequence_no IS NULL;

ALTER TABLE messages
  ALTER COLUMN sequence_no SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_conversation_sequence
  ON messages(conversation_id, sequence_no);

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS next_message_sequence bigint NOT NULL DEFAULT 1;

UPDATE conversations AS conversation
SET next_message_sequence = COALESCE((
  SELECT max(message.sequence_no) + 1
  FROM messages AS message
  WHERE message.conversation_id = conversation.id
), 1);

ALTER TABLE memory_versions
  ADD COLUMN IF NOT EXISTS event_time_kind text NOT NULL DEFAULT 'unknown'
    CHECK (event_time_kind IN ('point', 'range', 'ongoing', 'fuzzy', 'unknown')),
  ADD COLUMN IF NOT EXISTS event_time_start timestamptz,
  ADD COLUMN IF NOT EXISTS event_time_end timestamptz,
  ADD COLUMN IF NOT EXISTS temporal_precision text NOT NULL DEFAULT 'unknown'
    CHECK (temporal_precision IN ('minute', 'day', 'month', 'year', 'approximate', 'unknown')),
  ADD COLUMN IF NOT EXISTS temporal_expression text,
  ADD COLUMN IF NOT EXISTS source_timezone text,
  ADD COLUMN IF NOT EXISTS first_observed_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_confirmed_at timestamptz;

WITH evidence_times AS (
  SELECT evidence.memory_version_id,
         min(message.created_at) AS first_observed_at,
         max(message.created_at) AS last_confirmed_at
  FROM memory_evidence AS evidence
  JOIN messages AS message ON message.id = evidence.message_id
  GROUP BY evidence.memory_version_id
)
UPDATE memory_versions AS version
SET first_observed_at = evidence_times.first_observed_at,
    last_confirmed_at = evidence_times.last_confirmed_at
FROM evidence_times
WHERE version.id = evidence_times.memory_version_id
  AND (version.first_observed_at IS NULL OR version.last_confirmed_at IS NULL);

CREATE INDEX IF NOT EXISTS idx_memory_versions_last_confirmed
  ON memory_versions(user_id, last_confirmed_at DESC)
  WHERE is_active = true;
