import { createHash, randomUUID } from "node:crypto";
import { diffJson } from "diff";
import type { PoolClient } from "pg";
import { getPool, withTransaction } from "./db";
import { defaultPersonalSkill } from "./personal-skill";
import {
  calculateUnderstandingScore,
  deriveUnderstandingComponents,
} from "./score";
import type {
  ChatMessage,
  ConversationSummaryRecord,
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
    getActiveMemories(userId),
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
      COALESCE((SELECT json_agg(m ORDER BY m.sequence_no)
        FROM (SELECT id, role, content, created_at, sequence_no, edited_at, edit_count, metadata
              FROM messages WHERE conversation_id = c.id ORDER BY sequence_no DESC LIMIT 80) m), '[]') AS messages
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
    historyRevision: Number(row.history_revision ?? 0),
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
  return withTransaction(async (client) => {
    const sequence = await client.query(
      `UPDATE conversations
       SET next_message_sequence = next_message_sequence + 1, updated_at = now()
       WHERE id = $1 AND user_id = $2
       RETURNING next_message_sequence - 1 AS sequence_no`,
      [input.conversationId, input.userId],
    );
    if (!sequence.rowCount) throw new Error("只能向当前用户自己的对话添加消息");
    const result = await client.query(
      `INSERT INTO messages
        (id, conversation_id, user_id, role, content, metadata, sequence_no)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7) RETURNING *`,
      [
        id,
        input.conversationId,
        input.userId,
        input.role,
        input.content,
        JSON.stringify(input.metadata ?? {}),
        sequence.rows[0].sequence_no,
      ],
    );
    return mapMessage(result.rows[0]);
  });
}

export async function addUserMessage(input: {
  conversationId: string;
  userId: string;
  content: string;
  metadata?: Record<string, unknown>;
}): Promise<{ message: ChatMessage; historyRevision: number }> {
  return withTransaction(async (client) => {
    const sequence = await client.query(
      `UPDATE conversations
       SET next_message_sequence = next_message_sequence + 1,
           history_revision = history_revision + 1,
           updated_at = now()
       WHERE id = $1 AND user_id = $2
       RETURNING next_message_sequence - 1 AS sequence_no, history_revision`,
      [input.conversationId, input.userId],
    );
    if (!sequence.rowCount) throw new Error("只能向当前用户自己的对话添加消息");
    const result = await client.query(
      `INSERT INTO messages
        (id, conversation_id, user_id, role, content, metadata, sequence_no)
       VALUES ($1, $2, $3, 'user', $4, $5::jsonb, $6) RETURNING *`,
      [
        randomUUID(),
        input.conversationId,
        input.userId,
        input.content,
        JSON.stringify(input.metadata ?? {}),
        sequence.rows[0].sequence_no,
      ],
    );
    return {
      message: mapMessage(result.rows[0]),
      historyRevision: Number(sequence.rows[0].history_revision),
    };
  });
}

export async function updateMessage(input: {
  id: string;
  userId: string;
  content: string;
  metadata: Record<string, unknown>;
}): Promise<ChatMessage> {
  const result = await getPool().query(
    `UPDATE messages
     SET content = $3, metadata = $4::jsonb
     WHERE id = $1 AND user_id = $2
     RETURNING *`,
    [input.id, input.userId, input.content, JSON.stringify(input.metadata)],
  );
  if (!result.rowCount) throw new Error("找不到要更新的消息");
  return mapMessage(result.rows[0]);
}

export class ConversationRevisionConflictError extends Error {
  readonly code = "conversation_revision_conflict";

  constructor() {
    super("对话已经发生变化，请刷新后重试");
  }
}

export type EditMessageResult = {
  message: ChatMessage;
  deletedMessageIds: string[];
  historyRevision: number;
  profileStale: boolean;
  skillStale: boolean;
  shouldRegenerateTitle: boolean;
};

