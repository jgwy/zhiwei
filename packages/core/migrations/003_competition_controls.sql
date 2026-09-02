ALTER TABLE memory_versions
ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active'
CHECK (status IN ('active', 'superseded', 'withdrawn'));

UPDATE memory_versions SET status = 'superseded' WHERE is_active = false AND status = 'active';

CREATE TABLE IF NOT EXISTS memory_withdrawals (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  memory_id uuid NOT NULL,
  category text NOT NULL,
  content_hash text NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_memory_withdrawals_user_created ON memory_withdrawals(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS risk_events (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  conversation_id uuid NOT NULL REFERENCES conversations(id),
  message_id uuid NOT NULL REFERENCES messages(id),
  level text NOT NULL CHECK (level IN ('ordinary', 'ambiguous', 'immediate')),
  reason text NOT NULL,
  response_path text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_risk_events_user_created ON risk_events(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS benchmark_runs (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  prompt text NOT NULL,
  scenario text NOT NULL,
  adapter_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS benchmark_outputs (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES benchmark_runs(id),
  user_id uuid NOT NULL REFERENCES users(id),
  mode text NOT NULL CHECK (mode IN ('direct', 'profile', 'adaptive')),
  content text NOT NULL,
  claims jsonb NOT NULL DEFAULT '[]'::jsonb,
  latency_ms integer NOT NULL,
  estimated_tokens integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, mode)
);

CREATE TABLE IF NOT EXISTS benchmark_preferences (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES benchmark_runs(id),
  user_id uuid NOT NULL REFERENCES users(id),
  preferred_mode text NOT NULL CHECK (preferred_mode IN ('direct', 'profile', 'adaptive')),
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, user_id)
);
