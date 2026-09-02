import { randomUUID } from "node:crypto";
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
  MemoryRecord,
  PersonalSkill,
  ProfileSnapshot,
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
): Promise<void> {
  await getPool().query(
    `UPDATE conversations SET title = $3, updated_at = now()
     WHERE id = $1 AND user_id = $2`,
    [conversationId, userId, title.slice(0, 36)],
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

export async function enqueueJob(input: {
  userId: string;
  type: "reflection" | "evolve_skill";
  payload: Record<string, unknown>;
}): Promise<string> {
  const id = randomUUID();
  await getPool().query(
    `INSERT INTO jobs (id, user_id, type, payload) VALUES ($1, $2, $3, $4::jsonb)`,
    [id, input.userId, input.type, JSON.stringify(input.payload)],
  );
  return id;
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
  await getPool().query(
    `UPDATE jobs SET status = $2, last_error = $3,
       run_after = CASE WHEN $2 = 'pending' THEN now() + interval '5 seconds' ELSE run_after END
     WHERE id = $1`,
    [job.id, terminal ? "failed" : "pending", error instanceof Error ? error.message : String(error)],
  );
}

export async function getActiveMemories(userId: string): Promise<MemoryRecord[]> {
  const result = await getPool().query(
    `SELECT m.id, mv.id AS version_id, mv.category, mv.content, mv.tier,
            mv.confidence, mv.valid_until, mv.reason, mv.created_at
     FROM memories m
     JOIN memory_versions mv ON mv.memory_id = m.id AND mv.is_active = true
     JOIN users u ON u.id = m.user_id
     WHERE m.user_id = $1
       AND (u.settings->>'memoryEnabled')::boolean = true
       AND (mv.valid_until IS NULL OR mv.valid_until > now())
     ORDER BY mv.confidence DESC, mv.created_at DESC LIMIT 100`,
    [userId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    versionId: row.version_id,
    category: row.category,
    content: row.content,
    tier: row.tier,
    confidence: Number(row.confidence),
    validUntil: row.valid_until,
    reason: row.reason,
    createdAt: row.created_at,
  }));
}

export async function searchMemories(
  userId: string,
  query: string,
  limit = 8,
): Promise<MemoryRecord[]> {
  return rankMemories(await getActiveMemories(userId), query, limit);
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
  if (settings.rows[0]?.settings?.memoryEnabled === false) return null;
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
  reflection: ReflectionOutput;
}): Promise<{ memoryCount: number; profile: ProfileSnapshot | null }> {
  return withTransaction(async (client) => {
    const settingsResult = await client.query(`SELECT settings FROM users WHERE id = $1`, [
      input.userId,
    ]);
    const settings = settingsResult.rows[0]?.settings ?? {};
    const memoryEnabled = settings.memoryEnabled !== false;

    for (const mutation of memoryEnabled ? input.reflection.memories : []) {
      const memoryId = mutation.memoryId ?? randomUUID();
      if (mutation.memoryId) {
        await client.query(
          `UPDATE memory_versions SET is_active = false
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
          (id, memory_id, user_id, category, content, tier, confidence, valid_until, reason, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true)`,
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
        ],
      );
      for (const evidenceId of mutation.evidenceMessageIds) {
        await client.query(
          `INSERT INTO memory_evidence (memory_version_id, message_id, user_id)
           VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [versionId, evidenceId, input.userId],
        );
      }
    }

    if (memoryEnabled) {
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
    if (memoryEnabled) {
      const memoriesResult = await client.query(
      `SELECT m.id, mv.id AS version_id, mv.category, mv.content, mv.tier,
              mv.confidence, mv.valid_until, mv.reason, mv.created_at
       FROM memories m JOIN memory_versions mv ON mv.memory_id = m.id AND mv.is_active = true
       WHERE m.user_id = $1`,
      [input.userId],
    );
      const memories: MemoryRecord[] = memoriesResult.rows.map((row) => ({
      id: row.id,
      versionId: row.version_id,
      category: row.category,
      content: row.content,
      tier: row.tier,
      confidence: Number(row.confidence),
      validUntil: row.valid_until,
      reason: row.reason,
      createdAt: row.created_at,
    }));
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
      memoryCount: memoryEnabled ? input.reflection.memories.length : 0,
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
  role: "dialogue" | "reflection" | "skill-evolution" | "question-planner" | "return-note";
  adapterId: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCostCny?: number;
  durationMs: number;
  finishReason: string;
}) {
  const configuredBudget = Number(process.env.MODEL_BUDGET_CNY ?? 500);
  const spent = await getPool().query(
    `SELECT COALESCE(sum(estimated_cost_cny), 0)::float AS total FROM model_runs`,
  );
  const projected = Number(spent.rows[0]?.total ?? 0) + (input.estimatedCostCny ?? 0);
  if (projected > configuredBudget) {
    throw new Error(`模型预算将超过 ¥${configuredBudget}，已停止新的付费调用`);
  }
  await getPool().query(
    `INSERT INTO model_runs
      (id, user_id, trace_id, role, adapter_id, model_name, input_tokens,
       output_tokens, estimated_cost_cny, duration_ms, finish_reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      randomUUID(),
      input.userId,
      input.traceId,
      input.role,
      input.adapterId,
      process.env.MODEL_NAME ?? input.adapterId,
      input.inputTokens,
      input.outputTokens,
      input.estimatedCostCny ?? 0,
      input.durationMs,
      input.finishReason,
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
