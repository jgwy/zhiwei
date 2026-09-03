import { getPool } from "./db";

export async function recoverRunningJobs() {
  // The deployment has exactly one Worker process. On startup its previous
  // in-flight jobs have no owner; memory commits already carry idempotency keys.
  const result = await getPool()
    .query(`UPDATE jobs SET status='pending',run_after=now(),started_at=NULL
    WHERE status='running' RETURNING id`);
  return result.rowCount ?? 0;
}

export async function nextJobDelay(lane: "planning" | "memory") {
  const result = await getPool().query(
    `SELECT min(run_after) AS next_at FROM jobs WHERE status='pending'
    AND (CASE WHEN type IN ('onboarding_plan','conversation_title') THEN 'planning' ELSE 'memory' END)=$1`,
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
