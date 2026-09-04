import { createHash, randomUUID } from "node:crypto";
import { diffJson } from "diff";
import type { PoolClient } from "pg";
import { getPool, withTransaction } from "./db";
import { REFLECTION_JOB_ORDER } from "./job-lifecycle";
import { defaultPersonalSkill } from "./personal-skill";
import {
  containsForbiddenMemorySecret,
  extractSearchTerms,
  memoryContentHash,
  normalizeMemoryContent,
  normalizeMemoryValidity,
  rankMemoryRecords,
  selectMemoryQuota,
  validateReflectionBatch,
} from "./memory-policy";
import {
  calculateUnderstandingScore,
  deriveUnderstandingComponents,
  UNDERSTANDING_ALGORITHM_VERSION,
} from "./score";
import type {
  ChatMessage,
  MemoryConsolidationInput,
  MemoryEmbeddingInput,
  MemoryEventActor,
  MemoryEventType,
  MemoryListInput,
  MemoryMutation,
  MemoryOperationReceipt,
  MemoryRecord,
  MemoryReflectionCommit,
  MemoryRestoreInput,
  MemoryUsageInput,
  MemoryWithdrawInput,
  ModelAttemptMeta,
  ModelCallMeta,
  ModelSource,
  ModelTask,
  PersonalSkill,
  BenchmarkMode,
  BenchmarkOutput,
  ProfileSnapshot,
  RiskAssessment,
  ScoreChangeReason,
} from "./types";

const UNDERSTANDING_OBSERVATIONS_SQL = `
  SELECT
    count(DISTINCT msg.conversation_id)::int AS sessions,
    COALESCE(
      extract(epoch FROM (max(msg.created_at) - min(msg.created_at))) / 86400,
      0
    )::double precision AS span_days
  FROM memory_evidence me
  JOIN memory_versions mv
    ON mv.id = me.memory_version_id
   AND mv.user_id = me.user_id
  JOIN messages msg
    ON msg.id = me.message_id
   AND msg.user_id = me.user_id
  WHERE me.user_id = $1
    AND mv.is_active = true
    AND mv.tier = 'long'
    AND (mv.valid_until IS NULL OR mv.valid_until > now())`;

export async function ensureUser(userId: string): Promise<void> {
  await withTransaction(async (client) => {
    const inserted = await client.query(
      `INSERT INTO users (id) VALUES ($1) ON CONFLICT (id) DO NOTHING RETURNING id`,
      [userId],
    );
    if (inserted.rowCount) {
      await client.query(
        `INSERT INTO personal_skill_versions
          (id, user_id, version, content, trigger_reason, expected_effect, source, is_active)
         VALUES ($1, $2, 1, $3::jsonb, $4, $5, 'initial', true)`,
        [
          randomUUID(),
          userId,
          JSON.stringify(defaultPersonalSkill),
          defaultPersonalSkill.evolution.reason,
          defaultPersonalSkill.evolution.expectedEffect,
        ],
      );
    }
  });
}

export async function assertUserExists(userId: string): Promise<void> {
  const result = await getPool().query(`SELECT 1 FROM users WHERE id = $1`, [
    userId,
  ]);
  if (!result.rowCount) throw new Error("user_not_found");
}

export async function getUserState(userId: string) {
  const [user, conversations, mood] = await Promise.all([
    getPool().query(`SELECT * FROM users WHERE id = $1`, [userId]),
    listConversations(userId),
    getMoodSeries(userId),
  ]);
  return {
    user: user.rows[0],
    conversations,
    mood,
  };
}

export async function listConversations(userId: string) {
  const result = await getPool().query(
    `SELECT c.*, (SELECT count(*)::int FROM messages m WHERE m.conversation_id=c.id AND m.is_current_reply) AS message_count
     FROM conversations c
     WHERE c.user_id = $1 AND c.kind = 'chat'
     ORDER BY c.updated_at DESC`,
    [userId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    title: row.title,
    titleSource: row.title_source ?? "default",
    titleLocked: row.title_locked ?? false,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    messageCount: row.message_count,
  }));
}

