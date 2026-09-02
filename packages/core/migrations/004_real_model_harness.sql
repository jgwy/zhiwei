ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS title_source text NOT NULL DEFAULT 'default'
    CHECK (title_source IN ('default', 'model', 'manual')),
  ADD COLUMN IF NOT EXISTS title_locked boolean NOT NULL DEFAULT false;

ALTER TABLE memory_versions
  ADD COLUMN IF NOT EXISTS embedding_v2 vector(1024);

CREATE INDEX IF NOT EXISTS idx_memory_versions_embedding_v2
  ON memory_versions USING hnsw (embedding_v2 vector_cosine_ops)
  WHERE is_active = true AND embedding_v2 IS NOT NULL;

ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_type_check;
ALTER TABLE jobs
  ADD CONSTRAINT jobs_type_check CHECK (type IN (
    'reflection', 'profile_synthesis', 'session_summary', 'return_note',
    'evolve_skill', 'conversation_title', 'memory_embedding'
  )),
  ADD COLUMN IF NOT EXISTS idempotency_key text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_idempotency
  ON jobs(user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

ALTER TABLE model_runs DROP CONSTRAINT IF EXISTS model_runs_role_check;
ALTER TABLE model_runs
  ADD CONSTRAINT model_runs_role_check CHECK (role IN (
    'dialogue', 'reflection', 'skill-evolution', 'question-planner', 'return-note',
    'conversation-title', 'profile-synthesis', 'session-summary', 'fact-routing',
    'fact-brief', 'embedding'
  )),
  ADD COLUMN IF NOT EXISTS conversation_id uuid REFERENCES conversations(id),
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'completed'
    CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
  ADD COLUMN IF NOT EXISTS cached_input_tokens integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reasoning_tokens integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS search_calls integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS estimated_input_tokens integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS estimated_output_tokens integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS first_token_ms integer,
  ADD COLUMN IF NOT EXISTS request_id text,
  ADD COLUMN IF NOT EXISTS retries integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS fallback_from text,
  ADD COLUMN IF NOT EXISTS error_code text,
  ADD COLUMN IF NOT EXISTS thinking boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS sources jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS prompt_version text NOT NULL DEFAULT 'v1';

CREATE TABLE IF NOT EXISTS model_pricing_snapshots (
  id uuid PRIMARY KEY,
  model_name text NOT NULL,
  provider text NOT NULL,
  prices jsonb NOT NULL,
  capabilities jsonb NOT NULL DEFAULT '[]'::jsonb,
  context_window integer,
  source_request_id text,
  fetched_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_model_pricing_latest
  ON model_pricing_snapshots(model_name, fetched_at DESC);

CREATE TABLE IF NOT EXISTS message_sources (
  id uuid PRIMARY KEY,
  message_id uuid NOT NULL REFERENCES messages(id),
  user_id uuid NOT NULL REFERENCES users(id),
  title text NOT NULL,
  url text NOT NULL,
  site_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_message_sources_message ON message_sources(message_id);

CREATE TABLE IF NOT EXISTS onboarding_question_plans (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  step integer NOT NULL,
  question jsonb NOT NULL,
  model_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, step)
);
