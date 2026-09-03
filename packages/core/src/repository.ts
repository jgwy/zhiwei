import { createHash, randomUUID } from "node:crypto";
import { diffJson } from "diff";
import type { PoolClient } from "pg";
import { getPool, withTransaction } from "./db";
import { defaultPersonalSkill } from "./personal-skill";
import { inferMemoryKind, memoryIsRecallable, normalizeMemoryMutation, validateMemoryEvidence } from "./memory-policy";
import {
  calculateUnderstandingScore,
  deriveUnderstandingComponents,
} from "./score";
import type {
  ChatMessage,
  MemoryRecord,
  ModelCallMeta,
  ModelSource,
  ModelTask,
  PersonalSkill,
  BenchmarkMode,
  BenchmarkOutput,
  ProfileSnapshot,
  RiskAssessment,
  ReflectionOutput,
} from "./types";

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

export async function getUserState(userId: string) {
  await ensureUser(userId);
  const [user, conversations, profile, memories, mood, skill] = await Promise.all([
    getPool().query(`SELECT * FROM users WHERE id = $1`, [userId]),
    listConversations(userId),
    getLatestProfile(userId),
    listMemoriesForUser(userId),
    getMoodSeries(userId),
    getActiveSkill(userId),
  ]);
  return {
    user: user.rows[0],
    conversations,
    profile,
    memories,
    mood,
    skill,
  };
}