export async function createConversation(
  userId: string,
  kind: "chat" | "onboarding" = "chat",
  title = "新的对话",
) {
  const existing =
    kind === "onboarding"
      ? await getPool().query(
          `SELECT * FROM conversations WHERE user_id = $1 AND kind = 'onboarding' LIMIT 1`,
          [userId],
        )
      : null;
  if (existing?.rowCount) return existing.rows[0];
  const result = await getPool().query(
    `INSERT INTO conversations (id, user_id, kind, title)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [randomUUID(), userId, kind, title],
  );
  return result.rows[0];
}

export async function updateConversationTitle(
  userId: string,
  conversationId: string,
  title: string,
  source: "model" | "manual" = "model",
): Promise<void> {
  await getPool().query(
    `UPDATE conversations
     SET title = $3, title_source = $4,
         title_locked = CASE WHEN $4 = 'manual' THEN true ELSE title_locked END,
         updated_at = now()
     WHERE id = $1 AND user_id = $2
       AND ($4 = 'manual' OR title_locked = false)`,
    [conversationId, userId, title.slice(0, 36), source],
  );
}

export async function addMessage(input: {
  conversationId: string;
  userId: string;
  role: "user" | "assistant" | "system";
  content: string;
  metadata?: Record<string, unknown>;
  id?: string;
}): Promise<ChatMessage> {
  const id = input.id ?? randomUUID();
  const result = await getPool().query(
    `INSERT INTO messages (id, conversation_id, user_id, role, content, metadata)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb) RETURNING *`,
    [
      id,
      input.conversationId,
      input.userId,
      input.role,
      input.content,
      JSON.stringify(input.metadata ?? {}),
    ],
  );
  await getPool().query(
    `UPDATE conversations SET updated_at = now() WHERE id = $1 AND user_id = $2`,
    [input.conversationId, input.userId],
  );
  return mapMessage(result.rows[0]);
}

export async function attachMemoryReceipt(input: {
  userId: string;
  conversationId: string;
  sourceMessageId: string;
  receipt: string;
}): Promise<string | null> {
  const result = await getPool().query(
    `WITH source AS (
       SELECT created_at, metadata->>'traceId' AS trace_id
       FROM messages
       WHERE id = $1 AND user_id = $2 AND conversation_id = $3 AND role = 'user'
     ), target AS (
       SELECT assistant.id
       FROM messages assistant, source
       WHERE assistant.user_id = $2 AND assistant.conversation_id = $3
         AND assistant.role = 'assistant' AND assistant.is_current_reply AND assistant.created_at >= source.created_at
         AND (assistant.reply_to_message_id=$1 OR assistant.reply_to_message_id IS NULL)
       ORDER BY CASE WHEN assistant.reply_to_message_id=$1 THEN 0 ELSE 1 END,
                CASE WHEN source.trace_id IS NOT NULL
                          AND assistant.metadata->>'traceId' = source.trace_id THEN 0 ELSE 1 END,
                assistant.created_at
       LIMIT 1
     )
     UPDATE messages
     SET metadata = jsonb_set(metadata, '{memoryReceipt}', to_jsonb($4::text), true)
     WHERE id = (SELECT id FROM target) AND user_id = $2
     RETURNING id`,
    [input.sourceMessageId, input.userId, input.conversationId, input.receipt],
  );
  return result.rows[0]?.id ?? null;
}

export async function listMessages(
  userId: string,
  conversationId: string,
  limit = 80,
): Promise<ChatMessage[]> {
  const result = await getPool().query(
    `SELECT id, role, content, created_at, metadata FROM messages
     WHERE user_id = $1 AND conversation_id = $2 AND is_current_reply AND content <> ''
     ORDER BY created_at DESC, id DESC LIMIT $3`,
    [userId, conversationId, limit],
  );
  return result.rows.reverse().map(mapMessage);
}

export async function getOnboardingAnswers(userId: string) {
  const result = await getPool().query(
    `SELECT id, content, metadata, created_at FROM messages
     WHERE user_id = $1 AND role = 'user' AND metadata->>'kind' = 'onboarding-answer'
     ORDER BY created_at`,
    [userId],
  );
  return result.rows;
}

export async function getOnboardingQuestionPlan(userId: string, step: number) {
  const result = await getPool().query(
    `SELECT question FROM onboarding_question_plans WHERE user_id = $1 AND step = $2`,
    [userId, step],
  );
  return result.rows[0]?.question ?? null;
}

export async function saveOnboardingQuestionPlan(input: {
  userId: string;
  step: number;
  question: unknown;
  modelName: string;
}) {
  const result = await getPool().query(
    `INSERT INTO onboarding_question_plans (id, user_id, step, question, model_name)
     VALUES ($1, $2, $3, $4::jsonb, $5)
     ON CONFLICT (user_id, step) DO UPDATE SET question = EXCLUDED.question
     RETURNING question`,
    [
      randomUUID(),
      input.userId,
      input.step,
      JSON.stringify(input.question),
      input.modelName,
    ],
  );
  return result.rows[0].question;
}

export async function setOnboardingComplete(
  userId: string,
  complete: boolean,
): Promise<void> {
  await getPool().query(
    `UPDATE users SET onboarding_complete = $2, updated_at = now() WHERE id = $1`,
    [userId, complete],
  );
}

export async function isOnboardingComplete(userId: string): Promise<boolean> {
  const result = await getPool().query(
    `SELECT onboarding_complete FROM users WHERE id = $1`,
    [userId],
  );
  if (!result.rowCount) throw new Error("user_not_found");
  return result.rows[0].onboarding_complete === true;
}

export async function updateSettings(
  userId: string,
  settings: Record<string, boolean>,
): Promise<void> {
  await getPool().query(
    `UPDATE users SET settings = settings || $2::jsonb, updated_at = now() WHERE id = $1`,
    [userId, JSON.stringify(settings)],
  );
}

export async function getUserSettings(userId: string) {
  const result = await getPool().query(
    `SELECT settings FROM users WHERE id = $1`,
    [userId],
  );
  if (!result.rowCount) throw new Error("user_not_found");
  return result.rows[0].settings ?? {};
}

export async function enqueueJob(input: {
  userId: string;
  type:
    | "reflection"
    | "profile_synthesis"
    | "session_summary"
    | "return_note"
    | "evolve_skill"
    | "conversation_title"
    | "memory_embedding"
    | "memory_consolidation"
    | "onboarding_plan";
  payload: Record<string, unknown>;
  idempotencyKey?: string;
}): Promise<string> {
  const id = randomUUID();
  const result = await getPool().query(
    `INSERT INTO jobs (id, user_id, type, payload, idempotency_key)
     VALUES ($1, $2, $3, $4::jsonb, $5)
     ON CONFLICT (user_id, idempotency_key) WHERE idempotency_key IS NOT NULL
     DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
     RETURNING id`,
    [
      id,
      input.userId,
      input.type,
      JSON.stringify(input.payload),
      input.idempotencyKey ?? null,
    ],
  );
  return result.rows[0].id;
}

export async function claimJob(
  lane?: "planning" | "memory",
): Promise<any | null> {
  return withTransaction(async (client) => {
    const result = await client.query(
      `SELECT * FROM jobs job
       WHERE status = 'pending' AND run_after <= now()
         AND ($1::text IS NULL OR (CASE WHEN type IN ('onboarding_plan','conversation_title') THEN 'planning' ELSE 'memory' END) = $1)
         AND ${REFLECTION_JOB_ORDER}
       ORDER BY created_at
       FOR UPDATE SKIP LOCKED LIMIT 1`,
      [lane ?? null],
    );
    if (!result.rowCount) return null;
    const job = result.rows[0];
    await client.query(
      `UPDATE jobs SET status = 'running', attempts = attempts + 1, started_at = now(),
        payload = CASE WHEN type='reflection' THEN jsonb_set(payload,'{sealed}','true') ELSE payload END
       WHERE id = $1`,
      [job.id],
    );
    return { ...job, attempts: Number(job.attempts) + 1 };
  });
}

export async function completeJob(jobId: string): Promise<void> {
  await getPool().query(
    `UPDATE jobs SET status = 'completed', completed_at = now() WHERE id = $1`,
    [jobId],
  );
}

export async function failJob(job: any, error: unknown): Promise<void> {
  const terminal = Number(job.attempts ?? 0) >= 3;
  const seconds = Math.min(60, 2 ** Math.max(1, Number(job.attempts ?? 1)));
  await getPool().query(
    `UPDATE jobs SET status = $2, last_error = $3,
       run_after = CASE WHEN $2 = 'pending' THEN now() + make_interval(secs => $4) ELSE run_after END
     WHERE id = $1`,
    [
      job.id,
      terminal ? "failed" : "pending",
      error instanceof Error ? error.message : String(error),
      seconds,
    ],
  );
}

const MEMORY_SELECT_COLUMNS = `m.id, mv.id AS version_id, mv.category, mv.content, mv.tier,
  mv.confidence, mv.valid_until, mv.reason, mv.status, mv.last_used_at, mv.created_at,
  ARRAY(SELECT me.message_id FROM memory_evidence me
        WHERE me.memory_version_id = mv.id ORDER BY me.message_id) AS evidence_message_ids,
  ARRAY(SELECT mvp.parent_version_id FROM memory_version_parents mvp
        WHERE mvp.child_version_id = mv.id ORDER BY mvp.parent_version_id) AS parent_version_ids`;

export async function expireStaleMemories(userId: string): Promise<number> {
  return withTransaction((client) =>
    expireStaleMemoriesWithClient(client, userId),
  );
}

async function expireStaleMemoriesWithClient(
  client: PoolClient,
  userId: string,
): Promise<number> {
  const expired = await client.query(
    `UPDATE memory_versions
     SET status = 'expired', is_active = false
     WHERE user_id = $1 AND status = 'active' AND is_active = true
       AND valid_until IS NOT NULL AND valid_until <= now()
     RETURNING id, memory_id, content`,
    [userId],
  );
  for (const row of expired.rows) {
    await recordMemoryEvent(client, {
      userId,
      memoryId: row.memory_id,
      versionId: row.id,
      eventType: "expired",
      actor: "system",
      content: row.content,
    });
  }
  return expired.rowCount ?? 0;
}

export async function listMemoriesForUser(
  userId: string,
  options: Partial<MemoryListInput> = {},
): Promise<MemoryRecord[]> {
  await expireStaleMemories(userId);
  const statuses = options.statuses ?? ["active"];
  const tiers = options.tiers ?? null;
  const limit = Math.max(1, Math.min(1_000, options.limit ?? 100));
  const result = await getPool().query(
    `SELECT ${MEMORY_SELECT_COLUMNS}
     FROM memories m
     JOIN memory_versions mv ON mv.memory_id = m.id
     WHERE m.user_id = $1 AND mv.user_id = $1
       AND mv.status = ANY($2::text[])
       AND ($3::text[] IS NULL OR mv.tier = ANY($3::text[]))
     ORDER BY mv.created_at DESC, mv.id DESC LIMIT $4`,
    [userId, statuses, tiers, limit],
  );
  return result.rows.map(mapMemoryRow);
}

export async function getActiveMemories(
  userId: string,
): Promise<MemoryRecord[]> {
  await expireStaleMemories(userId);
  const result = await getPool().query(
    `SELECT ${MEMORY_SELECT_COLUMNS}
     FROM memories m
     JOIN memory_versions mv ON mv.memory_id = m.id
     JOIN users u ON u.id = m.user_id
     WHERE m.user_id = $1 AND mv.user_id = $1
       AND COALESCE((u.settings->>'memoryEnabled')::boolean, true) = true
       AND mv.status = 'active' AND mv.is_active = true
       AND (mv.valid_until IS NULL OR mv.valid_until > now())
       AND (
         (mv.tier = 'long' AND COALESCE((u.settings->>'longTermMemoryEnabled')::boolean, true) = true)
         OR
         (mv.tier = 'short' AND COALESCE((u.settings->>'shortTermMemoryEnabled')::boolean, true) = true)
       )
       AND (mv.category <> 'emotion' OR COALESCE((u.settings->>'emotionTrackingEnabled')::boolean, true) = true)
     ORDER BY mv.created_at DESC, mv.id DESC LIMIT 200`,
    [userId],
  );
  return result.rows.map(mapMemoryRow);
}

export async function searchMemories(
  userId: string,
  query: string,
  limit = 8,
  queryEmbedding?: number[],
  purpose: "dialogue" | "reflection" = "dialogue",
): Promise<MemoryRecord[]> {
  await expireStaleMemories(userId);
  const vector =
    queryEmbedding?.length === 1024 ? `[${queryEmbedding.join(",")}]` : null;
  const terms = extractSearchTerms(query).slice(0, 64);
  const results = await Promise.all(
    (["long", "short"] as const).map((tier) => {
      const eligible = `FROM memory_versions mv JOIN users u ON u.id=mv.user_id
      WHERE mv.user_id=$1 AND mv.tier=$2 AND mv.status='active' AND mv.is_active
      AND (mv.valid_until IS NULL OR mv.valid_until>now())
      AND COALESCE((u.settings->>'memoryEnabled')::boolean,true)
      AND COALESCE((u.settings->>CASE WHEN mv.tier='long' THEN 'longTermMemoryEnabled' ELSE 'shortTermMemoryEnabled' END)::boolean,true)
      AND (mv.category<>'emotion' OR COALESCE((u.settings->>'emotionTrackingEnabled')::boolean,true))`;
      return getPool().query(
        `WITH candidate_ids AS (
      (SELECT mv.id ${eligible} ORDER BY (SELECT count(*) FROM unnest($4::text[]) term WHERE strpos(mv.content,term)>0) DESC,mv.created_at DESC LIMIT 32)
      UNION
      (SELECT mv.id ${eligible} AND mv.embedding_v2 IS NOT NULL AND $3::vector IS NOT NULL ORDER BY mv.embedding_v2 <=> $3::vector LIMIT 32)
    ) SELECT ${MEMORY_SELECT_COLUMNS},
      CASE WHEN $3::vector IS NOT NULL AND mv.embedding_v2 IS NOT NULL THEN 1-(mv.embedding_v2 <=> $3::vector) END AS similarity
      FROM memories m JOIN memory_versions mv ON mv.memory_id=m.id
      WHERE m.user_id=$1 AND mv.id IN(SELECT id FROM candidate_ids)`,
        [userId, tier, vector, terms],
      );
    }),
  );
  const rows = results.flatMap((result) => result.rows);
  const memories = rows.map(mapMemoryRow);
  const scores = new Map<string, number>(
    rows
      .filter((row) => row.similarity != null)
      .map((row) => [row.version_id, Number(row.similarity)]),
  );
  const ranked = rankMemoryRecords(memories, query, scores);
  return purpose === "reflection"
    ? ranked.slice(0, Math.min(12, limit)).map((item) => item.memory)
    : selectMemoryQuota(ranked, limit);
}

export function rankMemories(
  memories: MemoryRecord[],
  query: string,
  limit = 8,
): MemoryRecord[] {
  return selectMemoryQuota(rankMemoryRecords(memories, query), limit);
}

const MUTATION_EVENTS = [
  "created",
  "updated",
  "promoted",
  "withdrawn",
  "expired",
  "restored",
  "consolidated",
  "superseded",
];
async function memoryMutationCursor(
  client: Pick<PoolClient, "query">,
  userId: string,
) {
  const result = await client.query(
    `SELECT count(*)::int AS cursor FROM memory_events WHERE user_id=$1 AND event_type=ANY($2::text[])`,
    [userId, MUTATION_EVENTS],
  );
  return Number(result.rows[0]?.cursor ?? 0);
}

export async function getReflectionControlState(
  userId: string,
  query: string,
  afterEvidenceAt?: string,
) {
  const cursor = await memoryMutationCursor(getPool(), userId);
  if (!afterEvidenceAt) return { mutationCursor: cursor, withdrawals: [] };
  const result = await getPool().query(
    `SELECT w.memory_id AS "memoryId",w.version_id AS "versionId",mv.content,
      COALESCE(msg.created_at,w.created_at) AS "withdrawnAt"
    FROM memory_withdrawals w JOIN memory_versions mv ON mv.id=w.version_id JOIN users u ON u.id=w.user_id
    LEFT JOIN messages msg ON msg.id=w.source_message_id
    WHERE w.user_id=$1 AND COALESCE(msg.created_at,w.created_at)>=$2::timestamptz
      AND COALESCE((u.settings->>'memoryEnabled')::boolean,true)
      AND COALESCE((u.settings->>CASE WHEN mv.tier='long' THEN 'longTermMemoryEnabled' ELSE 'shortTermMemoryEnabled' END)::boolean,true)
      AND (mv.category<>'emotion' OR COALESCE((u.settings->>'emotionTrackingEnabled')::boolean,true))
    ORDER BY (SELECT count(*) FROM unnest($3::text[]) term WHERE strpos(mv.content,term)>0) DESC,w.created_at DESC LIMIT 12`,
    [userId, afterEvidenceAt, extractSearchTerms(query).slice(0, 64)],
  );
  return { mutationCursor: cursor, withdrawals: result.rows };
}

export async function getLatestProfile(
  userId: string,
): Promise<ProfileSnapshot | null> {
  const result = await getPool().query(
    `SELECT * FROM profile_snapshots WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`,
    [userId],
  );
  if (!result.rowCount) return null;
  const profile = mapProfileRow(result.rows[0]);
  if (profile.understanding.algorithmVersion === UNDERSTANDING_ALGORITHM_VERSION) {
    return profile;
  }

  const [settingsResult, memoriesResult, feedback, observations] = await Promise.all([
    getPool().query(`SELECT settings FROM users WHERE id = $1`, [userId]),
    getPool().query(
      `SELECT ${MEMORY_SELECT_COLUMNS}
       FROM memories m JOIN memory_versions mv ON mv.memory_id = m.id
       WHERE m.user_id = $1 AND mv.user_id = $1
         AND mv.status = 'active' AND mv.is_active = true AND mv.tier = 'long'
         AND (mv.valid_until IS NULL OR mv.valid_until > now())`,
      [userId],
    ),
    getPool().query(
      `SELECT count(DISTINCT message_id) FILTER (WHERE value = 'understood')::int AS positive,
              count(DISTINCT message_id) FILTER (WHERE value = 'not-me')::int AS negative
       FROM feedback WHERE user_id = $1`,
      [userId],
    ),
    getPool().query(UNDERSTANDING_OBSERVATIONS_SQL, [userId]),
  ]);
  const settings = settingsResult.rows[0]?.settings ?? {};
  const memories = memoriesResult.rows
    .map(mapMemoryRow)
    .filter((memory) => memory.category !== "emotion" || settings.emotionTrackingEnabled !== false);
  const weights = { ...profile.dimensionWeights };
  if (settings.emotionTrackingEnabled === false) delete weights.emotion;
  const understanding = deriveUnderstandingComponents({
    memories,
    dimensionWeights: weights,
    positiveFeedback: feedback.rows[0]?.positive ?? 0,
    negativeFeedback: feedback.rows[0]?.negative ?? 0,
    correctedMemories: 0,
    observationSessions: observations.rows[0]?.sessions ?? 0,
    observationSpanDays: observations.rows[0]?.span_days ?? 0,
  });
  const score = calculateUnderstandingScore(understanding);
  await getPool().query(
    `UPDATE profile_snapshots
     SET understanding_components = $2::jsonb, understanding_score = $3
     WHERE id = $1`,
    [profile.id, JSON.stringify(understanding), score],
  );
  return { ...profile, understanding, score };
}

export async function getProfileForContext(
  userId: string,
): Promise<ProfileSnapshot | null> {
  const [settingsResult, profile] = await Promise.all([
    getPool().query(`SELECT settings FROM users WHERE id = $1`, [userId]),
    getLatestProfile(userId),
  ]);
  const settings = settingsResult.rows[0]?.settings ?? {};
  if (
    settings.memoryEnabled === false ||
    settings.longTermMemoryEnabled === false
  )
    return null;
  if (!profile || profile.syncStatus !== "current") return null;

  const sources = await getSummarySourceVersionIds(userId);
  return sameIds(profile.sourceMemoryVersionIds, sources) ? profile : null;
}

export async function commitProfileSnapshot(input: {
  userId: string;
  summary: string;
  dimensionWeights: Record<string, number>;
  sourceMemoryVersionIds: string[];
  schemaVersion: string;
  idempotencyKey: string;
}): Promise<ProfileSnapshot & { receipt: MemoryOperationReceipt }> {
  if (
    new Set(input.sourceMemoryVersionIds).size !==
    input.sourceMemoryVersionIds.length
  ) {
    throw new Error("memory_profile_source_duplicate");
  }
  return withTransaction(async (client) =>
    runMemoryOperation(
      client,
      {
        userId: input.userId,
        idempotencyKey: input.idempotencyKey,
        operation: "commit_profile",
        request: {
          sourceMemoryVersionIds: [...input.sourceMemoryVersionIds].sort(),
          schemaVersion: input.schemaVersion,
        },
      },
      async () => {
        await expireStaleMemoriesWithClient(client, input.userId);
        const settingsResult = await client.query(
          `SELECT settings FROM users WHERE id = $1 FOR UPDATE`,
          [input.userId],
        );
        const settings = settingsResult.rows[0]?.settings ?? {};
        if (
          settings.memoryEnabled === false ||
          settings.longTermMemoryEnabled === false
        ) {
          throw new Error("memory_profile_paused");
        }

        const summarySources = await getSummarySourceVersionIds(
          input.userId,
          client,
        );
        if (!sameIds(summarySources, input.sourceMemoryVersionIds))
          throw new Error("memory_profile_source_conflict");

        const scoreMemoriesResult = await client.query(
          `SELECT ${MEMORY_SELECT_COLUMNS}
       FROM memories m JOIN memory_versions mv ON mv.memory_id = m.id
       WHERE m.user_id = $1 AND mv.user_id = $1
         AND mv.status = 'active' AND mv.is_active = true AND mv.tier = 'long'
         AND (mv.category <> 'emotion' OR $2::boolean = true)`,
          [input.userId, settings.emotionTrackingEnabled !== false],
        );
        const memories = scoreMemoriesResult.rows.map(mapMemoryRow);
        const weights = { ...input.dimensionWeights };
        if (settings.emotionTrackingEnabled === false) delete weights.emotion;
        const feedback = await client.query(
          `SELECT count(DISTINCT message_id) FILTER (WHERE value = 'understood')::int AS positive,
                count(DISTINCT message_id) FILTER (WHERE value = 'not-me')::int AS negative
         FROM feedback WHERE user_id = $1`,
          [input.userId],
        );
        const observations = await client.query(
          UNDERSTANDING_OBSERVATIONS_SQL,
          [input.userId],
        );
        const previousResult = await client.query(
          `SELECT * FROM profile_snapshots WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`,
          [input.userId],
        );
        const components = deriveUnderstandingComponents({
          memories,
          dimensionWeights: weights,
          positiveFeedback: feedback.rows[0]?.positive ?? 0,
          negativeFeedback: feedback.rows[0]?.negative ?? 0,
          correctedMemories: 0,
          observationSessions: observations.rows[0]?.sessions ?? 0,
          observationSpanDays: observations.rows[0]?.span_days ?? 0,
        });
        const score = calculateUnderstandingScore(components);
        const previous = previousResult.rowCount
          ? mapProfileRow(previousResult.rows[0])
          : null;
        const scoreChangeReasons = explainScoreChange(
          previous,
          components,
          score,
        );
        const result = await client.query(
          `INSERT INTO profile_snapshots
        (id, user_id, summary, dimension_weights, understanding_components, understanding_score,
         schema_version, source_memory_version_ids, score_change_reasons, sync_status)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8::uuid[], $9::jsonb, 'current')
       RETURNING *`,
          [
            randomUUID(),
            input.userId,
            input.summary,
            JSON.stringify(weights),
            JSON.stringify(components),
            score,
            input.schemaVersion,
            [...input.sourceMemoryVersionIds].sort(),
            JSON.stringify(scoreChangeReasons),
          ],
        );
        return mapProfileRow(result.rows[0]);
      },
    ),
  );
}

export async function getConversationSummary(
  userId: string,
  conversationId: string,
): Promise<string | null> {
  const result = await getPool().query(
    `SELECT cs.summary FROM conversation_summaries cs
     WHERE cs.user_id = $1 AND cs.conversation_id = $2
     ORDER BY cs.created_at DESC LIMIT 1`,
    [userId, conversationId],
  );
  return result.rows[0]?.summary ?? null;
}

export async function getMoodSeries(userId: string) {
  const result = await getPool().query(
    `SELECT date_trunc('day', observed_at) AS day,
            round(avg(score)::numeric, 1) AS score,
            (array_agg(summary ORDER BY observed_at DESC))[1] AS summary
     FROM mood_samples WHERE user_id = $1
     GROUP BY date_trunc('day', observed_at)
     ORDER BY day DESC LIMIT 30`,
    [userId],
  );
  return result.rows.reverse().map((row) => ({
    day: row.day,
    score: Number(row.score),
    summary: row.summary,
  }));
}

export async function getActiveSkill(userId: string) {
  const result = await getPool().query(
    `SELECT * FROM personal_skill_versions
     WHERE user_id = $1 AND is_active = true LIMIT 1`,
    [userId],
  );
  return result.rows[0]
    ? {
        id: result.rows[0].id,
        version: result.rows[0].version,
        content: result.rows[0].content as PersonalSkill,
        triggerReason: result.rows[0].trigger_reason,
        expectedEffect: result.rows[0].expected_effect,
        createdAt: result.rows[0].created_at,
      }
    : null;
}

export async function commitReflection(input: {
  userId: string;
  conversationId: string;
  sourceMessageId: string;
  sourceMessageIds?: string[];
  summaryEvidenceMessageIds?: string[];
  expectedMutationCursor?: number;
  reflection: MemoryReflectionCommit;
  embeddings?: Array<number[] | null>;
  idempotencyKey: string;
  traceId?: string;
}): Promise<{
  memoryCount: number;
  mutations: Array<{
    operation: MemoryMutation["operation"];
    memoryId: string;
    versionId: string;
    tier: "short" | "long";
    content: string;
    embeddingMissing: boolean;
    status: "active" | "withdrawn";
  }>;
  longTermChanged: boolean;
  receipt: MemoryOperationReceipt;
}> {
  validateReflectionBatch(input.reflection.memories);
  return withTransaction(async (client) =>
    runMemoryOperation(
      client,
      {
        userId: input.userId,
        idempotencyKey: input.idempotencyKey,
        operation: "commit_reflection",
        request: {
          conversationId: input.conversationId,
          sourceMessageId: input.sourceMessageId,
          sourceMessageIds: input.sourceMessageIds,
        },
      },
      async () => {
        await expireStaleMemoriesWithClient(client, input.userId);
        const settingsResult = await client.query(
          `SELECT settings FROM users WHERE id = $1 FOR UPDATE`,
          [input.userId],
        );
        const sourceIds = input.sourceMessageIds ?? [input.sourceMessageId];
        if (
          input.expectedMutationCursor !== undefined &&
          input.expectedMutationCursor !==
            (await memoryMutationCursor(client, input.userId))
        )
          throw new Error("memory_version_conflict");
        if (sourceIds.length > 3 || !sourceIds.includes(input.sourceMessageId))
          throw new Error("memory_evidence_scope_invalid");
        const sourceResult = await client.query(
          `SELECT msg.id, msg.content, msg.created_at
       FROM messages msg
       JOIN conversations c ON c.id = msg.conversation_id AND c.user_id = msg.user_id
       WHERE msg.id = ANY($1::uuid[]) AND msg.user_id = $2 AND msg.conversation_id = $3 AND msg.role='user'`,
          [sourceIds, input.userId, input.conversationId],
        );
        if (sourceResult.rowCount !== new Set(sourceIds).size)
          throw new Error("memory_evidence_scope_invalid");
        const sourceTimes = new Map<string, Date>(
          sourceResult.rows.map((row) => [row.id, new Date(row.created_at)]),
        );
        const settings = settingsResult.rows[0]?.settings ?? {};

        const evidenceIds = [
          ...new Set([
            ...input.reflection.memories.flatMap(
              (action) => action.evidenceMessageIds,
            ),
            ...(input.reflection.mood?.evidenceMessageIds ?? []),
          ]),
        ];
        if (evidenceIds.length) {
          const evidenceResult = await client.query(
            `SELECT id FROM messages WHERE id = ANY($1::uuid[]) AND user_id = $2 AND conversation_id = $3 AND role='user'`,
            [evidenceIds, input.userId, input.conversationId],
          );
          if (evidenceResult.rowCount !== evidenceIds.length)
            throw new Error("memory_evidence_scope_invalid");
          if (
            input.reflection.memories.some(
              (action) =>
                !sourceIds.includes(
                  action.triggerMessageId ?? input.sourceMessageId,
                ) ||
                !action.evidenceMessageIds.includes(
                  action.triggerMessageId ?? input.sourceMessageId,
                ),
            )
          ) {
            throw new Error("memory_evidence_scope_invalid");
          }
        }

        await assertNoWithdrawAndRecreate(
          client,
          input.userId,
          input.reflection.memories,
        );
        const mutations: Array<{
          operation: MemoryMutation["operation"];
          memoryId: string;
          versionId: string;
          tier: "short" | "long";
          content: string;
          embeddingMissing: boolean;
          status: "active" | "withdrawn";
        }> = [];
        let longTermChanged = false;

        for (const [index, action] of input.reflection.memories.entries()) {
          const triggerMessageId =
            action.triggerMessageId ?? input.sourceMessageId;
          const sourceCreatedAt = sourceTimes.get(triggerMessageId)!;
          if (action.operation === "withdraw") {
            const withdrawn = await withdrawMemoryWithClient(client, {
              userId: input.userId,
              memoryId: action.memoryId,
              versionId: action.expectedVersionId,
              reason: action.reason,
              sourceMessageId: triggerMessageId,
              sourceCreatedAt,
              actor: "model",
              traceId: input.traceId,
            });
            mutations.push({
              operation: action.operation,
              memoryId: action.memoryId,
              versionId: action.expectedVersionId,
              tier: withdrawn.tier,
              content: withdrawn.content,
              embeddingMissing: false,
              status: "withdrawn",
            });
            longTermChanged ||= withdrawn.tier === "long";
            continue;
          }

          if (containsForbiddenMemorySecret(action.content)) continue;
          const layerEnabled =
            settings.memoryEnabled !== false &&
            (action.tier === "short"
              ? settings.shortTermMemoryEnabled !== false
              : settings.longTermMemoryEnabled !== false);
          const emotionEnabled =
            action.category !== "emotion" ||
            settings.emotionTrackingEnabled !== false;
          if (!layerEnabled || !emotionEnabled) continue;

          const validity = normalizeMemoryValidity(
            action.tier,
            action.validUntil,
          );
          await assertContentEvidenceAfterLastWithdrawal(
            client,
            input.userId,
            action.category,
            action.content,
            sourceCreatedAt,
          );
          const memoryId =
            action.operation === "create" ? randomUUID() : action.memoryId;
          let parentVersionId: string | null = null;
          let parentContent: string | null = null;
          let parentTier: "short" | "long" | null = null;
          if (action.operation === "create") {
            await client.query(
              `INSERT INTO memories (id, user_id) VALUES ($1, $2)`,
              [memoryId, input.userId],
            );
          } else {
            const expected = await client.query(
              `SELECT mv.id, mv.content, mv.tier
           FROM memories m JOIN memory_versions mv ON mv.memory_id = m.id
           WHERE m.id = $1 AND m.user_id = $2 AND mv.user_id = $2
             AND mv.id = $3 AND mv.status = 'active' AND mv.is_active = true
           FOR UPDATE`,
              [action.memoryId, input.userId, action.expectedVersionId],
            );
            if (!expected.rowCount) throw new Error("memory_version_conflict");
            if (
              action.operation === "promote" &&
              expected.rows[0].tier !== "short"
            ) {
              throw new Error("memory_promote_requires_short");
            }
            await assertEvidenceAfterLastWithdrawal(
              client,
              input.userId,
              action.memoryId,
              sourceCreatedAt,
            );
            parentVersionId = expected.rows[0].id;
            parentContent = expected.rows[0].content;
            parentTier = expected.rows[0].tier;
            await client.query(
              `UPDATE memory_versions SET status = 'superseded', is_active = false
           WHERE id = $1 AND user_id = $2`,
              [parentVersionId, input.userId],
            );
            await recordMemoryEvent(client, {
              userId: input.userId,
              memoryId,
              versionId: action.expectedVersionId,
              eventType: "superseded",
              actor: "model",
              traceId: input.traceId,
              content: parentContent ?? undefined,
              payload: { operation: action.operation },
            });
          }

          const embedding = input.embeddings?.[index];
          const versionId = randomUUID();
          await client.query(
            `INSERT INTO memory_versions
          (id, memory_id, user_id, category, content, tier, confidence, valid_until, reason,
           embedding_v2, is_active, status, source_type, scope, scope_key, sensitivity,
           evidence_quote, confirmed_at, parent_version_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::vector,
                 true, 'active', 'inferred', 'user', NULL, 'normal', NULL, NULL, $11)`,
            [
              versionId,
              memoryId,
              input.userId,
              action.category,
              action.content,
              action.tier,
              action.confidence,
              validity.validUntil,
              action.reason,
              embedding?.length === 1024 ? `[${embedding.join(",")}]` : null,
              parentVersionId,
            ],
          );
          for (const evidenceId of action.evidenceMessageIds) {
            await client.query(
              `INSERT INTO memory_evidence (memory_version_id, message_id, user_id)
           VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
              [versionId, evidenceId, input.userId],
            );
          }
          if (parentVersionId) {
            await client.query(
              `INSERT INTO memory_evidence(memory_version_id,message_id,user_id)
          SELECT $1,message_id,user_id FROM memory_evidence WHERE memory_version_id=$2 AND user_id=$3 ON CONFLICT DO NOTHING`,
              [versionId, parentVersionId, input.userId],
            );
            await client.query(
              `INSERT INTO memory_version_parents
            (user_id, child_version_id, parent_version_id, relation)
           VALUES ($1, $2, $3, $4)`,
              [
                input.userId,
                versionId,
                parentVersionId,
                action.operation === "promote" ? "promotes" : "supersedes",
              ],
            );
          }
          await recordMemoryEvent(client, {
            userId: input.userId,
            memoryId,
            versionId,
            eventType:
              action.operation === "create"
                ? "created"
                : action.operation === "promote"
                  ? "promoted"
                  : "updated",
            actor: "model",
            traceId: input.traceId,
            content: action.content,
            payload: {
              tier: action.tier,
              parentVersionId,
              validityNormalized: validity.normalized,
              validityReason: validity.reason,
            },
          });
          mutations.push({
            operation: action.operation,
            memoryId,
            versionId,
            tier: action.tier,
            content: action.content,
            embeddingMissing: embedding?.length !== 1024,
            status: "active",
          });
          longTermChanged ||= action.tier === "long" || parentTier === "long";
        }

        if (
          typeof input.reflection.sessionSummary === "string" &&
          input.reflection.summaryChanged !== false
        ) {
          await client.query(
            `INSERT INTO conversation_summaries (id, conversation_id, user_id, summary, source_message_id)
         VALUES ($1, $2, $3, $4, $5)`,
            [
              randomUUID(),
              input.conversationId,
              input.userId,
              input.reflection.sessionSummary,
              input.sourceMessageId,
            ],
          );
        }
        if (
          input.reflection.mood?.meaningful &&
          settings.emotionTrackingEnabled !== false
        ) {
          const moodIds = input.reflection.mood.evidenceMessageIds ?? [
            input.sourceMessageId,
          ];
          if (moodIds.some((id) => !sourceTimes.has(id)))
            throw new Error("memory_evidence_scope_invalid");
          const moodSource = [...moodIds].sort(
            (a, b) =>
              sourceTimes.get(b)!.getTime() - sourceTimes.get(a)!.getTime(),
          )[0]!;
          await client.query(
            `INSERT INTO mood_samples (id, user_id, conversation_id, message_id, score, summary, observed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
              randomUUID(),
              input.userId,
              input.conversationId,
              moodSource,
              input.reflection.mood.score,
              input.reflection.mood.summary,
              sourceTimes.get(moodSource),
            ],
          );
        }
        if (
          input.reflection.returnNote &&
          settings.returnNotesEnabled !== false
        ) {
          await client.query(
            `INSERT INTO return_notes (id, user_id, conversation_id, content, valid_after, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              randomUUID(),
              input.userId,
              input.conversationId,
              input.reflection.returnNote.content,
              input.reflection.returnNote.validAfter,
              input.reflection.returnNote.expiresAt,
            ],
          );
        }
        if (longTermChanged)
          await markCurrentProfileStale(client, input.userId);
        if (input.summaryEvidenceMessageIds) {
          if (
            input.summaryEvidenceMessageIds.some(
              (id) => !sourceIds.includes(id),
            )
          )
            throw new Error("memory_evidence_scope_invalid");
          await client.query(
            `UPDATE messages SET metadata=jsonb_set(metadata,'{summaryEligible}',to_jsonb(id=ANY($3::uuid[]))) WHERE user_id=$1 AND id=ANY($2::uuid[])`,
            [input.userId, sourceIds, input.summaryEvidenceMessageIds],
          );
        }
        return { memoryCount: mutations.length, mutations, longTermChanged };
      },
    ),
  );
}

