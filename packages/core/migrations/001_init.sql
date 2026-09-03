CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY,
  onboarding_complete boolean NOT NULL DEFAULT false,
  settings jsonb NOT NULL DEFAULT '{"memoryEnabled":true,"shortTermMemoryEnabled":true,"longTermMemoryEnabled":true,"emotionTrackingEnabled":true,"skillEvolutionEnabled":true,"returnNotesEnabled":true}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS conversations (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  kind text NOT NULL CHECK (kind IN ('chat', 'onboarding')),
  title text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_conversations_user_updated ON conversations(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversations(id),
  user_id uuid NOT NULL REFERENCES users(id),
  role text NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation_created ON messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_user_created ON messages(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS conversation_summaries (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversations(id),
  user_id uuid NOT NULL REFERENCES users(id),
  summary text NOT NULL,
  source_message_id uuid REFERENCES messages(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_summaries_conversation_created ON conversation_summaries(conversation_id, created_at DESC);

CREATE TABLE IF NOT EXISTS memories (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id);

CREATE TABLE IF NOT EXISTS memory_versions (
  id uuid PRIMARY KEY,
  memory_id uuid NOT NULL REFERENCES memories(id),
  user_id uuid NOT NULL REFERENCES users(id),
  category text NOT NULL,
  content text NOT NULL,
  tier text NOT NULL CHECK (tier IN ('short', 'long')),
  confidence real NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  valid_until timestamptz,
  reason text NOT NULL,
  embedding vector(64),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_memory_versions_active ON memory_versions(user_id, is_active, created_at DESC);

CREATE TABLE IF NOT EXISTS memory_evidence (
  memory_version_id uuid NOT NULL REFERENCES memory_versions(id),
  message_id uuid NOT NULL REFERENCES messages(id),
  user_id uuid NOT NULL REFERENCES users(id),
  PRIMARY KEY (memory_version_id, message_id)
);

CREATE TABLE IF NOT EXISTS profile_snapshots (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  summary text NOT NULL,
  dimension_weights jsonb NOT NULL,
  understanding_components jsonb NOT NULL,
  understanding_score integer NOT NULL CHECK (understanding_score BETWEEN 0 AND 95),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_profiles_user_created ON profile_snapshots(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS mood_samples (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  conversation_id uuid NOT NULL REFERENCES conversations(id),
  message_id uuid NOT NULL REFERENCES messages(id),
  score integer NOT NULL CHECK (score BETWEEN -5 AND 5),
  summary text NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mood_user_observed ON mood_samples(user_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS personal_skill_versions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  version integer NOT NULL,
  content jsonb NOT NULL,
  trigger_reason text NOT NULL,
  expected_effect text NOT NULL,
  source text NOT NULL CHECK (source IN ('initial', 'model', 'developer_restore')),
  parent_id uuid REFERENCES personal_skill_versions(id),
  is_active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_skill_one_active ON personal_skill_versions(user_id) WHERE is_active = true;

CREATE TABLE IF NOT EXISTS feedback (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  message_id uuid NOT NULL REFERENCES messages(id),
  value text NOT NULL CHECK (value IN ('understood', 'not-me')),
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_feedback_user_created ON feedback(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS return_notes (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  conversation_id uuid NOT NULL REFERENCES conversations(id),
  content text NOT NULL,
  valid_after timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  shown_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS jobs (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  type text NOT NULL CHECK (type IN ('reflection', 'evolve_skill')),
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  run_after timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_jobs_claim ON jobs(status, run_after, created_at);

CREATE TABLE IF NOT EXISTS trace_events (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  trace_id text NOT NULL,
  stage text NOT NULL,
  payload jsonb NOT NULL,
  duration_ms integer,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_trace_user_created ON trace_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trace_id ON trace_events(trace_id, created_at);

CREATE TABLE IF NOT EXISTS mcp_calls (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  trace_id text,
  tool_name text NOT NULL,
  arguments jsonb NOT NULL,
  result jsonb NOT NULL,
  duration_ms integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mcp_user_created ON mcp_calls(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS activity_events (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  type text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_activity_user_created ON activity_events(user_id, created_at DESC);