export async function editMessageAndRollback(input: {
  userId: string;
  conversationId: string;
  messageId: string;
  content: string;
  expectedRevision: number;
}): Promise<EditMessageResult> {
  return withTransaction(async (client) => {
    const conversationResult = await client.query(
      `SELECT id, history_revision, title_source, title_locked
       FROM conversations
       WHERE id = $1 AND user_id = $2
       FOR UPDATE`,
      [input.conversationId, input.userId],
    );
    if (!conversationResult.rowCount) throw new Error("这段对话已经不可用，请新建一段对话。");
    const conversation = conversationResult.rows[0];
    if (Number(conversation.history_revision) !== input.expectedRevision) {
      throw new ConversationRevisionConflictError();
    }

    const messageResult = await client.query(
      `SELECT * FROM messages
       WHERE id = $1 AND conversation_id = $2 AND user_id = $3
       FOR UPDATE`,
      [input.messageId, input.conversationId, input.userId],
    );
    if (!messageResult.rowCount) throw new Error("找不到要编辑的消息");
    const target = messageResult.rows[0];
    if (target.role !== "user") throw new Error("只能编辑自己发送的消息");

    const rollbackMessages = await client.query(
      `SELECT id FROM messages
       WHERE conversation_id = $1 AND user_id = $2 AND sequence_no >= $3
       ORDER BY sequence_no`,
      [input.conversationId, input.userId, target.sequence_no],
    );
    const rollbackMessageIds = rollbackMessages.rows.map((row) => row.id as string);
    const deletedMessageIds = rollbackMessageIds.filter((id) => id !== input.messageId);

    const affectedMemories = await client.query(
      `SELECT DISTINCT memory_id, id AS version_id
       FROM memory_versions
       WHERE user_id = $1 AND source_conversation_id = $2
         AND source_message_sequence >= $3`,
      [input.userId, input.conversationId, target.sequence_no],
    );
    const affectedMemoryIds = [...new Set(affectedMemories.rows.map((row) => row.memory_id as string))];
    const affectedVersionIds = affectedMemories.rows.map((row) => row.version_id as string);
    const evidenceAffected = await client.query(
      `SELECT DISTINCT version.memory_id, version.id AS version_id
       FROM memory_evidence evidence
       JOIN memory_versions version ON version.id = evidence.memory_version_id
       WHERE evidence.user_id = $1 AND evidence.message_id = ANY($2::uuid[])`,
      [input.userId, rollbackMessageIds],
    );
    for (const row of evidenceAffected.rows) affectedMemoryIds.push(row.memory_id as string);
    const uniqueAffectedMemoryIds = [...new Set(affectedMemoryIds)];
    const evidenceAffectedVersionIds = evidenceAffected.rows.map((row) => row.version_id as string);

    const skillResult = await client.query(
      `SELECT id FROM personal_skill_versions
       WHERE user_id = $1 AND is_active = true
         AND (
           (source_conversation_id = $2 AND source_message_sequence >= $3)
           OR evidence_message_ids && $4::uuid[]
         )
       LIMIT 1`,
      [input.userId, input.conversationId, target.sequence_no, rollbackMessageIds],
    );
    const skillStale = Boolean(skillResult.rowCount);
    if (skillStale) {
      await client.query(
        `UPDATE personal_skill_versions SET is_active = false
         WHERE user_id = $1 AND is_active = true`,
        [input.userId],
      );
      await client.query(
        `UPDATE personal_skill_versions SET is_active = true
         WHERE id = (
           SELECT id FROM personal_skill_versions
           WHERE user_id = $1 AND id <> $2
           ORDER BY version DESC LIMIT 1
         )`,
        [input.userId, skillResult.rows[0]?.id ?? null],
      );
    }

    await client.query(
      `UPDATE jobs SET status = 'cancelled', completed_at = now()
       WHERE user_id = $1 AND status = 'pending'
         AND (
           (payload->>'conversationId' = $2
             AND COALESCE((payload->>'historyRevision')::bigint, 0) <= $3)
           OR payload->>'messageId' = ANY($4::text[])
           OR EXISTS (
             SELECT 1 FROM jsonb_array_elements_text(COALESCE(payload->'evidenceIds', '[]'::jsonb)) evidence
             WHERE evidence = ANY($4::text[])
           )
         )`,
      [input.userId, input.conversationId, input.expectedRevision, rollbackMessageIds],
    );

    await client.query(
      `DELETE FROM memory_evidence
       WHERE user_id = $1
         AND (message_id = ANY($2::uuid[]) OR memory_version_id = ANY($3::uuid[]))`,
      [input.userId, rollbackMessageIds, affectedVersionIds],
    );
    await client.query(
      `DELETE FROM memory_versions
       WHERE user_id = $1 AND id = ANY($2::uuid[])`,
      [input.userId, affectedVersionIds],
    );

    if (uniqueAffectedMemoryIds.length) {
      await client.query(
        `WITH candidates AS (
           SELECT DISTINCT ON (memory_id) id
           FROM memory_versions
           WHERE user_id = $1 AND memory_id = ANY($2::uuid[])
             AND status <> 'withdrawn'
           ORDER BY memory_id, created_at DESC
         )
         UPDATE memory_versions version
         SET is_active = true, status = 'active'
         FROM candidates
         WHERE version.id = candidates.id
           AND NOT EXISTS (
             SELECT 1 FROM memory_versions active
             WHERE active.memory_id = version.memory_id AND active.is_active = true
           )`,
        [input.userId, uniqueAffectedMemoryIds],
      );
      await client.query(
        `UPDATE memory_versions
         SET first_observed_at = NULL, last_confirmed_at = NULL
         WHERE user_id = $1 AND id = ANY($2::uuid[])`,
        [input.userId, evidenceAffectedVersionIds],
      );
      await client.query(
        `UPDATE memory_versions version
         SET first_observed_at = evidence.first_observed_at,
             last_confirmed_at = evidence.last_confirmed_at
         FROM (
           SELECT link.memory_version_id,
                  min(message.created_at) AS first_observed_at,
                  max(message.created_at) AS last_confirmed_at
           FROM memory_evidence link
           JOIN messages message ON message.id = link.message_id
           WHERE link.user_id = $1
           GROUP BY link.memory_version_id
         ) evidence
         WHERE version.id = evidence.memory_version_id
           AND version.memory_id = ANY($2::uuid[])`,
        [input.userId, uniqueAffectedMemoryIds],
      );
      await client.query(
        `DELETE FROM memories memory
         WHERE memory.user_id = $1 AND memory.id = ANY($2::uuid[])
           AND NOT EXISTS (SELECT 1 FROM memory_versions version WHERE version.memory_id = memory.id)`,
        [input.userId, uniqueAffectedMemoryIds],
      );
    }

    await client.query(
      `DELETE FROM conversation_summaries summary
       USING messages source
       WHERE summary.user_id = $1 AND summary.conversation_id = $2
         AND summary.source_message_id = source.id AND source.sequence_no >= $3`,
      [input.userId, input.conversationId, target.sequence_no],
    );
    await client.query(
      `DELETE FROM mood_samples mood
       USING messages source
       WHERE mood.user_id = $1 AND mood.conversation_id = $2
         AND mood.message_id = source.id AND source.sequence_no >= $3`,
      [input.userId, input.conversationId, target.sequence_no],
    );
    await client.query(
      `DELETE FROM return_notes
       WHERE user_id = $1 AND conversation_id = $2
         AND COALESCE(source_message_sequence, $3) >= $3`,
      [input.userId, input.conversationId, target.sequence_no],
    );
    await client.query(`DELETE FROM message_sources WHERE user_id = $1 AND message_id = ANY($2::uuid[])`, [input.userId, deletedMessageIds]);
    await client.query(`DELETE FROM feedback WHERE user_id = $1 AND message_id = ANY($2::uuid[])`, [input.userId, rollbackMessageIds]);
    await client.query(`DELETE FROM risk_events WHERE user_id = $1 AND message_id = ANY($2::uuid[])`, [input.userId, rollbackMessageIds]);
    await client.query(
      `DELETE FROM messages
       WHERE user_id = $1 AND conversation_id = $2 AND sequence_no > $3`,
      [input.userId, input.conversationId, target.sequence_no],
    );

    const updatedMessage = await client.query(
      `UPDATE messages
       SET content = $4, edited_at = now(), edit_count = edit_count + 1,
           metadata = metadata - 'traceId'
       WHERE id = $1 AND conversation_id = $2 AND user_id = $3
       RETURNING *`,
      [input.messageId, input.conversationId, input.userId, input.content],
    );
    const nextRevision = input.expectedRevision + 1;
    const shouldRegenerateTitle = Number(target.sequence_no) === 1 && conversation.title_locked !== true;
    await client.query(
      `UPDATE conversations
       SET history_revision = $3, next_message_sequence = $4, updated_at = now(),
           title = CASE WHEN $5 THEN '新的对话' ELSE title END,
           title_source = CASE WHEN $5 THEN 'default' ELSE title_source END
       WHERE id = $1 AND user_id = $2`,
      [input.conversationId, input.userId, nextRevision, Number(target.sequence_no) + 1, shouldRegenerateTitle],
    );
    await client.query(
      `UPDATE users
       SET profile_stale = profile_stale OR $2,
           skill_stale = skill_stale OR $3,
           updated_at = now()
       WHERE id = $1`,
      [input.userId, affectedVersionIds.length > 0, skillStale],
    );

    return {
      message: mapMessage(updatedMessage.rows[0]),
      deletedMessageIds,
      historyRevision: nextRevision,
      profileStale: affectedVersionIds.length > 0,
      skillStale,
      shouldRegenerateTitle,
    };
  });
}