export async function publishPersonalSkill(input: {
  userId: string;
  skill: PersonalSkill;
  source: "model" | "developer_restore";
  idempotencyKey?: string;
}) {
  return withTransaction(async (client) => {
    await lockUserForMemoryMutation(client, input.userId);
    const publish = async () => {
      const current = await client.query(
        `SELECT * FROM personal_skill_versions
       WHERE user_id = $1 AND is_active = true FOR UPDATE`,
        [input.userId],
      );
      const nextVersion = Number(current.rows[0]?.version ?? 0) + 1;
      await client.query(
        `UPDATE personal_skill_versions SET is_active = false
       WHERE user_id = $1 AND is_active = true`,
        [input.userId],
      );
      const id = randomUUID();
      const result = await client.query(
        `INSERT INTO personal_skill_versions
        (id, user_id, version, content, trigger_reason, expected_effect, source, parent_id, is_active)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, true) RETURNING *`,
        [
          id,
          input.userId,
          nextVersion,
          JSON.stringify(input.skill),
          input.skill.evolution.reason,
          input.skill.evolution.expectedEffect,
          input.source,
          current.rows[0]?.id ?? null,
        ],
      );
      const changes = diffJson(current.rows[0]?.content ?? {}, input.skill);
      return { ...result.rows[0], diff: changes };
    };
    return input.idempotencyKey
      ? runMemoryOperation(
          client,
          {
            userId: input.userId,
            idempotencyKey: input.idempotencyKey,
            operation: "personal_skill_rewrite",
            request: { source: input.source },
          },
          publish,
        )
      : publish();
  });
}

