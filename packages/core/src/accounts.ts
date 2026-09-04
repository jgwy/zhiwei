import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { getPool, withTransaction } from "./db";

export const AccountCredentialsSchema = z.object({
  username: z.string().trim().toLowerCase().min(3).max(32).regex(/^[\p{L}\p{N}_-]+$/u),
  password: z.string().min(10).max(128),
});

const SCRYPT = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, SCRYPT, (error, result) => error ? reject(error) : resolve(result));
  });
}

export async function hashAccountPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await derive(password, salt);
  return `scrypt:32768:8:3:${salt.toString("hex")}:${hash.toString("hex")}`;
}

export async function verifyAccountPassword(password: string, encoded: string): Promise<boolean> {
  const match = /^scrypt:32768:8:3:([a-f0-9]{32}):([a-f0-9]{128})$/.exec(encoded);
  if (!match) return false;
  const derived = await derive(password, Buffer.from(match[1]!, "hex"));
  return timingSafeEqual(derived, Buffer.from(match[2]!, "hex"));
}

export class AccountError extends Error {
  constructor(public readonly code: string, public readonly status: number, message: string) { super(message); }
}

export async function resolveAccountUserId(cookieUserId: string): Promise<string> {
  const result = await getPool().query(`SELECT COALESCE(merged_into_id, id) AS id FROM users WHERE id=$1`, [cookieUserId]);
  return result.rows[0]?.id ?? cookieUserId;
}

export async function getAccount(userId: string): Promise<{ username: string } | null> {
  const result = await getPool().query(`SELECT username FROM accounts WHERE user_id=$1`, [userId]);
  return result.rows[0] ?? null;
}

// Count requests before password hashing, using both device and account-name buckets.
// Expired buckets are removed here so arbitrary failed names do not grow forever.
export async function checkAccountAttempts(userId: string, username: string) {
  await getPool().query(`DELETE FROM account_attempt_windows WHERE started_at < now()-interval '15 minutes'`);
  for (const [bucket, maximum] of [[`device:${userId}`, 20], [`name:${username}`, 10]] as const) {
    const result = await getPool().query(`INSERT INTO account_attempt_windows(bucket) VALUES($1)
      ON CONFLICT(bucket) DO UPDATE SET attempts=account_attempt_windows.attempts+1 RETURNING attempts`, [bucket]);
    if (result.rows[0].attempts > maximum)
      throw new AccountError("account_rate_limited", 429, "账号操作过于频繁，请十五分钟后再试。");
  }
}

export async function bindAccount(userId: string, credentials: unknown) {
  const input = AccountCredentialsSchema.parse(credentials);
  await checkAccountAttempts(userId, input.username);
  const passwordHash = await hashAccountPassword(input.password);
  return withTransaction(async (client) => {
    const owner = await client.query(`SELECT merged_into_id FROM users WHERE id=$1 FOR UPDATE`, [userId]);
    if (!owner.rowCount || owner.rows[0].merged_into_id)
      throw new AccountError("account_session_changed", 409, "当前身份已变化，请刷新后再试。");
    if ((await client.query(`SELECT 1 FROM accounts WHERE user_id=$1`, [userId])).rowCount)
      throw new AccountError("account_already_bound", 409, "当前数据已经绑定账号，无需重复绑定。");
    const inserted = await client.query(`INSERT INTO accounts(user_id,username,password_hash) VALUES($1,$2,$3)
      ON CONFLICT(username) DO NOTHING RETURNING username`, [userId, input.username, passwordHash]);
    if (!inserted.rowCount)
      throw new AccountError("account_name_taken", 409, "这个账号名已被使用，请换一个；已有账号请使用恢复账号数据。");
    return inserted.rows[0] as { username: string };
  });
}

export function mergeAccountSettings(account: Record<string, boolean>, guest: Record<string, boolean>) {
  return Object.fromEntries([...new Set([...Object.keys(account), ...Object.keys(guest)])]
    .map((key) => [key, account[key] !== false && guest[key] !== false]));
}

// Every user-owned data table is explicit so a schema change can be checked by integration tests.
export const ACCOUNT_DATA_TABLES = [
  "conversations", "messages", "conversation_summaries", "memories", "memory_versions",
  "memory_evidence", "profile_snapshots", "mood_samples", "personal_skill_versions",
  "feedback", "return_notes", "jobs", "trace_events", "mcp_calls", "activity_events",
  "model_runs", "memory_withdrawals", "risk_events", "benchmark_runs", "benchmark_outputs",
  "benchmark_preferences", "message_sources", "onboarding_question_plans", "memory_events",
  "memory_operations", "memory_version_parents", "onboarding_question_candidates",
] as const;