export async function isConversationRevisionCurrent(input: {
  userId: string;
  conversationId: string;
  messageId?: string;
  historyRevision: number;
}): Promise<boolean> {
  const result = await getPool().query(
    `SELECT 1 FROM conversations conversation
     WHERE conversation.id = $1 AND conversation.user_id = $2
       AND conversation.history_revision = $3
       AND ($4::uuid IS NULL OR EXISTS (
         SELECT 1 FROM messages message
         WHERE message.id = $4 AND message.conversation_id = conversation.id
       ))`,
    [input.conversationId, input.userId, input.historyRevision, input.messageId ?? null],
  );
  return Boolean(result.rowCount);
}

export async function getMessageRevisionContext(
  userId: string,
  messageId: string,
): Promise<{ conversationId: string; sequence: number; editCount: number; historyRevision: number } | null> {
  const result = await getPool().query(
    `SELECT message.conversation_id, message.sequence_no, message.edit_count,
            conversation.history_revision
     FROM messages message
     JOIN conversations conversation ON conversation.id = message.conversation_id
     WHERE message.id = $1 AND message.user_id = $2`,
    [messageId, userId],
  );
  if (!result.rowCount) return null;
  return {
    conversationId: result.rows[0].conversation_id,
    sequence: Number(result.rows[0].sequence_no),
    editCount: Number(result.rows[0].edit_count ?? 0),
    historyRevision: Number(result.rows[0].history_revision ?? 0),
  };
}