export async function listConversations(userId: string) {
  const result = await getPool().query(
    `SELECT c.*,
      COALESCE((SELECT json_agg(m ORDER BY m.created_at)
        FROM (SELECT id, role, content, created_at, metadata
              FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 80) m), '[]') AS messages
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
    messages: (row.messages ?? []).map(mapMessage),
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

export async function addUserMessageWithReflectionJob(input: {
  conversationId: string;
  userId: string;
  content: string;
  traceId: string;
  id?: string;
}): Promise<{ message: ChatMessage; jobId: string }> {
  return withTransaction(async (client) => {
    const messageId = input.id ?? randomUUID();
    const messageResult = await client.query(
      `INSERT INTO messages (id, conversation_id, user_id, role, content, metadata)
       VALUES ($1, $2, $3, 'user', $4, $5::jsonb) RETURNING *`,
      [messageId, input.conversationId, input.userId, input.content, JSON.stringify({ traceId: input.traceId })],
    );
    const jobId = randomUUID();
    const jobResult = await client.query(
      `INSERT INTO jobs (id, user_id, type, payload, idempotency_key)
       VALUES ($1, $2, 'reflection', $3::jsonb, $4)
       ON CONFLICT (user_id, idempotency_key) WHERE idempotency_key IS NOT NULL
       DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
       RETURNING id`,
      [
        jobId,
        input.userId,
        JSON.stringify({
          conversationId: input.conversationId,
          messageId,
          content: input.content,
          kind: "chat",
          traceId: input.traceId,
        }),
        `reflection:${messageId}:v1`,
      ],
    );
    await client.query(
      `UPDATE conversations SET updated_at = now() WHERE id = $1 AND user_id = $2`,
      [input.conversationId, input.userId],
    );
    return { message: mapMessage(messageResult.rows[0]), jobId: jobResult.rows[0].id };
  });
}

export async function listMessages(
  userId: string,
  conversationId: string,
  limit = 80,
): Promise<ChatMessage[]> {
  const result = await getPool().query(
    `SELECT id, role, content, created_at, metadata FROM messages
     WHERE user_id = $1 AND conversation_id = $2
     ORDER BY created_at DESC LIMIT $3`,
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
    [randomUUID(), input.userId, input.step, JSON.stringify(input.question), input.modelName],
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
  await ensureUser(userId);
  const result = await getPool().query(`SELECT settings FROM users WHERE id = $1`, [userId]);
  return result.rows[0]?.settings ?? {};
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
    | "memory_embedding";
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
    [id, input.userId, input.type, JSON.stringify(input.payload), input.idempotencyKey ?? null],
  );
  return result.rows[0].id;
}

export async function claimJob(): Promise<any | null> {
  return withTransaction(async (client) => {
    const result = await client.query(
      `SELECT * FROM jobs
       WHERE status = 'pending' AND run_after <= now()
       ORDER BY created_at
       FOR UPDATE SKIP LOCKED LIMIT 1`,
    );
    if (!result.rowCount) return null;
    const job = result.rows[0];
    await client.query(
      `UPDATE jobs SET status = 'running', attempts = attempts + 1, started_at = now()
       WHERE id = $1`,
      [job.id],
    );
    return job;
  });
}

export async function completeJob(jobId: string): Promise<void> {
  await getPool().query(
    `UPDATE jobs SET status = 'completed', completed_at = now() WHERE id = $1`,
    [jobId],
  );
}

export async function failJob(job: any, error: unknown): Promise<void> {
  const terminal = Number(job.attempts ?? 0) + 1 >= 3;
  const seconds = Math.min(60, 2 ** Math.max(1, Number(job.attempts ?? 1)));
  await getPool().query(
    `UPDATE jobs SET status = $2, last_error = $3,
       run_after = CASE WHEN $2 = 'pending' THEN now() + make_interval(secs => $4) ELSE run_after END
     WHERE id = $1`,
    [job.id, terminal ? "failed" : "pending", error instanceof Error ? error.message : String(error), seconds],
  );
}

export type MemorySearchContext = {
  conversationId?: string;
  projectId?: string;
  includePending?: boolean;
  recordUsage?: boolean;
};

const memorySelectColumns = `m.id, mv.id AS version_id, mv.category, mv.content, mv.tier,
  mv.confidence, mv.valid_until, mv.reason, mv.created_at, mv.status,
  mv.source_type, mv.scope, mv.scope_key, mv.sensitivity, mv.importance,
  mv.memory_kind, mv.evidence_quote, mv.last_confirmed_at, mv.last_used_at`;

export async function listMemoriesForUser(userId: string): Promise<MemoryRecord[]> {
  const result = await getPool().query(
    `SELECT ${memorySelectColumns}
     FROM memories m
     JOIN memory_versions mv ON mv.memory_id = m.id
     WHERE m.user_id = $1
       AND mv.status IN ('active', 'pending')
       AND (mv.valid_until IS NULL OR mv.valid_until > now())
     ORDER BY CASE WHEN mv.status = 'pending' THEN 0 ELSE 1 END, mv.created_at DESC
     LIMIT 100`,
    [userId],
  );
  return result.rows.map(mapMemoryRow);
}

export async function getActiveMemories(
  userId: string,
  context: MemorySearchContext = {},
): Promise<MemoryRecord[]> {
  const result = await getPool().query(
    `SELECT ${memorySelectColumns}
     FROM memories m
     JOIN memory_versions mv ON mv.memory_id = m.id
     JOIN users u ON u.id = m.user_id
     WHERE m.user_id = $1
       AND (u.settings->>'memoryEnabled')::boolean = true
       AND mv.is_active = true
       AND mv.status = 'active'
       AND (mv.valid_until IS NULL OR mv.valid_until > now())
       AND (
         (COALESCE((u.settings->>'longTermMemoryEnabled')::boolean, true) = true AND mv.tier = 'long'
           AND (mv.scope = 'user' OR (mv.scope = 'project' AND mv.scope_key = $3)))
         OR (COALESCE((u.settings->>'shortTermMemoryEnabled')::boolean, true) = true
             AND mv.tier = 'short' AND mv.memory_kind = 'episode'
             AND mv.scope = 'conversation' AND mv.scope_key = $2)
       )
     ORDER BY mv.confidence DESC, mv.created_at DESC LIMIT 100`,
    [userId, context.conversationId ?? null, context.projectId ?? null],
  );
  return result.rows.map(mapMemoryRow);
}

export async function searchMemories(
  userId: string,
  query: string,
  limit = 8,
  queryEmbedding?: number[],
  context: MemorySearchContext = {},
): Promise<MemoryRecord[]> {
  if (queryEmbedding?.length === 1024) {
    const vector = `[${queryEmbedding.join(",")}]`;
    const result = await getPool().query(
      `SELECT ${memorySelectColumns},
              1 - (mv.embedding_v2 <=> $2::vector) AS similarity
       FROM memories m
       JOIN memory_versions mv ON mv.memory_id = m.id
       JOIN users u ON u.id = m.user_id
       WHERE m.user_id = $1
         AND (u.settings->>'memoryEnabled')::boolean = true
         AND (mv.status = 'active' OR ($5::boolean = true AND mv.status = 'pending'))
         AND (mv.is_active = true OR ($5::boolean = true AND mv.status = 'pending'))
         AND (mv.valid_until IS NULL OR mv.valid_until > now())
         AND mv.embedding_v2 IS NOT NULL
         AND (
           (COALESCE((u.settings->>'longTermMemoryEnabled')::boolean, true) = true AND mv.tier = 'long'
             AND (mv.scope = 'user' OR (mv.scope = 'project' AND mv.scope_key = $4)))
           OR (COALESCE((u.settings->>'shortTermMemoryEnabled')::boolean, true) = true
               AND mv.tier = 'short' AND mv.memory_kind = 'episode'
               AND mv.scope = 'conversation' AND mv.scope_key = $3)
         )
       ORDER BY mv.embedding_v2 <=> $2::vector LIMIT 32`,
      [userId, vector, context.conversationId ?? null, context.projectId ?? null, context.includePending === true],
    );
    if (result.rowCount) {
      const memories = rankHybridMemories(result.rows, query, limit);
      if (context.recordUsage) await recordMemoryUsage(userId, memories);
      return memories;
    }
  }
  const candidates = context.includePending
    ? (await listMemoriesForUser(userId)).filter((memory) => {
        if (memory.status === "pending") {
          return memory.tier === "long" && (
            memory.scope === "user"
            || (memory.scope === "project" && Boolean(context.projectId) && memory.scopeKey === context.projectId)
          );
        }
        return memoryIsRecallable(memory, context);
      })
    : await getActiveMemories(userId, context);
  const memories = rankMemories(candidates, query, limit);
  if (context.recordUsage) await recordMemoryUsage(userId, memories);
  return memories;
}

async function recordMemoryUsage(userId: string, memories: MemoryRecord[]) {
  if (!memories.length) return;
  const versionIds = memories.map((memory) => memory.versionId);
  await getPool().query(
    `UPDATE memory_versions SET last_used_at = now()
     WHERE user_id = $1 AND id = ANY($2::uuid[]) AND status = 'active'`,
    [userId, versionIds],
  );
  for (const memory of memories) {
    await getPool().query(
      `INSERT INTO memory_events
        (id, user_id, memory_id, version_id, event_type, content_hash, payload)
       VALUES ($1, $2, $3, $4, 'used', $5, $6::jsonb)`,
      [randomUUID(), userId, memory.id, memory.versionId, createHash("sha256").update(memory.content).digest("hex"), JSON.stringify({ tier: memory.tier, kind: memory.kind, scope: memory.scope })],
    );
  }
}

function rankHybridMemories(rows: any[], query: string, limit: number): MemoryRecord[] {
  const terms = query.replace(/[，。！？,.!?]/g, " ").split(/\s+/).filter((term) => term.length >= 2).slice(0, 12);
  const now = Date.now();
  return rows.map((row) => {
    const lexical = terms.length
      ? terms.filter((term) => String(row.content).includes(term)).length / terms.length
      : 0;
    const ageDays = Math.max(0, (now - new Date(row.created_at).getTime()) / 86_400_000);
    const freshness = Math.exp(-ageDays / 90);
    const confirmationAgeDays = row.last_confirmed_at
      ? Math.max(0, (now - new Date(row.last_confirmed_at).getTime()) / 86_400_000)
      : 365;
    const confirmationFreshness = Math.exp(-confirmationAgeDays / 180);
    const sourceBoost = row.source_type === "explicit" ? 0.08 : row.source_type === "confirmed" ? 0.06 : 0;
    const score = Number(row.similarity) * 0.5 + lexical * 0.16 + Number(row.confidence) * 0.14 + freshness * 0.08 + confirmationFreshness * 0.04 + Number(row.importance ?? 0.5) * 0.03 + sourceBoost + (row.tier === "long" ? 0.05 : 0);
    return { row, score };
  }).sort((a, b) => b.score - a.score).slice(0, limit).map(({ row }) => ({
    ...mapMemoryRow(row),
  }));
}

export function rankMemories(
  memories: MemoryRecord[],
  query: string,
  limit = 8,
): MemoryRecord[] {
  const terms = query
    .replace(/[，。！？,.!?]/g, " ")
    .split(/\s+/)
    .filter((term) => term.length >= 2)
    .slice(0, 8);
  return memories
    .map((memory) => ({
      memory,
      score:
        memory.confidence * 2 +
        (memory.tier === "long" ? 0.35 : 0) +
        (memory.sourceType === "explicit" ? 0.22 : memory.sourceType === "confirmed" ? 0.16 : 0) +
        (memory.importance ?? 0.5) * 0.18 +
        terms.reduce(
          (sum, term) => sum + (memory.content.includes(term) ? 1 : 0),
          0,
        ),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ memory }) => memory);
}

export async function getLatestProfile(
  userId: string,
): Promise<ProfileSnapshot | null> {
  const result = await getPool().query(
    `SELECT * FROM profile_snapshots WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [userId],
  );
  if (!result.rowCount) return null;
  const row = result.rows[0];
  return {
    id: row.id,
    summary: row.summary,
    dimensionWeights: row.dimension_weights,
    understanding: row.understanding_components,
    score: row.understanding_score,
    createdAt: row.created_at,
  };
}