export async function restorePersonalSkill(userId: string, versionId: string) {
  const result = await getPool().query(
    `SELECT content FROM personal_skill_versions WHERE id = $1 AND user_id = $2`,
    [versionId, userId],
  );
  if (!result.rowCount) throw new Error("找不到要恢复的 Skill 版本");
  const skill = result.rows[0].content as PersonalSkill;
  return publishPersonalSkill({
    userId,
    skill: {
      ...skill,
      evolution: {
        ...skill.evolution,
        reason: `开发者从历史版本 ${versionId} 恢复`,
        expectedEffect: "重新体验这一版的交互方式，同时保留完整版本链。",
      },
    },
    source: "developer_restore",
  });
}

export async function addFeedback(input: {
  userId: string;
  messageId: string;
  value: "understood" | "not-me";
  reason?: string;
}) {
  const id = randomUUID();
  const result = await getPool().query(
    `INSERT INTO feedback (id, user_id, message_id, value, reason)
     SELECT $1, $2, id, $4, $5 FROM messages
     WHERE id = $3 AND user_id = $2
     RETURNING id`,
    [id, input.userId, input.messageId, input.value, input.reason ?? null],
  );
  if (!result.rowCount) throw new Error("只能评价当前用户自己的消息");
  return id;
}

export async function withdrawMemory(
  input: MemoryWithdrawInput & { userId: string; traceId?: string },
) {
  return withTransaction(async (client) =>
    runMemoryOperation(
      client,
      {
        userId: input.userId,
        idempotencyKey: input.idempotencyKey,
        operation: "withdraw",
        request: { memoryId: input.memoryId, versionId: input.versionId },
      },
      async () => {
        await lockUserForMemoryMutation(client, input.userId);
        const result = await withdrawMemoryWithClient(client, {
          userId: input.userId,
          memoryId: input.memoryId,
          versionId: input.versionId,
          reason: input.reason ?? "用户主动撤回",
          actor: "user",
          traceId: input.traceId,
        });
        if (result.tier === "long")
          await markCurrentProfileStale(client, input.userId);
        return {
          withdrawalId: result.withdrawalId,
          memoryId: input.memoryId,
          versionId: input.versionId,
          category: result.category,
          tier: result.tier,
        };
      },
    ),
  );
}

