CREATE TABLE IF NOT EXISTS model_runs (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  trace_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('dialogue', 'reflection', 'skill-evolution', 'question-planner', 'return-note')),
  adapter_id text NOT NULL,
  model_name text NOT NULL,
  input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  estimated_cost_cny numeric(12, 4) NOT NULL DEFAULT 0,
  duration_ms integer NOT NULL,
  finish_reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_model_runs_user_created ON model_runs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_model_runs_trace ON model_runs(trace_id);