export async function getProfileForContext(
  userId: string,
): Promise<ProfileSnapshot | null> {
  const settings = await getPool().query(`SELECT settings FROM users WHERE id = $1`, [
    userId,
  ]);
  if (settings.rows[0]?.settings?.memoryEnabled === false || settings.rows[0]?.settings?.longTermMemoryEnabled === false) return null;
  return getLatestProfile(userId);
}

export async function commitProfileSnapshot(input: {
  userId: string;
  summary: string;
  dimensionWeights: Record<string, number>;
}) {
  const memories = await getActiveMemories(input.userId);
  const feedback = await getPool().query(
    `SELECT
      count(*) FILTER (WHERE value = 'understood')::int AS positive,
      count(*) FILTER (WHERE value = 'not-me')::int AS negative
     FROM feedback WHERE user_id = $1`,
    [input.userId],
  );
  const corrected = await getPool().query(
    `SELECT count(*)::int AS count FROM memory_versions
     WHERE user_id = $1 AND is_active = false`,
    [input.userId],
  );
  const components = deriveUnderstandingComponents({
    memories,
    dimensionWeights: input.dimensionWeights,
    positiveFeedback: feedback.rows[0]?.positive ?? 0,
    negativeFeedback: feedback.rows[0]?.negative ?? 0,
    correctedMemories: corrected.rows[0]?.count ?? 0,
  });
  const score = calculateUnderstandingScore(components);
  const result = await getPool().query(
    `INSERT INTO profile_snapshots
      (id, user_id, summary, dimension_weights, understanding_components, understanding_score)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6) RETURNING *`,
    [
      randomUUID(),
      input.userId,
      input.summary,
      JSON.stringify(input.dimensionWeights),
      JSON.stringify(components),
      score,
    ],
  );
  return result.rows[0];
}

