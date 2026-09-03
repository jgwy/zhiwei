ALTER TABLE model_runs DROP CONSTRAINT IF EXISTS model_runs_role_check;
ALTER TABLE model_runs
  ADD CONSTRAINT model_runs_role_check CHECK (role IN (
    'dialogue', 'reflection', 'skill-evolution', 'question-planner', 'return-note',
    'conversation-title', 'profile-synthesis', 'session-summary', 'fact-routing',
    'fact-brief', 'embedding', 'memory-consolidation-plan', 'memory-consolidation-review'
  ));