export async function recordMemoryUsage(
  input: MemoryUsageInput & { userId: string; traceId?: string },
) {
  return withTransaction(async (client) =>
    runMemoryOperation(
      client,
      {
        userId: input.userId,
        idempotencyKey: input.idempotencyKey,
        operation: "record_usage",
        request: {
          conversationId: input.conversationId,
          versionIds: [...new Set(input.versionIds)].sort(),
        },
      },
      async () => {
        const conversation = await client.query(
          `SELECT id FROM conversations WHERE id = $1 AND user_id = $2`,
          [input.conversationId, input.userId],
        );
        if (!conversation.rowCount)
          throw new Error("memory_conversation_scope_invalid");
        const versionIds = [...new Set(input.versionIds)];
        const used = await client.query(
          `UPDATE memory_versions mv SET last_used_at = now()
       FROM memories m
       WHERE mv.memory_id = m.id AND m.user_id = $1 AND mv.user_id = $1
         AND mv.id = ANY($2::uuid[]) AND mv.status = 'active' AND mv.is_active = true
         AND (mv.valid_until IS NULL OR mv.valid_until > now())
       RETURNING mv.id, mv.memory_id, mv.content`,
          [input.userId, versionIds],
        );
        for (const row of used.rows) {
          await recordMemoryEvent(client, {
            userId: input.userId,
            memoryId: row.memory_id,
            versionId: row.id,
            eventType: "used",
            actor: "system",
            traceId: input.traceId,
            content: row.content,
            payload: { conversationId: input.conversationId },
          });
        }
        return {
          count: used.rowCount ?? 0,
          versionIds: used.rows.map((row) => row.id),
        };
      },
    ),
  );
}

export async function setMemoryEmbedding(
  input: MemoryEmbeddingInput & { userId: string; traceId?: string },
) {
  return withTransaction(async (client) =>
    runMemoryOperation(
      client,
      {
        userId: input.userId,
        idempotencyKey: input.idempotencyKey,
        operation: "set_embedding",
        request: { memoryId: input.memoryId, versionId: input.versionId },
      },
      async () => {
        const result = await client.query(
          `UPDATE memory_versions mv SET embedding_v2 = $4::vector
       FROM memories m
       WHERE mv.memory_id = m.id AND m.id = $1 AND m.user_id = $2 AND mv.user_id = $2
         AND mv.id = $3 AND mv.status = 'active' AND mv.is_active = true
       RETURNING mv.id, mv.memory_id, mv.content`,
          [
            input.memoryId,
            input.userId,
            input.versionId,
            `[${input.embedding.join(",")}]`,
          ],
        );
        if (!result.rowCount) throw new Error("memory_version_conflict");
        await recordMemoryEvent(client, {
          userId: input.userId,
          memoryId: input.memoryId,
          versionId: input.versionId,
          eventType: "embedding_updated",
          actor: "system",
          traceId: input.traceId,
          content: result.rows[0].content,
        });
        return {
          memoryId: input.memoryId,
          versionId: input.versionId,
          embedded: true,
        };
      },
    ),
  );
}

export async function commitMemoryConsolidation(
  input: MemoryConsolidationInput & { userId: string; traceId?: string },
) {
  if (
    !input.verification.approved ||
    input.verification.omittedFacts.length ||
    input.verification.contradictions.length ||
    input.verification.overInferences.length
  ) {
    throw new Error("memory_consolidation_rejected");
  }
  const allSourceIds = input.rewrites.flatMap(
    (rewrite) => rewrite.sourceVersionIds,
  );
  if (new Set(allSourceIds).size !== allSourceIds.length)
    throw new Error("memory_consolidation_source_reused");
  if (!sameIds(allSourceIds, input.verification.checkedSourceVersionIds)) {
    throw new Error("memory_consolidation_review_scope_mismatch");
  }

  return withTransaction(async (client) =>
    runMemoryOperation(
      client,
      {
        userId: input.userId,
        idempotencyKey: input.idempotencyKey,
        operation: "commit_consolidation",
        request: {
          sourceVersionGroups: input.rewrites.map((rewrite) =>
            [...rewrite.sourceVersionIds].sort(),
          ),
        },
      },
      async () => {
        const settings = await lockUserForMemoryMutation(client, input.userId);
        if (
          settings.memoryEnabled === false ||
          settings.longTermMemoryEnabled === false
        ) {
          throw new Error("memory_profile_paused");
        }
        const created: Array<{
          memoryId: string;
          versionId: string;
          content: string;
          embeddingMissing: true;
        }> = [];
        for (const rewrite of input.rewrites) {
          const sources = await client.query(
            `SELECT mv.id, mv.memory_id, mv.category, mv.content
         FROM memory_versions mv JOIN memories m ON m.id = mv.memory_id
         WHERE m.user_id = $1 AND mv.user_id = $1 AND mv.id = ANY($2::uuid[])
           AND mv.status = 'active' AND mv.is_active = true AND mv.tier = 'long'
         ORDER BY mv.id FOR UPDATE OF mv`,
            [input.userId, rewrite.sourceVersionIds],
          );
          if (sources.rowCount !== rewrite.sourceVersionIds.length)
            throw new Error("memory_version_conflict");
          if (sources.rows.some((row) => row.category !== rewrite.category)) {
            throw new Error("memory_consolidation_category_mismatch");
          }
          if (containsForbiddenMemorySecret(rewrite.content))
            throw new Error("memory_forbidden_secret");

          const memoryId = randomUUID();
          const versionId = randomUUID();
          await client.query(
            `INSERT INTO memories (id, user_id) VALUES ($1, $2)`,
            [memoryId, input.userId],
          );
          await client.query(
            `INSERT INTO memory_versions
          (id, memory_id, user_id, category, content, tier, confidence, valid_until, reason,
           embedding_v2, is_active, status, source_type, scope, scope_key, sensitivity,
           evidence_quote, confirmed_at, parent_version_id)
         VALUES ($1, $2, $3, $4, $5, 'long', $6, NULL, $7,
                 NULL, true, 'active', 'inferred', 'user', NULL, 'normal', NULL, NULL, NULL)`,
            [
              versionId,
              memoryId,
              input.userId,
              rewrite.category,
              rewrite.content,
              rewrite.confidence,
              rewrite.reason,
            ],
          );
          await client.query(
            `INSERT INTO memory_evidence (memory_version_id, message_id, user_id)
         SELECT $1, me.message_id, $2 FROM memory_evidence me
         WHERE me.user_id = $2 AND me.memory_version_id = ANY($3::uuid[])
         ON CONFLICT DO NOTHING`,
            [versionId, input.userId, rewrite.sourceVersionIds],
          );
          await client.query(
            `INSERT INTO memory_version_parents
          (user_id, child_version_id, parent_version_id, relation)
         SELECT $1, $2, source_id, 'consolidates'
         FROM unnest($3::uuid[]) AS source_id`,
            [input.userId, versionId, rewrite.sourceVersionIds],
          );
          await client.query(
            `UPDATE memory_versions SET status = 'superseded', is_active = false
         WHERE user_id = $1 AND id = ANY($2::uuid[])`,
            [input.userId, rewrite.sourceVersionIds],
          );
          for (const source of sources.rows) {
            await recordMemoryEvent(client, {
              userId: input.userId,
              memoryId: source.memory_id,
              versionId: source.id,
              eventType: "superseded",
              actor: "system",
              traceId: input.traceId,
              content: source.content,
              payload: { consolidatedIntoVersionId: versionId },
            });
          }
          await recordMemoryEvent(client, {
            userId: input.userId,
            memoryId,
            versionId,
            eventType: "consolidated",
            actor: "model",
            traceId: input.traceId,
            content: rewrite.content,
            payload: { sourceVersionIds: rewrite.sourceVersionIds },
          });
          created.push({
            memoryId,
            versionId,
            content: rewrite.content,
            embeddingMissing: true,
          });
        }
        await markCurrentProfileStale(client, input.userId);
        return {
          mutations: created,
          memoryCount: created.length,
          longTermChanged: true,
        };
      },
    ),
  );
}