export async function getConversationSummary(
  userId: string,
  conversationId: string,
): Promise<string | null> {
  const result = await getPool().query(
    `SELECT cs.summary FROM conversation_summaries cs
     JOIN users u ON u.id = cs.user_id
     WHERE cs.user_id = $1 AND cs.conversation_id = $2
       AND (u.settings->>'memoryEnabled')::boolean = true
       AND COALESCE((u.settings->>'shortTermMemoryEnabled')::boolean, true) = true
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
  projectId?: string;
  sourceMessageId: string;
  reflection: ReflectionOutput;
  embeddings?: Array<number[] | null>;
}): Promise<{ memoryCount: number; profile: ProfileSnapshot | null }> {
  return withTransaction(async (client) => {
    const sourceResult = await client.query(
      `SELECT content FROM messages
       WHERE id = $1 AND user_id = $2 AND conversation_id = $3 AND role = 'user'`,
      [input.sourceMessageId, input.userId, input.conversationId],
    );
    if (!sourceResult.rowCount) throw new Error("记忆来源消息不存在或不属于当前用户");
    const sourceText = String(sourceResult.rows[0].content);
    const settingsResult = await client.query(`SELECT settings FROM users WHERE id = $1`, [
      input.userId,
    ]);
    const settings = settingsResult.rows[0]?.settings ?? {};
    const memoryEnabled = settings.memoryEnabled !== false;
    const shortTermMemoryEnabled = memoryEnabled && settings.shortTermMemoryEnabled !== false;
    const longTermMemoryEnabled = memoryEnabled && settings.longTermMemoryEnabled !== false;
    const mutations = input.reflection.memories
      .map((rawMutation, mutationIndex) => ({ rawMutation, mutationIndex }))
      .filter(({ rawMutation }) => rawMutation.tier === "short" ? shortTermMemoryEnabled : longTermMemoryEnabled);

    for (const { rawMutation, mutationIndex } of mutations) {
      const evidenceError = validateMemoryEvidence(rawMutation, {
        sourceMessageId: input.sourceMessageId,
        sourceText,
      });
      if (evidenceError) throw new Error(`记忆证据无效：${evidenceError}`);
      const mutation = normalizeMemoryMutation(rawMutation, {
        conversationId: input.conversationId,
        projectId: input.projectId,
      });
      const evidenceResult = await client.query(
        `SELECT count(*)::int AS count FROM messages
         WHERE id = ANY($1::uuid[]) AND user_id = $2 AND conversation_id = $3`,
        [mutation.evidenceMessageIds, input.userId, input.conversationId],
      );
      if (Number(evidenceResult.rows[0]?.count ?? 0) !== mutation.evidenceMessageIds.length) {
        throw new Error("记忆证据不属于当前用户或当前对话");
      }
      const memoryId = mutation.memoryId ?? randomUUID();
      if (mutation.memoryId) {
        const existing = await client.query(
          `SELECT id FROM memories WHERE id = $1 AND user_id = $2 FOR UPDATE`,
          [memoryId, input.userId],
        );
        if (!existing.rowCount) throw new Error("要更新的记忆不存在或不属于当前用户");
        await client.query(
          `UPDATE memory_versions SET is_active = false, status = 'superseded'
           WHERE memory_id = $1 AND user_id = $2
             AND (status = 'pending' OR ($3::boolean = true AND status = 'active'))`,
          [memoryId, input.userId, mutation.status === "active"],
        );
      } else {
        await client.query(
          `INSERT INTO memories (id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [memoryId, input.userId],
        );
      }
      const versionId = randomUUID();
      const confirmedAt = mutation.sourceType === "explicit" || mutation.sourceType === "confirmed"
        ? new Date().toISOString()
        : null;
      await client.query(
        `INSERT INTO memory_versions
          (id, memory_id, user_id, category, content, tier, confidence, valid_until, reason,
           embedding_v2, source_type, scope, scope_key, sensitivity, importance, memory_kind,
           evidence_quote, last_confirmed_at, is_active, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::vector,
                 $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)`,
        [
          versionId,
          memoryId,
          input.userId,
          mutation.category,
          mutation.content,
          mutation.tier,
          mutation.confidence,
          mutation.validUntil,
          mutation.reason,
          input.embeddings?.[mutationIndex]?.length === 1024
            ? `[${input.embeddings[mutationIndex]!.join(",")}]`
            : null,
          mutation.sourceType,
          mutation.scope,
          mutation.scopeKey,
          mutation.sensitivity,
          mutation.importance,
          mutation.kind,
          mutation.evidenceQuote ?? null,
          confirmedAt,
          mutation.status === "active",
          mutation.status,
        ],
      );
      for (const evidenceId of mutation.evidenceMessageIds) {
        await client.query(
          `INSERT INTO memory_evidence (memory_version_id, message_id, user_id)
           VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [versionId, evidenceId, input.userId],
        );
      }
      await recordMemoryEvent(client, {
        userId: input.userId,
        memoryId,
        versionId,
        eventType: mutation.operation === "promote" ? "promoted" : mutation.memoryId ? "superseded" : "created",
        content: mutation.content,
        payload: {
          category: mutation.category,
          operation: mutation.operation,
          sourceType: mutation.sourceType,
          scope: mutation.scope,
          scopeKey: mutation.scopeKey,
          kind: mutation.kind,
          status: mutation.status,
          sensitivity: mutation.sensitivity,
          importance: mutation.importance,
        },
      });
    }

    if (shortTermMemoryEnabled && input.reflection.summaryChanged !== false) {
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

    if (input.reflection.mood?.meaningful) {
      if (settings.emotionTrackingEnabled !== false) {
        await client.query(
          `INSERT INTO mood_samples (id, user_id, conversation_id, message_id, score, summary)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            randomUUID(),
            input.userId,
            input.conversationId,
            input.sourceMessageId,
            input.reflection.mood.score,
            input.reflection.mood.summary,
          ],
        );
      }
    }

    let profile: ProfileSnapshot | null = null;
    if (longTermMemoryEnabled && input.reflection.profileChanged !== false) {
      const memoriesResult = await client.query(
      `SELECT ${memorySelectColumns}
       FROM memories m JOIN memory_versions mv ON mv.memory_id = m.id
       WHERE m.user_id = $1 AND mv.is_active = true AND mv.status = 'active'
         AND mv.tier = 'long' AND mv.scope = 'user'`,
      [input.userId],
    );
      const memories: MemoryRecord[] = memoriesResult.rows.map(mapMemoryRow);
      const feedback = await client.query(
      `SELECT
        count(*) FILTER (WHERE value = 'understood')::int AS positive,
        count(*) FILTER (WHERE value = 'not-me')::int AS negative
       FROM feedback WHERE user_id = $1`,
      [input.userId],
    );
      const corrected = await client.query(
      `SELECT count(*)::int AS count FROM memory_versions mv
       WHERE mv.user_id = $1 AND mv.is_active = false`,
      [input.userId],
    );
      const components = deriveUnderstandingComponents({
      memories,
      dimensionWeights: input.reflection.dimensionWeights,
      positiveFeedback: feedback.rows[0]?.positive ?? 0,
      negativeFeedback: feedback.rows[0]?.negative ?? 0,
      correctedMemories: corrected.rows[0]?.count ?? 0,
    });
      const score = calculateUnderstandingScore(components);
      const profileId = randomUUID();
      const profileResult = await client.query(
      `INSERT INTO profile_snapshots
        (id, user_id, summary, dimension_weights, understanding_components, understanding_score)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6) RETURNING *`,
      [
        profileId,
        input.userId,
        input.reflection.profileSummary,
        JSON.stringify(input.reflection.dimensionWeights),
        JSON.stringify(components),
        score,
      ],
      );
      const row = profileResult.rows[0];
      profile = {
        id: row.id,
        summary: row.summary,
        dimensionWeights: row.dimension_weights,
        understanding: row.understanding_components,
        score: row.understanding_score,
        createdAt: row.created_at,
      };
    }

    if (input.reflection.returnNote && settings.returnNotesEnabled !== false) {
      await client.query(
        `INSERT INTO return_notes
          (id, user_id, conversation_id, content, valid_after, expires_at)
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
    return {
      memoryCount: mutations.length,
      profile,
    };
  });
}

export async function publishPersonalSkill(input: {
  userId: string;
  skill: PersonalSkill;
  source: "model" | "developer_restore";
}) {
  return withTransaction(async (client) => {
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
  });
}

export async function restorePersonalSkill(
  userId: string,
  versionId: string,
) {
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

export async function updateMemory(input: {
  userId: string;
  memoryId: string;
  content: string;
  category?: string;
  tier?: "short" | "long";
  validUntil?: string | null;
  reason?: string;
}) {
  return withTransaction(async (client) => {
    const currentResult = await client.query(
      `SELECT m.id AS memory_id, mv.id AS version_id, mv.* FROM memories m
       JOIN memory_versions mv ON mv.memory_id = m.id
       WHERE m.id = $1 AND m.user_id = $2 AND mv.status IN ('pending', 'active')
       ORDER BY CASE WHEN mv.status = 'pending' THEN 0 ELSE 1 END, mv.created_at DESC
       LIMIT 1 FOR UPDATE`,
      [input.memoryId, input.userId],
    );
    if (!currentResult.rowCount) throw new Error("找不到可编辑的记忆");
    const current = currentResult.rows[0];
    const versionId = randomUUID();
    const tier = input.tier ?? current.tier;
    if (tier === "short" && !current.scope_key) throw new Error("短期记忆必须绑定原会话");
    const kind = tier === "short"
      ? "episode"
      : inferMemoryKind(input.content, current.memory_kind === "episode" ? undefined : current.memory_kind);
    const scope = tier === "short" ? "conversation" : current.scope === "project" ? "project" : "user";
    const scopeKey = scope === "user" ? null : current.scope_key;
    const validUntil = tier === "short"
      ? (input.validUntil === undefined ? current.valid_until : input.validUntil)
      : (input.validUntil === undefined ? current.valid_until : input.validUntil);
    await client.query(
      `UPDATE memory_versions SET is_active = false, status = 'superseded'
       WHERE memory_id = $1 AND user_id = $2 AND status IN ('pending', 'active')`,
      [input.memoryId, input.userId],
    );
    await recordMemoryEvent(client, {
      userId: input.userId,
      memoryId: input.memoryId,
      versionId: current.version_id,
      eventType: "superseded",
      content: current.content,
      payload: { reason: "用户编辑生成了新的确认版本" },
    });
    const result = await client.query(
      `INSERT INTO memory_versions
        (id, memory_id, user_id, category, content, tier, confidence, valid_until, reason,
         embedding_v2, source_type, scope, scope_key, sensitivity, importance, memory_kind,
         evidence_quote, last_confirmed_at, is_active, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL,
               'confirmed', $10, $11, $12, $13, $14, $15, now(), true, 'active')
       RETURNING *`,
      [
        versionId,
        input.memoryId,
        input.userId,
        input.category ?? current.category,
        input.content.trim(),
        tier,
        1,
        validUntil,
        input.reason ?? "用户主动修改了这条认识",
        scope,
        scopeKey,
        current.sensitivity ?? "normal",
        Number(current.importance ?? 0.5),
        kind,
        "用户编辑后的确认内容",
      ],
    );
    const row = result.rows[0];
    await recordMemoryEvent(client, {
      userId: input.userId,
      memoryId: input.memoryId,
      versionId,
      eventType: "updated",
      content: input.content,
      payload: { category: row.category, tier: row.tier, sourceType: "confirmed" },
    });
    return mapMemoryRow({ ...row, id: input.memoryId, version_id: versionId });
  });
}

export async function confirmMemory(input: { userId: string; memoryId: string }) {
  return withTransaction(async (client) => {
    const candidate = await client.query(
      `SELECT mv.* FROM memories m JOIN memory_versions mv ON mv.memory_id = m.id
       WHERE m.id = $1 AND m.user_id = $2 AND mv.status IN ('pending', 'active')
       ORDER BY CASE WHEN mv.status = 'pending' THEN 0 ELSE 1 END, mv.created_at DESC
       LIMIT 1 FOR UPDATE`,
      [input.memoryId, input.userId],
    );
    if (!candidate.rowCount) throw new Error("找不到可确认的记忆");
    const row = candidate.rows[0];
    if (row.status === "pending") {
      await client.query(
        `UPDATE memory_versions SET is_active = false, status = 'superseded'
         WHERE memory_id = $1 AND user_id = $2 AND status = 'active'`,
        [input.memoryId, input.userId],
      );
    }
    const result = await client.query(
      `UPDATE memory_versions
       SET source_type = 'confirmed', last_confirmed_at = now(), is_active = true, status = 'active'
       WHERE id = $1 AND user_id = $2 RETURNING *`,
      [row.id, input.userId],
    );
    const confirmed = result.rows[0];
    await recordMemoryEvent(client, {
      userId: input.userId,
      memoryId: input.memoryId,
      versionId: confirmed.id,
      eventType: "confirmed",
      content: confirmed.content,
      payload: { sourceType: "confirmed" },
    });
    return mapMemoryRow({ ...confirmed, id: input.memoryId, version_id: confirmed.id });
  });
}

export async function withdrawMemory(input: {
  userId: string;
  memoryId: string;
  reason?: string;
}) {
  return withTransaction(async (client) => {
    const current = await client.query(
      `SELECT mv.id, mv.category, mv.content FROM memories m
       JOIN memory_versions mv ON mv.memory_id = m.id
       WHERE m.id = $1 AND m.user_id = $2 AND mv.status IN ('pending', 'active')
       ORDER BY CASE WHEN mv.status = 'pending' THEN 0 ELSE 1 END, mv.created_at DESC
       LIMIT 1 FOR UPDATE`,
      [input.memoryId, input.userId],
    );
    if (!current.rowCount) throw new Error("找不到可撤回的活动记忆");
    const row = current.rows[0];
    await client.query(
      `UPDATE memory_versions SET is_active = false, status = 'withdrawn'
       WHERE memory_id = $1 AND user_id = $2 AND status IN ('pending', 'active')`,
      [input.memoryId, input.userId],
    );
    const withdrawalId = randomUUID();
    await client.query(
      `INSERT INTO memory_withdrawals
        (id, user_id, memory_id, category, content_hash, reason)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        withdrawalId,
        input.userId,
        input.memoryId,
        row.category,
        createHash("sha256").update(row.content).digest("hex"),
        input.reason ?? "用户在画像界面主动撤回",
      ],
    );
    await recordMemoryEvent(client, {
      userId: input.userId,
      memoryId: input.memoryId,
      versionId: row.id,
      eventType: "withdrawn",
      content: row.content,
      payload: { category: row.category, reason: input.reason ?? "用户在画像界面主动撤回" },
    });
    return { withdrawalId, memoryId: input.memoryId, category: row.category };
  });
}

