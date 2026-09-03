import { getPool } from "./db";

export const REFLECTION_JOB_ORDER = `(job.type <> 'reflection' OR NOT EXISTS (
  SELECT 1 FROM jobs earlier WHERE earlier.user_id=job.user_id AND earlier.type='reflection'
    AND earlier.status IN ('pending','running') AND (earlier.created_at,earlier.id)<(job.created_at,job.id)
    AND (earlier.status='running' OR earlier.payload->>'sealed' IS DISTINCT FROM 'false' OR earlier.run_after<=now())
))`;

export async function recoverRunningJobs() {
  // The deployment has exactly one Worker process. On startup its previous
  // in-flight jobs have no owner; memory commits already carry idempotency keys.
  const result = await getPool()
    .query(`UPDATE jobs SET status='pending',run_after=now(),started_at=NULL
    WHERE status='running' RETURNING id`);
  return result.rowCount ?? 0;
}

export async function recoverReplyAttempts() {
  const result=await getPool().query(`UPDATE messages SET metadata=metadata || '{"status":"interrupted","streaming":false}'::jsonb
    WHERE role='assistant' AND metadata->>'status'='streaming' RETURNING id`);
  return result.rowCount ?? 0;
}

export async function nextJobDelay(lane: "planning" | "memory") {
  const result = await getPool().query(
    `SELECT min(run_after) AS next_at FROM jobs job WHERE status='pending'
    AND (CASE WHEN type IN ('onboarding_plan','conversation_title') THEN 'planning' ELSE 'memory' END)=$1
    AND ${REFLECTION_JOB_ORDER}`,
    [lane],
  );
  const next = result.rows[0]?.next_at;
  return next
    ? Math.max(0, Math.min(60_000, new Date(next).getTime() - Date.now()))
    : 60_000;
}

export async function requeueInterruptedJob(id: string) {
  await getPool().query(
    `UPDATE jobs SET status='pending',run_after=now(),started_at=NULL,
    attempts=GREATEST(0,attempts-1) WHERE id=$1 AND status='running'`,
    [id],
  );
}