export async function isConversationTitleSourceCurrent(
  userId: string,
  conversationId: string,
  content: string,
): Promise<boolean> {
  const result = await getPool().query(
    `SELECT 1 FROM (
       SELECT content FROM messages
       WHERE user_id = $1 AND conversation_id = $2 AND role = 'user'
       ORDER BY sequence_no LIMIT 1
     ) first_message
     WHERE first_message.content = $3`,
    [userId, conversationId, content],
  );
  return Boolean(result.rowCount);
}

export async function getSkillRebuildBase(userId: string) {
  const result = await getPool().query(
    `SELECT * FROM personal_skill_versions
     WHERE user_id = $1 AND is_active = true
     ORDER BY version DESC LIMIT 1`,
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

export async function markSkillFresh(userId: string): Promise<void> {
  await getPool().query(
    `UPDATE users SET skill_stale = false, updated_at = now() WHERE id = $1`,
    [userId],
  );
}

export async function listMessages(
  userId: string,
  conversationId: string,
  limit = 80,
): Promise<ChatMessage[]> {
  const result = await getPool().query(
    `SELECT id, role, content, created_at, sequence_no, edited_at, edit_count, metadata FROM messages
     WHERE user_id = $1 AND conversation_id = $2
     ORDER BY sequence_no DESC LIMIT $3`,
    [userId, conversationId, limit],
  );
  return result.rows.reverse().map(mapMessage);
}

export async function getOnboardingAnswers(userId: string) {
  const result = await getPool().query(
    `SELECT id, content, metadata, created_at FROM messages
     WHERE user_id = $1 AND role = 'user' AND metadata->>'kind' = 'onboarding-answer'
     ORDER BY sequence_no`,
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

export async function updateTimeZone(userId: string, timeZone: string): Promise<void> {
  await getPool().query(
    `UPDATE users SET timezone = $2, updated_at = now() WHERE id = $1`,
    [userId, timeZone],
  );
}

export async function getUserTimeZone(userId: string): Promise<string> {
  const result = await getPool().query(`SELECT timezone FROM users WHERE id = $1`, [userId]);
  return result.rows[0]?.timezone ?? "Asia/Shanghai";
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

export async function getActiveMemories(userId: string): Promise<MemoryRecord[]> {
  const result = await getPool().query(
    `SELECT m.id, mv.id AS version_id, mv.category, mv.content, mv.tier,
            mv.confidence, mv.valid_until, mv.reason, mv.created_at,
            mv.event_time_kind, mv.event_time_start, mv.event_time_end,
            mv.temporal_precision, mv.temporal_expression, mv.source_timezone,
            mv.first_observed_at, mv.last_confirmed_at
     FROM memories m
     JOIN memory_versions mv ON mv.memory_id = m.id AND mv.is_active = true
     JOIN users u ON u.id = m.user_id
     WHERE m.user_id = $1
       AND (u.settings->>'memoryEnabled')::boolean = true
       AND (mv.valid_until IS NULL OR mv.valid_until > now())
     ORDER BY mv.confidence DESC, mv.created_at DESC LIMIT 100`,
    [userId],
  );
  return result.rows.map(mapMemory);
}

export async function searchMemories(
  userId: string,
  query: string,
  limit = 8,
  queryEmbedding?: number[],
): Promise<MemoryRecord[]> {
  if (queryEmbedding?.length === 1024) {
    const vector = `[${queryEmbedding.join(",")}]`;
    const result = await getPool().query(
      `SELECT m.id, mv.id AS version_id, mv.category, mv.content, mv.tier,
              mv.confidence, mv.valid_until, mv.reason, mv.created_at,
              mv.event_time_kind, mv.event_time_start, mv.event_time_end,
              mv.temporal_precision, mv.temporal_expression, mv.source_timezone,
              mv.first_observed_at, mv.last_confirmed_at,
              1 - (mv.embedding_v2 <=> $2::vector) AS similarity
       FROM memories m
       JOIN memory_versions mv ON mv.memory_id = m.id AND mv.is_active = true
       JOIN users u ON u.id = m.user_id
       WHERE m.user_id = $1
         AND (u.settings->>'memoryEnabled')::boolean = true
         AND (mv.valid_until IS NULL OR mv.valid_until > now())
         AND mv.embedding_v2 IS NOT NULL
       ORDER BY mv.embedding_v2 <=> $2::vector LIMIT 32`,
      [userId, vector],
    );
    if (result.rowCount) {
      return rankHybridMemories(result.rows, query, limit);
    }
  }
  return rankMemories(await getActiveMemories(userId), query, limit);
}

function rankHybridMemories(rows: any[], query: string, limit: number): MemoryRecord[] {
  const terms = query.replace(/[，。！？,.!?]/g, " ").split(/\s+/).filter((term) => term.length >= 2).slice(0, 12);
  const now = Date.now();
  return rows.map((row) => {
    const lexical = terms.length
      ? terms.filter((term) => String(row.content).includes(term)).length / terms.length
      : 0;
    const freshness = memoryFreshness(row, now);
    const score = Number(row.similarity) * 0.55 + lexical * 0.15 + Number(row.confidence) * 0.15 + freshness * 0.1 + (row.tier === "long" ? 0.05 : 0);
    return { row, score };
  }).sort((a, b) => b.score - a.score).slice(0, limit).map(({ row }) => mapMemory(row));
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
  const now = Date.now();
  return memories
    .map((memory) => ({
      memory,
      score:
        memory.confidence * 2 +
        (memory.tier === "long" ? 0.35 : 0) +
        memoryFreshness(memory, now) * 0.4 +
        terms.reduce(
          (sum, term) => sum + (memory.content.includes(term) ? 1 : 0),
          0,
        ),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ memory }) => memory);
}

function memoryFreshness(
  memory: {
    category: unknown;
    tier: unknown;
    lastConfirmedAt?: unknown;
    createdAt?: unknown;
    last_confirmed_at?: unknown;
    created_at?: unknown;
  },
  now: number,
): number {
  const category = String(memory.category);
  const tier = String(memory.tier);
  if (tier === "long" && ["basic", "interest", "expression", "experience", "boundary"].includes(category)) return 1;
  const confirmed = memory.lastConfirmedAt ?? memory.last_confirmed_at;
  const created = memory.createdAt ?? memory.created_at;
  const timestamp = confirmed ?? created;
  const parsed = new Date(String(timestamp)).getTime();
  const ageDays = Number.isFinite(parsed) ? Math.max(0, (now - parsed) / 86_400_000) : 0;
  const halfLife = category === "emotion" ? 14 : category === "challenge" || category === "goal" ? 30 : 90;
  return Math.exp(-Math.LN2 * ageDays / halfLife);
}

export async function getLatestProfile(
  userId: string,
): Promise<ProfileSnapshot | null> {
  const result = await getPool().query(
    `SELECT profile.* FROM profile_snapshots profile
     JOIN users ON users.id = profile.user_id
     WHERE profile.user_id = $1 AND users.profile_stale = false
     ORDER BY profile.created_at DESC LIMIT 1`,
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
  if (settings.rows[0]?.settings?.memoryEnabled === false) return null;
  return getLatestProfile(userId);
}

export async function commitProfileSnapshot(input: {
  userId: string;
  summary: string;
  dimensionWeights: Record<string, number>;
  sourceConversationId?: string;
  sourceMessageSequence?: number;
  expectedHistoryRevision?: number;
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
      (id, user_id, summary, dimension_weights, understanding_components, understanding_score,
       source_conversation_id, source_message_sequence)
     SELECT $1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8
     WHERE $9::bigint IS NULL OR EXISTS (
       SELECT 1 FROM conversations
       WHERE id = $7 AND user_id = $2 AND history_revision = $9
     )
     RETURNING *`,
    [
      randomUUID(),
      input.userId,
      input.summary,
      JSON.stringify(input.dimensionWeights),
      JSON.stringify(components),
      score,
      input.sourceConversationId ?? null,
      input.sourceMessageSequence ?? null,
      input.expectedHistoryRevision ?? null,
    ],
  );
  if (!result.rowCount) throw new Error("stale_job");
  await getPool().query(`UPDATE users SET profile_stale = false, updated_at = now() WHERE id = $1`, [input.userId]);
  return result.rows[0];
}

export async function getConversationSummary(
  userId: string,
  conversationId: string,
): Promise<ConversationSummaryRecord | null> {
  const result = await getPool().query(
    `SELECT cs.summary, cs.created_at, cs.source_message_id,
            source.created_at AS covered_through_at
     FROM conversation_summaries cs
     JOIN users u ON u.id = cs.user_id
     LEFT JOIN messages source ON source.id = cs.source_message_id
     WHERE cs.user_id = $1 AND cs.conversation_id = $2
       AND (u.settings->>'memoryEnabled')::boolean = true
     ORDER BY cs.created_at DESC LIMIT 1`,
    [userId, conversationId],
  );
  if (!result.rowCount) return null;
  return {
    summary: result.rows[0].summary,
    createdAt: result.rows[0].created_at,
    coveredThroughAt: result.rows[0].covered_through_at,
    sourceMessageId: result.rows[0].source_message_id,
  };
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
    `SELECT skill.* FROM personal_skill_versions skill
     JOIN users ON users.id = skill.user_id
     WHERE skill.user_id = $1 AND skill.is_active = true
       AND users.skill_stale = false LIMIT 1`,
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
  historyRevision?: number;
  reflection: ReflectionOutput;
  embeddings?: Array<number[] | null>;
}): Promise<{ memoryCount: number; profile: ProfileSnapshot | null }> {
  return withTransaction(async (client) => {
    const sourceResult = await client.query(
      `SELECT message.sequence_no, conversation.history_revision
       FROM messages message
       JOIN conversations conversation ON conversation.id = message.conversation_id
       WHERE message.id = $1 AND message.user_id = $2 AND message.conversation_id = $3
       FOR UPDATE OF conversation`,
      [input.sourceMessageId, input.userId, input.conversationId],
    );
    if (!sourceResult.rowCount) throw new Error("stale_job");
    const sourceSequence = Number(sourceResult.rows[0].sequence_no);
    if (input.historyRevision !== undefined && Number(sourceResult.rows[0].history_revision) !== input.historyRevision) {
      throw new Error("stale_job");
    }
    const settingsResult = await client.query(`SELECT settings FROM users WHERE id = $1`, [
      input.userId,
    ]);
    const settings = settingsResult.rows[0]?.settings ?? {};
    const memoryEnabled = settings.memoryEnabled !== false;

    for (const [mutationIndex, mutation] of (memoryEnabled ? input.reflection.memories : []).entries()) {
      const evidenceIds = [...new Set(mutation.evidenceMessageIds)];
      const evidence = await client.query(
        `SELECT id, created_at FROM messages
         WHERE user_id = $1 AND id = ANY($2::uuid[])
         ORDER BY created_at`,
        [input.userId, evidenceIds],
      );
      if (evidence.rows.length !== evidenceIds.length) {
        throw new Error("记忆证据必须属于当前用户");
      }
      const firstObservedAt = evidence.rows[0].created_at;
      const lastConfirmedAt = evidence.rows[evidence.rows.length - 1].created_at;

      if (mutation.operation === "reinforce") {
        const active = await client.query(
          `SELECT mv.id FROM memories m
           JOIN memory_versions mv ON mv.memory_id = m.id AND mv.is_active = true
           WHERE m.id = $1 AND m.user_id = $2 FOR UPDATE`,
          [mutation.memoryId, input.userId],
        );
        if (!active.rowCount) throw new Error("找不到要确认的活动记忆");
        for (const evidenceId of evidenceIds) {
          await client.query(
            `INSERT INTO memory_evidence (memory_version_id, message_id, user_id)
             VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
            [active.rows[0].id, evidenceId, input.userId],
          );
        }
        await client.query(
          `UPDATE memory_versions
           SET first_observed_at = LEAST(COALESCE(first_observed_at, $2), $2),
               last_confirmed_at = GREATEST(COALESCE(last_confirmed_at, $3), $3)
           WHERE id = $1 AND user_id = $4`,
          [active.rows[0].id, firstObservedAt, lastConfirmedAt, input.userId],
        );
        continue;
      }

      const memoryId = mutation.operation === "create" ? randomUUID() : mutation.memoryId;
      if (mutation.operation !== "create") {
        await client.query(
          `UPDATE memory_versions SET is_active = false, status = 'superseded'
           WHERE memory_id = $1 AND user_id = $2 AND is_active = true`,
          [memoryId, input.userId],
        );
      } else {
        await client.query(
          `INSERT INTO memories (id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [memoryId, input.userId],
        );
      }
      const versionId = randomUUID();
      await client.query(
        `INSERT INTO memory_versions
          (id, memory_id, user_id, category, content, tier, confidence, valid_until,
           event_time_kind, event_time_start, event_time_end, temporal_precision,
           temporal_expression, source_timezone, first_observed_at, last_confirmed_at,
           reason, embedding_v2, is_active, status,
           source_conversation_id, source_message_id, source_message_sequence)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
                 $9, $10, $11, $12, $13, $14, $15, $16,
                 $17, $18::vector, true, 'active', $19, $20, $21)`,
        [
          versionId,
          memoryId,
          input.userId,
          mutation.category,
          mutation.content,
          mutation.tier,
          mutation.confidence,
          mutation.validUntil,
          mutation.eventTime.kind,
          mutation.eventTime.start,
          mutation.eventTime.end,
          mutation.eventTime.precision,
          mutation.eventTime.expression,
          mutation.eventTime.timeZone,
          firstObservedAt,
          lastConfirmedAt,
          mutation.reason,
          input.embeddings?.[mutationIndex]?.length === 1024
            ? `[${input.embeddings[mutationIndex]!.join(",")}]`
            : null,
          input.conversationId,
          input.sourceMessageId,
          sourceSequence,
        ],
      );
      for (const evidenceId of evidenceIds) {
        await client.query(
          `INSERT INTO memory_evidence (memory_version_id, message_id, user_id)
           VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [versionId, evidenceId, input.userId],
        );
      }
    }

    if (memoryEnabled && input.reflection.summaryChanged !== false) {
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
    if (memoryEnabled && input.reflection.profileChanged !== false) {
      const memoriesResult = await client.query(
      `SELECT m.id, mv.id AS version_id, mv.category, mv.content, mv.tier,
              mv.confidence, mv.valid_until, mv.reason, mv.created_at,
              mv.event_time_kind, mv.event_time_start, mv.event_time_end,
              mv.temporal_precision, mv.temporal_expression, mv.source_timezone,
              mv.first_observed_at, mv.last_confirmed_at
       FROM memories m JOIN memory_versions mv ON mv.memory_id = m.id AND mv.is_active = true
       WHERE m.user_id = $1`,
      [input.userId],
    );
      const memories: MemoryRecord[] = memoriesResult.rows.map(mapMemory);
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
        (id, user_id, summary, dimension_weights, understanding_components, understanding_score,
         source_conversation_id, source_message_sequence)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8) RETURNING *`,
      [
        profileId,
        input.userId,
        input.reflection.profileSummary,
        JSON.stringify(input.reflection.dimensionWeights),
        JSON.stringify(components),
        score,
        input.conversationId,
        sourceSequence,
      ],
      );
      await client.query(`UPDATE users SET profile_stale = false WHERE id = $1`, [input.userId]);
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
          (id, user_id, conversation_id, content, valid_after, expires_at,
           source_message_id, source_message_sequence)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          randomUUID(),
          input.userId,
          input.conversationId,
          input.reflection.returnNote.content,
          input.reflection.returnNote.validAfter,
          input.reflection.returnNote.expiresAt,
          input.sourceMessageId,
          sourceSequence,
        ],
      );
    }
    return {
      memoryCount: memoryEnabled ? input.reflection.memories.length : 0,
      profile,
    };
  });
}

export async function publishPersonalSkill(input: {
  userId: string;
  skill: PersonalSkill;
  source: "model" | "developer_restore";
  sourceConversationId?: string;
  sourceMessageSequence?: number;
  evidenceMessageIds?: string[];
  expectedHistoryRevision?: number;
}) {
  return withTransaction(async (client) => {
    if (input.sourceConversationId && input.expectedHistoryRevision !== undefined) {
      const revision = await client.query(
        `SELECT 1 FROM conversations
         WHERE id = $1 AND user_id = $2 AND history_revision = $3
         FOR UPDATE`,
        [input.sourceConversationId, input.userId, input.expectedHistoryRevision],
      );
      if (!revision.rowCount) throw new Error("stale_job");
    }
    const current = await client.query(
      `SELECT * FROM personal_skill_versions
       WHERE user_id = $1 AND is_active = true FOR UPDATE`,
      [input.userId],
    );
    const latestVersion = await client.query(
      `SELECT COALESCE(max(version), 0)::int AS version
       FROM personal_skill_versions WHERE user_id = $1`,
      [input.userId],
    );
    const nextVersion = Number(latestVersion.rows[0]?.version ?? 0) + 1;
    await client.query(
      `UPDATE personal_skill_versions SET is_active = false
       WHERE user_id = $1 AND is_active = true`,
      [input.userId],
    );
    const id = randomUUID();
    const result = await client.query(
      `INSERT INTO personal_skill_versions
        (id, user_id, version, content, trigger_reason, expected_effect, source, parent_id, is_active,
         source_conversation_id, source_message_sequence, evidence_message_ids)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, true, $9, $10, $11::uuid[]) RETURNING *`,
      [
        id,
        input.userId,
        nextVersion,
        JSON.stringify(input.skill),
        input.skill.evolution.reason,
        input.skill.evolution.expectedEffect,
        input.source,
        current.rows[0]?.id ?? null,
        input.sourceConversationId ?? null,
        input.sourceMessageSequence ?? null,
        input.evidenceMessageIds ?? [],
      ],
    );
    await client.query(`UPDATE users SET skill_stale = false, updated_at = now() WHERE id = $1`, [input.userId]);
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

export async function withdrawMemory(input: {
  userId: string;
  memoryId: string;
  reason?: string;
}) {
  return withTransaction(async (client) => {
    const current = await client.query(
      `SELECT mv.id, mv.category, mv.content FROM memories m
       JOIN memory_versions mv ON mv.memory_id = m.id AND mv.is_active = true
       WHERE m.id = $1 AND m.user_id = $2 FOR UPDATE`,
      [input.memoryId, input.userId],
    );
    if (!current.rowCount) throw new Error("找不到可撤回的活动记忆");
    const row = current.rows[0];
    await client.query(
      `UPDATE memory_versions SET is_active = false, status = 'withdrawn'
       WHERE id = $1 AND user_id = $2`,
      [row.id, input.userId],
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
    sequence: Number(row.sequence_no),
    editedAt: row.edited_at ?? null,
    editCount: Number(row.edit_count ?? 0),
    metadata: row.metadata ?? {},
  };
}

function mapMemory(row: any): MemoryRecord {
  return {
    id: row.id,
    versionId: row.version_id,
    category: row.category,
    content: row.content,
    tier: row.tier,
    confidence: Number(row.confidence),
    validUntil: row.valid_until,
    eventTime: {
      kind: row.event_time_kind ?? "unknown",
      start: row.event_time_start,
      end: row.event_time_end,
      precision: row.temporal_precision ?? "unknown",
      expression: row.temporal_expression,
      timeZone: row.source_timezone,
    },
    firstObservedAt: row.first_observed_at,
    lastConfirmedAt: row.last_confirmed_at,
    reason: row.reason,
    createdAt: row.created_at,
  };
}
