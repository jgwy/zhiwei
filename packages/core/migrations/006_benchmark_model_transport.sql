ALTER TABLE benchmark_runs
  ADD COLUMN IF NOT EXISTS model_name text,
  ADD COLUMN IF NOT EXISTS transport text;