export async function restoreMemoryVersion(
  input: MemoryRestoreInput & { userId: string; traceId?: string },
) {
  return withTransaction(async (client) =>
    runMemoryOperation(
      client,
      {
        userId: input.userId,
        idempotencyKey: input.idempotencyKey,
        operation: "restore_version",
        request: {
          memoryId: input.memoryId,
          versionId: input.versionId,
          expectedActiveVersionId: input.expectedActiveVersionId,
        },
      },
      async () => {
        await lockUserForMemoryMutation(client, input.userId);
        const historical = await client.query(
          `SELECT mv.* FROM memory_versions mv JOIN memories m ON m.id = mv.memory_id
       WHERE m.id = $1 AND m.user_id = $2 AND mv.user_id = $2 AND mv.id = $3
         AND mv.status IN ('superseded', 'withdrawn', 'expired')
       FOR UPDATE OF mv`,
          [input.memoryId, input.userId, input.versionId],
        );
        if (!historical.rowCount)
          throw new Error("memory_restore_source_invalid");
        const source = historical.rows[0];
        const active = await client.query(
          `SELECT id, content, tier FROM memory_versions
       WHERE memory_id = $1 AND user_id = $2 AND status = 'active' AND is_active = true
       FOR UPDATE`,
          [input.memoryId, input.userId],
        );
        const activeId = active.rows[0]?.id ?? null;
        if (activeId !== input.expectedActiveVersionId)
          throw new Error("memory_version_conflict");
        if (active.rowCount) {
          await client.query(
            `UPDATE memory_versions SET status = 'superseded', is_active = false WHERE id = $1 AND user_id = $2`,
            [active.rows[0].id, input.userId],
          );
          await recordMemoryEvent(client, {
            userId: input.userId,
            memoryId: input.memoryId,
            versionId: active.rows[0].id,
            eventType: "superseded",
            actor: "developer",
            traceId: input.traceId,
            content: active.rows[0].content,
            payload: { restoredFromVersionId: input.versionId },
          });
        }

        const versionId = randomUUID();
        const validUntil =
          source.tier === "short"
            ? normalizeMemoryValidity("short", null).validUntil
            : null;
        await client.query(
          `INSERT INTO memory_versions
        (id, memory_id, user_id, category, content, tier, confidence, valid_until, reason,
         embedding, embedding_v2, is_active, status, source_type, scope, scope_key,
         sensitivity, evidence_quote, confirmed_at, parent_version_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
               $10, $11, true, 'active', $12, 'user', NULL, $13, $14, $15, $16)`,
          [
            versionId,
            input.memoryId,
            input.userId,
            source.category,
            source.content,
            source.tier,
            source.confidence,
            validUntil,
            `开发者恢复历史版本 ${input.versionId}`,
            source.embedding,
            source.embedding_v2,
            source.source_type,
            source.sensitivity,
            source.evidence_quote,
            source.confirmed_at,
            input.versionId,
          ],
        );
        await client.query(
          `INSERT INTO memory_evidence (memory_version_id, message_id, user_id)
       SELECT $1, message_id, user_id FROM memory_evidence
       WHERE memory_version_id = $2 AND user_id = $3 ON CONFLICT DO NOTHING`,
          [versionId, input.versionId, input.userId],
        );
        await client.query(
          `INSERT INTO memory_version_parents (user_id, child_version_id, parent_version_id, relation)
       VALUES ($1, $2, $3, 'restores')`,
          [input.userId, versionId, input.versionId],
        );
        await recordMemoryEvent(client, {
          userId: input.userId,
          memoryId: input.memoryId,
          versionId,
          eventType: "restored",
          actor: "developer",
          traceId: input.traceId,
          content: source.content,
          payload: {
            restoredFromVersionId: input.versionId,
            previousActiveVersionId: active.rows[0]?.id ?? null,
          },
        });
        if (source.tier === "long" || active.rows[0]?.tier === "long") {
          await markCurrentProfileStale(client, input.userId);
        }
        const restored = await client.query(
          `SELECT ${MEMORY_SELECT_COLUMNS}
       FROM memories m JOIN memory_versions mv ON mv.memory_id = m.id
       WHERE m.user_id = $1 AND mv.id = $2`,
          [input.userId, versionId],
        );
        return {
          memory: mapMemoryRow(restored.rows[0]),
          restoredFromVersionId: input.versionId,
        };
      },
    ),
  );
}

export async function deleteAllUserData(userId: string): Promise<void> {
  await withTransaction(async (client) => {
    const locked = await client.query(
      `SELECT id FROM users WHERE id = $1 FOR UPDATE`,
      [userId],
    );
    if (!locked.rowCount) return;
    const tables = [
      "message_sources",
      "onboarding_question_plans",
      "onboarding_question_candidates",
      "benchmark_preferences",
      "benchmark_outputs",
      "benchmark_runs",
      "risk_events",
      "memory_operations",
      "memory_events",
      "memory_version_parents",
      "memory_withdrawals",
      "mcp_calls",
      "model_runs",
      "trace_events",
      "activity_events",
      "jobs",
      "return_notes",
      "feedback",
      "mood_samples",
      "memory_evidence",
      "memory_versions",
      "memories",
      "profile_snapshots",
      "conversation_summaries",
      "messages",
      "conversations",
      "personal_skill_versions",
    ];
    for (const table of tables) {
      await client.query(`DELETE FROM ${table} WHERE user_id = $1`, [userId]);
    }
    await client.query(`DELETE FROM users WHERE id = $1`, [userId]);
  });
}

export async function recordRiskEvent(input: {
  userId: string;
  conversationId: string;
  messageId: string;
  assessment: RiskAssessment;
}) {
  const id = randomUUID();
  await getPool().query(
    `INSERT INTO risk_events
      (id, user_id, conversation_id, message_id, level, reason, response_path, evidence)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [
      id,
      input.userId,
      input.conversationId,
      input.messageId,
      input.assessment.level,
      input.assessment.reason,
      input.assessment.responsePath,
      JSON.stringify(input.assessment.evidence),
    ],
  );
  return id;
}

export async function createBenchmarkRun(input: {
  userId: string;
  prompt: string;
  scenario: string;
  adapterId: string;
  modelName?: string;
  transport?: string;
  outputs: BenchmarkOutput[];
}) {
  return withTransaction(async (client) => {
    const id = randomUUID();
    await client.query(
      `INSERT INTO benchmark_runs (id, user_id, prompt, scenario, adapter_id, model_name, transport)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        id,
        input.userId,
        input.prompt,
        input.scenario,
        input.adapterId,
        input.modelName ?? null,
        input.transport ?? null,
      ],
    );
    for (const output of input.outputs) {
      await client.query(
        `INSERT INTO benchmark_outputs
          (id, run_id, user_id, mode, content, claims, latency_ms, estimated_tokens)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
        [
          randomUUID(),
          id,
          input.userId,
          output.mode,
          output.content,
          JSON.stringify(output.claims),
          output.latencyMs,
          output.estimatedTokens,
        ],
      );
    }
    return { id, outputs: input.outputs };
  });
}

export async function recordBenchmarkPreference(input: {
  userId: string;
  runId: string;
  preferredMode: BenchmarkMode;
  reason?: string;
}) {
  await getPool().query(
    `INSERT INTO benchmark_preferences (id, run_id, user_id, preferred_mode, reason)
     SELECT $1, id, $2, $3, $4 FROM benchmark_runs
     WHERE id = $5 AND user_id = $2
     ON CONFLICT (run_id, user_id) DO UPDATE
       SET preferred_mode = EXCLUDED.preferred_mode, reason = EXCLUDED.reason`,
    [
      randomUUID(),
      input.userId,
      input.preferredMode,
      input.reason ?? null,
      input.runId,
    ],
  );
}

export async function getCompetitionData(userId: string) {
  const [runs, risks, withdrawals, conversations] = await Promise.all([
    getPool().query(
      `SELECT br.*,
        COALESCE(json_agg(bo ORDER BY bo.mode) FILTER (WHERE bo.id IS NOT NULL), '[]') AS outputs,
        bp.preferred_mode, bp.reason AS preference_reason
       FROM benchmark_runs br
       LEFT JOIN benchmark_outputs bo ON bo.run_id = br.id
       LEFT JOIN benchmark_preferences bp ON bp.run_id = br.id AND bp.user_id = br.user_id
       WHERE br.user_id = $1
       GROUP BY br.id, bp.preferred_mode, bp.reason
       ORDER BY br.created_at DESC LIMIT 30`,
      [userId],
    ),
    getPool().query(
      `SELECT * FROM risk_events WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [userId],
    ),
    getPool().query(
      `SELECT * FROM memory_withdrawals WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [userId],
    ),
    listConversations(userId),
  ]);
  const transcripts = await Promise.all(
    conversations.map(async (conversation) => ({
      ...conversation,
      messages: await listMessages(userId, conversation.id, 80),
    })),
  );
  return {
    runs: runs.rows,
    risks: risks.rows,
    withdrawals: withdrawals.rows,
    conversations: transcripts,
  };
}

export async function recordTrace(input: {
  userId: string;
  traceId: string;
  stage: string;
  payload: Record<string, unknown>;
  durationMs?: number;
}) {
  await getPool().query(
    `INSERT INTO trace_events (id, user_id, trace_id, stage, payload, duration_ms)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
    [
      randomUUID(),
      input.userId,
      input.traceId,
      input.stage,
      JSON.stringify(input.payload),
      input.durationMs ?? null,
    ],
  );
}

