ALTER TABLE model_runs
  ALTER COLUMN estimated_cost_cny TYPE numeric(16, 8),
  ADD COLUMN IF NOT EXISTS transport text NOT NULL DEFAULT 'unknown';

ALTER TABLE benchmark_runs
  ADD COLUMN IF NOT EXISTS model_name text,
  ADD COLUMN IF NOT EXISTS transport text;
