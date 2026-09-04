ALTER TABLE users ADD COLUMN merged_into_id uuid REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE users ADD CONSTRAINT users_merge_not_self CHECK (merged_into_id IS NULL OR merged_into_id <> id);
CREATE INDEX idx_users_merged_into ON users(merged_into_id) WHERE merged_into_id IS NOT NULL;

CREATE TABLE accounts (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  username text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE account_attempt_windows (
  bucket text PRIMARY KEY,
  attempts integer NOT NULL DEFAULT 1,
  started_at timestamptz NOT NULL DEFAULT now()
);

-- A request that started before recovery must not write new orphaned guest data.
-- Existing rows keep their IDs; recovery changes ownership, not their content.
CREATE FUNCTION zhiwei_check_data_owner() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE merged uuid;
BEGIN
  SELECT merged_into_id INTO merged FROM users WHERE id = NEW.user_id FOR KEY SHARE;
  IF merged IS NOT NULL THEN
    RAISE EXCEPTION 'account_session_changed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'accounts', 'conversations', 'messages', 'conversation_summaries',
    'memories', 'memory_versions', 'memory_evidence', 'profile_snapshots',
    'mood_samples', 'personal_skill_versions', 'feedback', 'return_notes',
    'jobs', 'trace_events', 'mcp_calls', 'activity_events', 'model_runs',
    'memory_withdrawals', 'risk_events', 'benchmark_runs', 'benchmark_outputs',
    'benchmark_preferences', 'message_sources', 'onboarding_question_plans',
    'memory_events', 'memory_operations', 'memory_version_parents',
    'onboarding_question_candidates'
  ] LOOP
    EXECUTE format('CREATE TRIGGER zhiwei_active_owner BEFORE INSERT OR UPDATE OF user_id ON %I FOR EACH ROW EXECUTE FUNCTION zhiwei_check_data_owner()', table_name);
  END LOOP;
END;
$$;