export async function recordModelRun(input: {
  userId: string;
  traceId: string;
  role: ModelTask;
  adapterId: string;
  modelName?: string;
  transport?: string;
  conversationId?: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  searchCalls?: number;
  estimatedInputTokens?: number;
  estimatedOutputTokens?: number;
  estimatedCostCny?: number;
  firstTokenMs?: number;
  firstDeltaMs?: number;
  usageReported?: boolean;
  requestId?: string;
  retries?: number;
  fallbackFrom?: string;
  errorCode?: string;
  thinking?: boolean;
  sources?: ModelSource[];
  attempts?: ModelAttemptMeta[];
  promptVersion?: string;
  status?: "running" | "completed" | "failed" | "cancelled";
  durationMs: number;
  finishReason: string;
}) {
  await getPool().query(
    `INSERT INTO model_runs
      (id, user_id, trace_id, role, adapter_id, model_name, input_tokens,
       output_tokens, estimated_cost_cny, duration_ms, finish_reason,
       conversation_id, status, cached_input_tokens, reasoning_tokens, search_calls,
       estimated_input_tokens, estimated_output_tokens, first_token_ms, request_id,
       retries, fallback_from, error_code, thinking, sources, prompt_version, transport, attempts, first_delta_ms, usage_reported)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
       $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25::jsonb, $26, $27, $28::jsonb, $29, $30)`,
    [
      randomUUID(),
      input.userId,
      input.traceId,
      input.role,
      input.adapterId,
      input.modelName ?? process.env.MODEL_NAME ?? input.adapterId,
      input.inputTokens,
      input.outputTokens,
      input.estimatedCostCny ?? 0,
      input.durationMs,
      input.finishReason,
      input.conversationId ?? null,
      input.status ?? "completed",
      input.cachedInputTokens ?? 0,
      input.reasoningTokens ?? 0,
      input.searchCalls ?? 0,
      input.estimatedInputTokens ?? input.inputTokens,
      input.estimatedOutputTokens ?? input.outputTokens,
      input.firstTokenMs ?? null,
      input.requestId ?? null,
      input.retries ?? 0,
      input.fallbackFrom ?? null,
      input.errorCode ?? null,
      input.thinking ?? false,
      JSON.stringify(input.sources ?? []),
      input.promptVersion ?? "v1",
      input.transport ?? "unknown",
      JSON.stringify(input.attempts ?? []),
      input.firstDeltaMs ?? null,
      input.usageReported ?? true,
    ],
  );
}

export async function recordModelCallMeta(input: {
  userId: string;
  traceId: string;
  conversationId?: string;
  adapterId: string;
  meta: ModelCallMeta;
  promptVersion?: string;
}) {
  return recordModelRun({
    userId: input.userId,
    traceId: input.traceId,
    conversationId: input.conversationId,
    role: input.meta.task,
    adapterId: input.adapterId,
    modelName: input.meta.model,
    transport: input.meta.transport,
    inputTokens: input.meta.usage.inputTokens,
    outputTokens: input.meta.usage.outputTokens,
    cachedInputTokens: input.meta.usage.cachedInputTokens,
    reasoningTokens: input.meta.usage.reasoningTokens,
    searchCalls: input.meta.usage.searchCalls,
    estimatedCostCny: input.meta.estimatedCostCny,
    firstTokenMs: input.meta.firstTokenMs,
    firstDeltaMs: input.meta.firstDeltaMs,
    usageReported: input.meta.usageReported,
    status: ["stop", "completed"].includes(input.meta.finishReason)
      ? "completed"
      : ["request_cancelled", "cancelled"].includes(input.meta.finishReason)
        ? "cancelled"
        : "failed",
    requestId: input.meta.requestId,
    retries: input.meta.retries,
    fallbackFrom: input.meta.fallbackFrom,
    thinking: input.meta.thinking,
    sources: input.meta.sources,
    attempts: input.meta.attempts,
    durationMs: input.meta.durationMs,
    finishReason: input.meta.finishReason,
    promptVersion: input.promptVersion,
  });
}

export async function saveMessageSources(input: {
  userId: string;
  messageId: string;
  sources: ModelSource[];
}) {
  for (const source of input.sources) {
    await getPool().query(
      `INSERT INTO message_sources (id, message_id, user_id, title, url, site_name)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        randomUUID(),
        input.messageId,
        input.userId,
        source.title,
        source.url,
        source.siteName ?? null,
      ],
    );
  }
}

export async function getModelCostData(userId: string) {
  const [runs, totals, pricing] = await Promise.all([
    getPool().query(
      `SELECT * FROM model_runs WHERE user_id = $1 ORDER BY created_at DESC LIMIT 200`,
      [userId],
    ),
    getPool().query(
      `SELECT COALESCE(sum(estimated_cost_cny), 0)::float AS total_cost,
              COALESCE(sum(input_tokens), 0)::int AS input_tokens,
              COALESCE(sum(output_tokens), 0)::int AS output_tokens,
              COALESCE(sum(cached_input_tokens), 0)::int AS cached_input_tokens,
              COALESCE(sum(reasoning_tokens), 0)::int AS reasoning_tokens,
              COALESCE(sum(search_calls), 0)::int AS search_calls
       FROM model_runs WHERE user_id = $1`,
      [userId],
    ),
    getPool().query(
      `SELECT DISTINCT ON (model_name) * FROM model_pricing_snapshots
       ORDER BY model_name, fetched_at DESC`,
    ),
  ]);
  return { runs: runs.rows, totals: totals.rows[0], pricing: pricing.rows };
}

export async function recordPricingSnapshot(input: {
  modelName: string;
  provider: string;
  prices: unknown;
  capabilities?: unknown;
  contextWindow?: number | null;
  requestId?: string;
}) {
  return getPool().query(
    `INSERT INTO model_pricing_snapshots
      (id, model_name, provider, prices, capabilities, context_window, source_request_id)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7)`,
    [
      randomUUID(),
      input.modelName,
      input.provider,
      JSON.stringify(input.prices),
      JSON.stringify(input.capabilities ?? []),
      input.contextWindow ?? null,
      input.requestId ?? null,
    ],
  );
}

export async function recordMcpCall(input: {
  userId: string;
  traceId?: string;
  toolName: string;
  arguments: Record<string, unknown>;
  result: Record<string, unknown>;
  durationMs: number;
}) {
  await getPool().query(
    `INSERT INTO mcp_calls
      (id, user_id, trace_id, tool_name, arguments, result, duration_ms)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)`,
    [
      randomUUID(),
      input.userId,
      input.traceId ?? null,
      input.toolName,
      JSON.stringify(input.arguments),
      JSON.stringify(input.result),
      input.durationMs,
    ],
  );
}

export async function addActivity(input: {
  userId: string;
  type: string;
  payload: Record<string, unknown>;
}) {
  const result = await getPool().query(
    `INSERT INTO activity_events (id, user_id, type, payload)
     VALUES ($1, $2, $3, $4::jsonb) RETURNING *`,
    [randomUUID(), input.userId, input.type, JSON.stringify(input.payload)],
  );
  return result.rows[0];
}

export async function getActivitiesSince(userId: string, since?: string) {
  const result = await getPool().query(
    `SELECT * FROM activity_events
     WHERE user_id = $1 AND ($2::timestamptz IS NULL OR created_at > $2::timestamptz)
     ORDER BY created_at LIMIT 100`,
    [userId, since ?? null],
  );
  return result.rows;
}

export async function getActivitiesAfter(
  userId: string,
  cursor: { since?: string; afterId?: string | null },
) {
  if (cursor.afterId) {
    const anchor = await getPool().query(
      `SELECT created_at, id FROM activity_events WHERE id = $1 AND user_id = $2`,
      [cursor.afterId, userId],
    );
    if (anchor.rowCount) {
      const result = await getPool().query(
        `SELECT * FROM activity_events
         WHERE user_id = $1 AND (created_at, id) > (SELECT created_at,id FROM activity_events WHERE id=$2 AND user_id=$1)
         ORDER BY created_at, id LIMIT 100`,
        [userId, anchor.rows[0].id],
      );
      return result.rows;
    }
  }
  return getActivitiesSince(userId, cursor.since);
}

export async function getDeveloperData(
  userId: string,
  section: "trace" | "memory" | "skills" | "all" = "all",
) {
  const query = (group: typeof section, sql: string, values: unknown[]) =>
    section === "all" || section === group
      ? getPool().query(sql, values)
      : Promise.resolve({ rows: [] });
  const [
    traces,
    memoryEvents,
    memoryLineage,
    memories,
    profiles,
    skills,
    mcpCalls,
    modelRuns,
  ] = await Promise.all([
    query(
      "trace",
      `SELECT * FROM trace_events WHERE user_id = $1 ORDER BY created_at DESC LIMIT 160`,
      [userId],
    ),
    query(
      "memory",
      `SELECT * FROM memory_events WHERE user_id = $1 ORDER BY created_at DESC LIMIT 240`,
      [userId],
    ),
    query(
      "memory",
      `SELECT * FROM memory_version_parents WHERE user_id = $1 ORDER BY created_at DESC LIMIT 240`,
      [userId],
    ),
    query(
      "memory",
      `SELECT m.id AS memory_id, mv.*, COALESCE(json_agg(me.message_id)
        FILTER (WHERE me.message_id IS NOT NULL), '[]') AS evidence_ids
       FROM memories m JOIN memory_versions mv ON mv.memory_id = m.id
       LEFT JOIN memory_evidence me ON me.memory_version_id = mv.id
       WHERE m.user_id = $1 GROUP BY m.id, mv.id ORDER BY mv.created_at DESC`,
      [userId],
    ),
    query(
      "memory",
      `SELECT * FROM profile_snapshots WHERE user_id = $1 ORDER BY created_at DESC LIMIT 60`,
      [userId],
    ),
    query(
      "skills",
      `SELECT * FROM personal_skill_versions WHERE user_id = $1 ORDER BY version DESC`,
      [userId],
    ),
    query(
      "trace",
      `SELECT * FROM mcp_calls WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [userId],
    ),
    query(
      "trace",
      `SELECT * FROM model_runs WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [userId],
    ),
  ]);
  return {
    traces: traces.rows,
    memories: memories.rows,
    memoryEvents: memoryEvents.rows,
    memoryLineage: memoryLineage.rows,
    profiles: profiles.rows,
    skills: skills.rows,
    mcpCalls: mcpCalls.rows,
    modelRuns: modelRuns.rows,
  };
}

async function getSummarySourceVersionIds(
  userId: string,
  client: Pick<PoolClient, "query"> = getPool(),
): Promise<string[]> {
  const result = await client.query(
    `SELECT mv.id FROM memory_versions mv JOIN memories m ON m.id = mv.memory_id
     WHERE m.user_id = $1 AND mv.user_id = $1
       AND mv.status = 'active' AND mv.is_active = true AND mv.tier = 'long'
     ORDER BY mv.id`,
    [userId],
  );
  return result.rows.map((row) => String(row.id));
}

async function withdrawMemoryWithClient(
  client: PoolClient,
  input: {
    userId: string;
    memoryId: string;
    versionId: string;
    reason: string;
    sourceMessageId?: string;
    sourceCreatedAt?: Date;
    actor: MemoryEventActor;
    traceId?: string;
  },
) {
  const current = await client.query(
    `SELECT mv.id, mv.category, mv.content, mv.tier
     FROM memories m JOIN memory_versions mv ON mv.memory_id = m.id
     WHERE m.id = $1 AND m.user_id = $2 AND mv.user_id = $2
       AND mv.id = $3 AND mv.status = 'active' AND mv.is_active = true
     FOR UPDATE OF mv`,
    [input.memoryId, input.userId, input.versionId],
  );
  if (!current.rowCount) throw new Error("memory_version_conflict");
  const row = current.rows[0];
  await client.query(
    `UPDATE memory_versions SET is_active = false, status = 'withdrawn'
     WHERE id = $1 AND user_id = $2`,
    [input.versionId, input.userId],
  );
  const withdrawalId = randomUUID();
  await client.query(
    `INSERT INTO memory_withdrawals
      (id, user_id, memory_id, version_id, source_message_id, category, content_hash, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      withdrawalId,
      input.userId,
      input.memoryId,
      input.versionId,
      input.sourceMessageId ?? null,
      row.category,
      memoryContentHash(row.content),
      input.reason,
    ],
  );
  await recordMemoryEvent(client, {
    userId: input.userId,
    memoryId: input.memoryId,
    versionId: input.versionId,
    eventType: "withdrawn",
    actor: input.actor,
    traceId: input.traceId,
    content: row.content,
    payload: {
      reason: input.reason,
      sourceMessageId: input.sourceMessageId ?? null,
      sourceCreatedAt: input.sourceCreatedAt?.toISOString() ?? null,
    },
  });
  return {
    withdrawalId,
    category: row.category as MemoryRecord["category"],
    tier: row.tier as MemoryRecord["tier"],
    content: String(row.content),
  };
}