export async function restoreAccount(guestId: string, credentials: unknown) {
  const input = AccountCredentialsSchema.parse(credentials);
  await checkAccountAttempts(guestId, input.username);
  const found = await getPool().query(`SELECT user_id,password_hash FROM accounts WHERE username=$1`, [input.username]);
  const account = found.rows[0];
  // Same work for unknown names; never disclose whether a recovery account exists.
  const encoded = account?.password_hash ?? `scrypt:32768:8:3:${"0".repeat(32)}:${"0".repeat(128)}`;
  if (!(await verifyAccountPassword(input.password, encoded)) || !account)
    throw new AccountError("account_credentials_invalid", 401, "账号或密码不正确，请检查后重试。");

  return withTransaction(async (client) => {
    const ownerId = account.user_id as string;
    const owners = await client.query(`SELECT * FROM users WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE`, [[guestId, ownerId]]);
    const guest = owners.rows.find((row) => row.id === guestId);
    const owner = owners.rows.find((row) => row.id === ownerId);
    const existingAccount = await client.query(`SELECT username FROM accounts WHERE user_id=$1 AND password_hash=$2`, [ownerId, encoded]);
    if (!guest || !owner || !existingAccount.rowCount)
      throw new AccountError("account_session_changed", 409, "账号状态已变化，请刷新后重试。");
    if (guestId === ownerId || guest.merged_into_id === ownerId)
      return { username: input.username, restored: true, alreadyRestored: true };
    if (guest.merged_into_id || (await client.query(`SELECT 1 FROM accounts WHERE user_id=$1`, [guestId])).rowCount)
      throw new AccountError("account_already_bound", 409, "当前数据已绑定另一个账号，不能将两个账号直接合并。");

    // Freeze queued work. A running model call cannot change ownership halfway through.
    const jobs = await client.query(`SELECT id,status FROM jobs WHERE user_id=ANY($1::uuid[]) FOR UPDATE`, [[guestId, ownerId]]);
    const streaming = await client.query(`SELECT 1 FROM messages WHERE user_id=ANY($1::uuid[])
      AND role='assistant' AND metadata->>'status'='streaming' LIMIT 1`, [[guestId, ownerId]]);
    if (jobs.rows.some((job) => job.status === "running") || streaming.rowCount)
      throw new AccountError("account_data_busy", 409, "知微正在回复或整理数据，请稍等片刻，完成后再恢复。");

    const counts = await client.query(`SELECT
      (SELECT count(*)::int FROM conversations WHERE user_id=$1 AND kind='chat') AS conversations,
      (SELECT count(*)::int FROM messages WHERE user_id=$1) AS messages,
      (SELECT count(*)::int FROM memories WHERE user_id=$1) AS memories`, [ownerId]);
    const settings = mergeAccountSettings(owner.settings, guest.settings);

    // Retain both complete skill timelines. Account preferences stay active; the next rewrite
    // chooses its number from the whole history, including these imported inactive versions.
    const offset = await client.query(`SELECT COALESCE(max(version),0)::int AS value FROM personal_skill_versions WHERE user_id=$1`, [ownerId]);
    await client.query(`UPDATE personal_skill_versions SET user_id=$3,is_active=false,version=version+$2 WHERE user_id=$1`, [guestId, offset.rows[0].value, ownerId]);
    const steps = await client.query(`SELECT COALESCE(max(step),-1)+1 AS value FROM onboarding_question_plans WHERE user_id=$1`, [ownerId]);
    await client.query(`UPDATE onboarding_question_plans SET user_id=$3,step=step+$2 WHERE user_id=$1`, [guestId, steps.rows[0].value, ownerId]);
    // Onboarding is already complete after recovery; keep planning history, do not run it again.
    await client.query(`UPDATE jobs SET status='completed',completed_at=now() WHERE user_id=ANY($1::uuid[])
      AND type='onboarding_plan' AND status='pending'`, [[guestId, ownerId]]);
    for (const table of ["jobs", "memory_operations"] as const) {
      await client.query(`UPDATE ${table} incoming SET idempotency_key='recovered:' || $1::text || ':' || incoming.idempotency_key
        WHERE incoming.user_id=$1::uuid AND EXISTS(SELECT 1 FROM ${table} prior
        WHERE prior.user_id=$2::uuid AND prior.idempotency_key=incoming.idempotency_key)`, [guestId, ownerId]);
    }
    for (const table of ACCOUNT_DATA_TABLES)
      await client.query(`UPDATE ${table} SET user_id=$2 WHERE user_id=$1`, [guestId, ownerId]);

    await client.query(`UPDATE profile_snapshots SET sync_status='stale' WHERE user_id=$1 AND sync_status='current'`, [ownerId]);
    await client.query(`UPDATE users SET settings=$2::jsonb,onboarding_complete=true,updated_at=now() WHERE id=$1`, [ownerId, JSON.stringify(settings)]);
    await client.query(`UPDATE users SET merged_into_id=$2,updated_at=now() WHERE id=$1`, [guestId, ownerId]);
    await client.query(`INSERT INTO jobs(id,user_id,type,payload,idempotency_key)
      SELECT gen_random_uuid(),$1,'profile_synthesis','{"trigger":"account-restored"}'::jsonb,$2
      WHERE EXISTS(SELECT 1 FROM memory_versions WHERE user_id=$1 AND tier='long' AND is_active)
      ON CONFLICT DO NOTHING`, [ownerId, `account-restored:${guestId}`]);
    await client.query(`INSERT INTO activity_events(id,user_id,type,payload) VALUES(gen_random_uuid(),$1,'account.restored',$2::jsonb)`,
      [ownerId, JSON.stringify({ ...counts.rows[0], message: "账号数据已恢复，游客聊天也已保留。" })]);
    return { username: input.username, restored: true, alreadyRestored: false, imported: counts.rows[0] };
  });
}