export async function deleteAllUserData(userId: string): Promise<void> {
  await withTransaction(async (client) => {
    const tables = [
      "message_sources",
      "onboarding_question_plans",
      "benchmark_preferences",
      "benchmark_outputs",
      "benchmark_runs",
      "risk_events",
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
      [id, input.userId, input.prompt, input.scenario, input.adapterId, input.modelName ?? null, input.transport ?? null],
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
    [randomUUID(), input.userId, input.preferredMode, input.reason ?? null, input.runId],
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
  return { runs: runs.rows, risks: risks.rows, withdrawals: withdrawals.rows, conversations };
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
  requestId?: string;
  retries?: number;
  fallbackFrom?: string;
  errorCode?: string;
  thinking?: boolean;
  sources?: ModelSource[];
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
       retries, fallback_from, error_code, thinking, sources, prompt_version, transport)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
       $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25::jsonb, $26, $27)`,
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
    requestId: input.meta.requestId,
    retries: input.meta.retries,
    fallbackFrom: input.meta.fallbackFrom,
    thinking: input.meta.thinking,
    sources: input.meta.sources,
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
      [randomUUID(), input.messageId, input.userId, source.title, source.url, source.siteName ?? null],
    );
  }
}

export async function getModelCostData(userId: string) {
  const [runs, totals, pricing] = await Promise.all([
    getPool().query(`SELECT * FROM model_runs WHERE user_id = $1 ORDER BY created_at DESC LIMIT 200`, [userId]),
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
    [randomUUID(), input.modelName, input.provider, JSON.stringify(input.prices), JSON.stringify(input.capabilities ?? []), input.contextWindow ?? null, input.requestId ?? null],
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

export async function getDeveloperData(userId: string) {
  const [traces, memories, profiles, skills, mcpCalls, modelRuns] = await Promise.all([
    getPool().query(
      `SELECT * FROM trace_events WHERE user_id = $1 ORDER BY created_at DESC LIMIT 160`,
      [userId],
    ),
    getPool().query(
      `SELECT m.id AS memory_id, mv.*, COALESCE(json_agg(me.message_id)
        FILTER (WHERE me.message_id IS NOT NULL), '[]') AS evidence_ids
       FROM memories m JOIN memory_versions mv ON mv.memory_id = m.id
       LEFT JOIN memory_evidence me ON me.memory_version_id = mv.id
       WHERE m.user_id = $1 GROUP BY m.id, mv.id ORDER BY mv.created_at DESC`,
      [userId],
    ),
    getPool().query(
      `SELECT * FROM profile_snapshots WHERE user_id = $1 ORDER BY created_at DESC LIMIT 60`,
      [userId],
    ),
    getPool().query(
      `SELECT * FROM personal_skill_versions WHERE user_id = $1 ORDER BY version DESC`,
      [userId],
    ),
    getPool().query(
      `SELECT * FROM mcp_calls WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [userId],
    ),
    getPool().query(
      `SELECT * FROM model_runs WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [userId],
    ),
  ]);
  return {
    traces: traces.rows,
    memories: memories.rows,
    profiles: profiles.rows,
    skills: skills.rows,
    mcpCalls: mcpCalls.rows,
    modelRuns: modelRuns.rows,
  };
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

function mapMessage(row: any): ChatMessage {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
    metadata: row.metadata ?? {},
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
    validUntil: row.valid_until,
    reason: row.reason,
    status: row.status,
    kind: row.memory_kind,
    sourceType: row.source_type,
    scope: row.scope,
    scopeKey: row.scope_key ?? null,
    sensitivity: row.sensitivity,
    importance: row.importance == null ? undefined : Number(row.importance),
    evidenceQuote: row.evidence_quote ?? null,
    lastConfirmedAt: row.last_confirmed_at ?? null,
    lastUsedAt: row.last_used_at ?? null,
    createdAt: row.created_at,
  };
}

async function recordMemoryEvent(
  client: Pick<PoolClient, "query">,
  input: {
    userId: string;
    memoryId?: string;
    versionId?: string;
    eventType: "created" | "updated" | "confirmed" | "promoted" | "superseded" | "withdrawn" | "expired" | "used";
    content?: string;
    payload?: Record<string, unknown>;
  },
) {
  await client.query(
    `INSERT INTO memory_events
      (id, user_id, memory_id, version_id, event_type, content_hash, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      randomUUID(),
      input.userId,
      input.memoryId ?? null,
      input.versionId ?? null,
      input.eventType,
      input.content ? createHash("sha256").update(input.content).digest("hex") : null,
      JSON.stringify(input.payload ?? {}),
    ],
  );
}
