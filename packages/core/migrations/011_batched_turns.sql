ALTER TABLE messages
  ADD COLUMN reply_to_message_id uuid REFERENCES messages(id) ON DELETE CASCADE,
  ADD COLUMN attempt_number integer NOT NULL DEFAULT 1,
  ADD COLUMN is_current_reply boolean NOT NULL DEFAULT true,
  ADD COLUMN client_request_id uuid;
CREATE UNIQUE INDEX idx_messages_current_reply ON messages(reply_to_message_id)
  WHERE role = 'assistant' AND is_current_reply AND reply_to_message_id IS NOT NULL;
CREATE UNIQUE INDEX idx_messages_client_request ON messages(user_id, client_request_id)
  WHERE client_request_id IS NOT NULL;
CREATE INDEX idx_messages_visible_page ON messages(user_id, conversation_id, created_at DESC, id DESC)
  WHERE is_current_reply;

ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_type_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_type_check CHECK (type IN (
  'reflection', 'profile_synthesis', 'session_summary', 'return_note',
  'evolve_skill', 'conversation_title', 'memory_embedding', 'memory_consolidation',
  'onboarding_plan'
));
CREATE UNIQUE INDEX idx_jobs_open_reflection ON jobs(user_id, (payload->>'conversationId'))
  WHERE type = 'reflection' AND status = 'pending' AND payload->>'sealed' = 'false';
CREATE UNIQUE INDEX idx_jobs_one_question_planner ON jobs(user_id)
  WHERE type = 'onboarding_plan' AND status IN ('pending', 'running');

CREATE TABLE onboarding_question_candidates (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  question jsonb NOT NULL,
  model_name text NOT NULL,
  source_answer_count integer NOT NULL,
  selected_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_question_candidates_ready ON onboarding_question_candidates(user_id, created_at)
  WHERE selected_at IS NULL;

ALTER TABLE model_runs ADD COLUMN first_delta_ms integer,
  ADD COLUMN usage_reported boolean NOT NULL DEFAULT true;

CREATE FUNCTION zhiwei_notify_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify(TG_ARGV[0], NEW.user_id::text);
  RETURN NEW;
END;
$$;
CREATE TRIGGER zhiwei_activity_notification AFTER INSERT ON activity_events
  FOR EACH ROW EXECUTE FUNCTION zhiwei_notify_change('zhiwei_activity');
CREATE TRIGGER zhiwei_job_notification AFTER INSERT OR UPDATE OF status, run_after ON jobs
  FOR EACH ROW EXECUTE FUNCTION zhiwei_notify_change('zhiwei_jobs');