async function assertNoWithdrawAndRecreate(
  client: Pick<PoolClient, "query">,
  userId: string,
  actions: MemoryMutation[],
): Promise<void> {
  const withdrawals = actions.filter(
    (action) => action.operation === "withdraw",
  );
  const writes = actions.filter(
    (action): action is Exclude<MemoryMutation, { operation: "withdraw" }> =>
      action.operation !== "withdraw" &&
      withdrawals.some(
        (withdrawal) => withdrawal.triggerMessageId === action.triggerMessageId,
      ),
  );
  if (!withdrawals.length || !writes.length) return;
  const withdrawn = await client.query(
    `SELECT mv.content FROM memory_versions mv JOIN memories m ON m.id = mv.memory_id
     WHERE m.user_id = $1 AND mv.user_id = $1
       AND mv.id = ANY($2::uuid[]) AND mv.status = 'active' AND mv.is_active = true`,
    [userId, withdrawals.map((action) => action.expectedVersionId)],
  );
  const withdrawnContents = new Set(
    withdrawn.rows.map((row) => normalizeMemoryContent(row.content)),
  );
  if (
    writes.some((action) =>
      withdrawnContents.has(normalizeMemoryContent(action.content)),
    )
  ) {
    throw new Error("memory_withdraw_recreate_same_evidence");
  }
}

async function assertEvidenceAfterLastWithdrawal(
  client: Pick<PoolClient, "query">,
  userId: string,
  memoryId: string,
  evidenceCreatedAt: Date,
): Promise<void> {
  const result = await client.query(
    `SELECT max(COALESCE(msg.created_at,w.created_at)) AS withdrawn_at FROM memory_withdrawals w LEFT JOIN messages msg ON msg.id=w.source_message_id
     WHERE w.user_id = $1 AND w.memory_id = $2`,
    [userId, memoryId],
  );
  const withdrawnAt = result.rows[0]?.withdrawn_at;
  if (
    withdrawnAt &&
    evidenceCreatedAt.getTime() <= new Date(withdrawnAt).getTime()
  ) {
    throw new Error("memory_stale_after_withdrawal");
  }
}

async function assertContentEvidenceAfterLastWithdrawal(
  client: Pick<PoolClient, "query">,
  userId: string,
  category: string,
  content: string,
  evidenceCreatedAt: Date,
): Promise<void> {
  const result = await client.query(
    `SELECT max(COALESCE(msg.created_at,w.created_at)) AS withdrawn_at FROM memory_withdrawals w LEFT JOIN messages msg ON msg.id=w.source_message_id
     WHERE w.user_id = $1 AND w.category = $2 AND w.content_hash = $3`,
    [userId, category, memoryContentHash(content)],
  );
  const withdrawnAt = result.rows[0]?.withdrawn_at;
  if (
    withdrawnAt &&
    evidenceCreatedAt.getTime() <= new Date(withdrawnAt).getTime()
  ) {
    throw new Error("memory_stale_after_withdrawal");
  }
}

async function markCurrentProfileStale(
  client: Pick<PoolClient, "query">,
  userId: string,
): Promise<void> {
  await client.query(
    `UPDATE profile_snapshots SET sync_status = 'stale'
     WHERE user_id = $1 AND sync_status = 'current'`,
    [userId],
  );
}

async function lockUserForMemoryMutation(
  client: Pick<PoolClient, "query">,
  userId: string,
): Promise<Record<string, boolean>> {
  const result = await client.query(
    `SELECT settings FROM users WHERE id = $1 FOR UPDATE`,
    [userId],
  );
  if (!result.rowCount) throw new Error("user_not_found");
  return result.rows[0].settings ?? {};
}

async function recordMemoryEvent(
  client: Pick<PoolClient, "query">,
  input: {
    userId: string;
    memoryId: string;
    versionId: string;
    eventType: MemoryEventType;
    actor: MemoryEventActor;
    traceId?: string;
    content?: string;
    payload?: Record<string, unknown>;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO memory_events
      (id, user_id, memory_id, version_id, event_type, actor, trace_id, content_hash, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
    [
      randomUUID(),
      input.userId,
      input.memoryId,
      input.versionId,
      input.eventType,
      input.actor,
      input.traceId ?? null,
      input.content ? memoryContentHash(input.content) : null,
      JSON.stringify(input.payload ?? {}),
    ],
  );
}

async function runMemoryOperation<T extends Record<string, unknown>>(
  client: Pick<PoolClient, "query">,
  operation: {
    userId: string;
    idempotencyKey: string;
    operation: string;
    request: unknown;
  },
  execute: () => Promise<T>,
): Promise<T & { receipt: MemoryOperationReceipt }> {
  const requestHash = createHash("sha256")
    .update(stableJson(operation.request))
    .digest("hex");
  const inserted = await client.query(
    `INSERT INTO memory_operations (user_id, idempotency_key, operation, request_hash)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, idempotency_key) DO NOTHING
     RETURNING idempotency_key`,
    [
      operation.userId,
      operation.idempotencyKey,
      operation.operation,
      requestHash,
    ],
  );
  if (!inserted.rowCount) {
    const existing = await client.query(
      `SELECT operation, request_hash, result FROM memory_operations
       WHERE user_id = $1 AND idempotency_key = $2 FOR UPDATE`,
      [operation.userId, operation.idempotencyKey],
    );
    const row = existing.rows[0];
    if (
      !row ||
      row.operation !== operation.operation ||
      row.request_hash !== requestHash
    ) {
      throw new Error("memory_idempotency_conflict");
    }
    if (!row.result) throw new Error("memory_operation_incomplete");
    return {
      ...(row.result as T),
      receipt: {
        idempotencyKey: operation.idempotencyKey,
        operation: operation.operation,
        replayed: true,
      },
    };
  }
  const result = await execute();
  await client.query(
    `UPDATE memory_operations SET result = $3::jsonb
     WHERE user_id = $1 AND idempotency_key = $2`,
    [operation.userId, operation.idempotencyKey, JSON.stringify(result)],
  );
  return {
    ...result,
    receipt: {
      idempotencyKey: operation.idempotencyKey,
      operation: operation.operation,
      replayed: false,
    },
  };
}

function mapMemoryRow(row: any): MemoryRecord {
  return {
    id: row.id,
    versionId: row.version_id ?? row.id,
    category: row.category,
    content: row.content,
    tier: row.tier,
    confidence: Number(row.confidence),
    validUntil: row.valid_until
      ? new Date(row.valid_until).toISOString()
      : null,
    reason: row.reason,
    status: row.status,
    lastUsedAt: row.last_used_at
      ? new Date(row.last_used_at).toISOString()
      : null,
    evidenceMessageIds: row.evidence_message_ids ?? [],
    parentVersionIds: row.parent_version_ids ?? [],
    createdAt: new Date(row.created_at).toISOString(),
  };
}

function mapProfileRow(row: any): ProfileSnapshot {
  return {
    id: row.id,
    summary: row.summary,
    dimensionWeights: row.dimension_weights ?? {},
    understanding: row.understanding_components ?? {
      coverage: 0,
      validation: 0,
      personalization: 0,
      temporal: 0,
    },
    score: Number(row.understanding_score ?? 0),
    schemaVersion: row.schema_version ?? "legacy-v1",
    sourceMemoryVersionIds: row.source_memory_version_ids ?? [],
    scoreChangeReasons: row.score_change_reasons ?? [],
    syncStatus: row.sync_status ?? "legacy",
    createdAt: new Date(row.created_at).toISOString(),
  };
}

function explainScoreChange(
  previous: ProfileSnapshot | null,
  components: ProfileSnapshot["understanding"],
  score: number,
): ScoreChangeReason[] {
  if (!previous) {
    return [
      { component: "total", delta: score, message: "形成了第一轮长期认识。" },
    ];
  }
  type ScoreComponent = Exclude<keyof ProfileSnapshot["understanding"], "algorithmVersion">;
  const labels: Record<ScoreComponent, string> = {
    coverage: "画像覆盖",
    validation: "长期一致性",
    personalization: "回答贴合度",
    temporal: "时间校准",
  };
  const reasons = (Object.keys(labels) as ScoreComponent[])
    .map((component) => ({
      component,
      delta: roundComponent(
        components[component] - previous.understanding[component],
      ),
      message: `${labels[component]}${components[component] >= previous.understanding[component] ? "有所增加" : "有所下降"}。`,
    }))
    .filter((reason) => reason.delta !== 0);
  return [
    {
      component: "total",
      delta: score - previous.score,
      message:
        score === previous.score
          ? "了解度保持稳定。"
          : `了解度${score > previous.score ? "上升" : "下降"}了 ${Math.abs(score - previous.score)}%。`,
    },
    ...reasons,
  ];
}

function roundComponent(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function sameIds(left: string[], right: string[]): boolean {
  const a = [...new Set(left)].sort();
  const b = [...new Set(right)].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export async function getReturnNote(userId: string) {
  const result = await getPool().query(
    `UPDATE return_notes SET shown_at = now()
     WHERE id = (
       SELECT rn.id FROM return_notes rn
       JOIN users u ON u.id = rn.user_id
       WHERE rn.user_id = $1 AND rn.shown_at IS NULL
         AND (u.settings->>'returnNotesEnabled')::boolean = true
         AND rn.valid_after <= now() AND rn.expires_at > now()
       ORDER BY valid_after DESC LIMIT 1
     ) RETURNING *`,
    [userId],
  );
  return result.rows[0] ?? null;
}

export function mapMessage(row: any): ChatMessage {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    createdAt: new Date(row.created_at).toISOString(),
    metadata: { ...row.metadata, ...(row.client_request_id ? { clientRequestId: row.client_request_id } : {}) },
  };
}
