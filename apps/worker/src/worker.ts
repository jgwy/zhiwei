import {
  PersonalSkillSchema,
  ReflectionOutputSchema,
  addActivity,
  callMemoryMcp,
  claimJob,
  compileContext,
  completeJob,
  enqueueJob,
  failJob,
  getConversationSummary,
  getUserTimeZone,
  getUserSettings,
  listMessages,
  normalizeDimensionWeights,
  recordModelCallMeta,
  recordTrace,
  updateConversationTitle,
  type MemoryRecord,
  type PersonalSkill,
  type ProfileSnapshot,
} from "@zhiwei/core";
import { getModelGateway } from "@zhiwei/model-gateway";
import { composeFoundationInstructions } from "@zhiwei/skills";

const gateway = getModelGateway();
let stopping = false;

process.on("SIGINT", () => (stopping = true));
process.on("SIGTERM", () => (stopping = true));
process.stdout.write(`知微后台进程已启动：${gateway.id}\n`);

while (!stopping) {
  const job = await claimJob();
  if (!job) {
    await delay(600);
    continue;
  }
  try {
    if (job.type === "reflection") await handleReflection(job);
    if (job.type === "evolve_skill") await handleEvolution(job);
    if (job.type === "conversation_title") await handleConversationTitle(job);
    await completeJob(job.id);
  } catch (error) {
    await failJob(job, error);
    await addActivity({
      userId: job.user_id,
      type: "background.error",
      payload: { jobId: job.id, code: publicErrorCode(error), message: "后台更新暂时没有完成，知微会稍后再试。" },
    });
  }
}

async function handleConversationTitle(job: any) {
  const payload = job.payload as { conversationId: string; content: string; traceId?: string };
  const traceId = payload.traceId ?? crypto.randomUUID();
  const result = await gateway.generateTitle(payload.content);
  await updateConversationTitle(job.user_id, payload.conversationId, result.data.title, "model");
  await recordModelCallMeta({ userId: job.user_id, traceId, conversationId: payload.conversationId, adapterId: gateway.id, meta: result.meta });
  await recordTrace({ userId: job.user_id, traceId, stage: "conversation.title.generated", payload: { title: result.data.title, meta: result.meta } });
  await addActivity({ userId: job.user_id, type: "conversation.title.updated", payload: { conversationId: payload.conversationId, title: result.data.title } });
}

async function handleReflection(job: any) {
  const payload = job.payload as {
    conversationId: string;
    messageId: string;
    content: string;
    kind: "chat" | "onboarding";
    questionId?: string;
    questionCategory?: any;
    traceId?: string;
  };
  const traceId = payload.traceId ?? crypto.randomUUID();
  const started = Date.now();
  const [messages, summary, settings, timeZone] = await Promise.all([
    listMessages(job.user_id, payload.conversationId, 24),
    getConversationSummary(job.user_id, payload.conversationId),
    getUserSettings(job.user_id),
    getUserTimeZone(job.user_id),
  ]);
  const queryEmbedding = await tryEmbedding(job.user_id, traceId, payload.conversationId, [payload.content]);
  const [profileResult, skillResult, memoryResult] = await Promise.all([
    callMemoryMcp<{ profile: ProfileSnapshot | null }>({ tool: "profile_get_current", userId: job.user_id, traceId }),
    callMemoryMcp<any>({ tool: "personal_skill_get_active", userId: job.user_id, traceId }),
    callMemoryMcp<{ memories: MemoryRecord[] }>({
      tool: "memory_search",
      userId: job.user_id,
      traceId,
      arguments: { query: payload.content, limit: 8, ...(queryEmbedding?.[0] ? { queryEmbedding: queryEmbedding[0] } : {}) },
    }),
  ]);
  const personalSkill = PersonalSkillSchema.parse(skillResult.skill.content) as PersonalSkill;
  const profile = profileResult.profile;
  const memories = memoryResult.memories;
  const context = compileContext({
    foundationInstructions: composeFoundationInstructions([
      "zhiwei-persona",
      "dialogue-orchestrator",
      "memory-reflection",
      "profile-synthesis",
      "emotion-and-return",
      "fact-and-tool-use",
    ]),
    personalSkill,
    profile,
    memories,
    sessionSummary: summary,
    messages,
    timeZone,
    maxInputTokens: Math.min(18_000, gateway.capabilities.maxContextTokens - 2_000),
  });
  await recordTrace({
    userId: job.user_id,
    traceId,
    stage: "reflection.context_compiled",
    payload: { estimatedTokens: context.estimatedTokens, truncated: context.truncated, memoryIds: context.memories.map((memory) => memory.id), skillVersion: skillResult.skill.version, context },
  });

  let reflectionResult = await gateway.reflect({
    userId: job.user_id,
    conversationId: payload.conversationId,
    messageId: payload.messageId,
    content: payload.content,
    context,
    kind: payload.kind,
    questionId: payload.questionId,
    questionCategory: payload.questionCategory,
  });
  await recordModelCallMeta({ userId: job.user_id, traceId, conversationId: payload.conversationId, adapterId: gateway.id, meta: reflectionResult.meta });
  if (reflectionResult.data.needsDeepReview) {
    reflectionResult = await gateway.reflect({
      userId: job.user_id,
      conversationId: payload.conversationId,
      messageId: payload.messageId,
      content: payload.content,
      context,
      kind: payload.kind,
      questionId: payload.questionId,
      questionCategory: payload.questionCategory,
    }, { deep: true });
    await recordModelCallMeta({ userId: job.user_id, traceId, conversationId: payload.conversationId, adapterId: gateway.id, meta: reflectionResult.meta, promptVersion: "deep-v1" });
  }
  const decision = {
    ...reflectionResult.data,
    memories: filterMemoryMutations(reflectionResult.data.memories, memories),
  };

  let profileSummary = profile?.summary ?? "仍在形成第一轮认识。";
  let dimensionWeights = normalizeDimensionWeights(profile?.dimensionWeights ?? equalWeights());
  const shouldRefreshProfile = settings.memoryEnabled !== false && (decision.refreshProfile || decision.memories.length > 0 || !profile);
  if (shouldRefreshProfile) {
    const replacedMemoryIds = new Set(
      decision.memories
        .filter((memory) => memory.operation === "supersede" || memory.operation === "promote")
        .map((memory) => memory.memoryId),
    );
    const newMemoryVersions = decision.memories.filter((memory) => memory.operation !== "reinforce");
    const result = await gateway.synthesizeProfile({
      memories: [
        ...memories.filter((memory) => !replacedMemoryIds.has(memory.id)),
        ...newMemoryVersions.map((memory, index) => ({
          id: memory.operation === "create" ? `pending-${index}` : memory.memoryId,
          versionId: `pending-${index}`,
          category: memory.category,
          content: memory.content,
          tier: memory.tier,
          confidence: memory.confidence,
          validUntil: memory.validUntil,
          eventTime: memory.eventTime,
          firstObservedAt: messages.at(-1)?.createdAt ?? null,
          lastConfirmedAt: messages.at(-1)?.createdAt ?? null,
          reason: memory.reason,
          createdAt: context.temporalContext.currentTimeUtc,
        })),
      ],
      currentSummary: profile?.summary,
      latestMessage: payload.content,
      temporalContext: context.temporalContext,
    });
    profileSummary = result.data.summary;
    dimensionWeights = normalizeDimensionWeights(result.data.dimensionWeights);
    await recordModelCallMeta({ userId: job.user_id, traceId, conversationId: payload.conversationId, adapterId: gateway.id, meta: result.meta });
  }

  let sessionSummary = summary?.summary ?? "这段对话刚刚开始。";
  const shouldRefreshSummary = decision.refreshSummary || !summary || messages.length >= 12;
  if (shouldRefreshSummary) {
    const result = await gateway.summarizeSession({
      messages,
      previousSummary: summary?.summary,
      temporalContext: context.temporalContext,
    });
    sessionSummary = result.data.summary;
    await recordModelCallMeta({ userId: job.user_id, traceId, conversationId: payload.conversationId, adapterId: gateway.id, meta: result.meta });
  }

  let returnNote: { content: string; validAfter: string; expiresAt: string } | null = null;
  if (decision.returnTopic && settings.returnNotesEnabled !== false) {
    const result = await gateway.generateReturnNote({ topic: decision.returnTopic, profileSummary });
    const now = Date.now();
    returnNote = { content: result.data.content, validAfter: new Date(now + 6 * 60 * 60 * 1000).toISOString(), expiresAt: new Date(now + 72 * 60 * 60 * 1000).toISOString() };
    await recordModelCallMeta({ userId: job.user_id, traceId, conversationId: payload.conversationId, adapterId: gateway.id, meta: result.meta });
  }

  const embeddings = decision.memories.length
    ? await tryEmbedding(job.user_id, traceId, payload.conversationId, decision.memories.map((memory) => memory.content))
    : [];
  const reflection = ReflectionOutputSchema.parse({
    memories: decision.memories,
    profileSummary,
    dimensionWeights,
    mood: decision.mood,
    sessionSummary,
    returnNote,
    shouldEvolveSkill: decision.shouldEvolveSkill,
    evolutionReason: decision.evolutionReason,
    profileChanged: shouldRefreshProfile,
    summaryChanged: shouldRefreshSummary,
  });
  const committed = await callMemoryMcp<any>({
    tool: "memory_commit_reflection",
    userId: job.user_id,
    traceId,
    arguments: { conversationId: payload.conversationId, sourceMessageId: payload.messageId, reflection, embeddings: embeddings?.map((vector) => vector ?? null) },
  });
  await recordTrace({ userId: job.user_id, traceId, stage: "reflection.completed", durationMs: Date.now() - started, payload: { gateway: gateway.id, decision, reflection, committed } });
  await addActivity({ userId: job.user_id, type: "memory.updated", payload: { sourceMessageId: payload.messageId, memoryCount: committed.memoryCount, score: committed.profile?.score, profile: committed.profile, mood: reflection.mood } });
  if (decision.shouldEvolveSkill && settings.skillEvolutionEnabled !== false) {
    await enqueueJob({
      userId: job.user_id,
      type: "evolve_skill",
      idempotencyKey: `evolve_skill:${payload.messageId}:v1`,
      payload: { evidenceIds: [payload.messageId], latestUserMessage: payload.content, profileSummary, feedbackReason: decision.evolutionReason, traceId },
    });
  }
}

async function handleEvolution(job: any) {
  const payload = job.payload as {
    evidenceIds: string[];
    feedback?: "understood" | "not-me";
    feedbackReason?: string;
    latestUserMessage?: string;
    profileSummary?: string;
    traceId?: string;
  };
  const traceId = payload.traceId ?? crypto.randomUUID();
  const currentResult = await callMemoryMcp<any>({ tool: "personal_skill_get_active", userId: job.user_id, traceId });
  const currentSkill = PersonalSkillSchema.parse(currentResult.skill.content);
  const result = await gateway.evolvePersonalSkill({ currentSkill, ...payload }, { deep: payload.feedback === "not-me" });
  const nextSkill = PersonalSkillSchema.parse(result.data);
  const published = await callMemoryMcp<any>({ tool: "personal_skill_publish_rewrite", userId: job.user_id, traceId, arguments: { skill: nextSkill } });
  await recordModelCallMeta({ userId: job.user_id, traceId, adapterId: gateway.id, meta: result.meta });
  await recordTrace({ userId: job.user_id, traceId, stage: "personal_skill.evolved", payload: { previousVersion: currentResult.skill.version, nextVersion: published.version.version, fullRewrite: nextSkill, reason: nextSkill.evolution.reason } });
  await addActivity({ userId: job.user_id, type: "skill.evolved", payload: { version: published.version.version, message: "知微又更了解你一点。", reason: nextSkill.evolution.reason } });
}

async function tryEmbedding(userId: string, traceId: string, conversationId: string, texts: string[]) {
  if (!texts.length) return [];
  try {
    const result = await gateway.embed(texts);
    await recordModelCallMeta({ userId, traceId, conversationId, adapterId: gateway.id, meta: result.meta });
    return result.data;
  } catch (error) {
    await recordTrace({ userId, traceId, stage: "retrieval.degraded", payload: { code: publicErrorCode(error), message: "向量服务不可用，已降级为关键词检索。" } });
    return null;
  }
}

function equalWeights() { return { basic: 1, goal: 1, interest: 1, expression: 1, emotion: 1, experience: 1, challenge: 1, boundary: 1 }; }
function filterMemoryMutations(mutations: any[], active: MemoryRecord[]) {
  const accepted: any[] = [];
  for (const mutation of mutations) {
    if (accepted.length >= 2) break;
    if (mutation.category === "goal" && /^(担心|害怕|忧虑|压力|风险|困扰)/u.test(mutation.content.trim())) continue;
    const sameCategory = [
      ...active.filter((memory) => memory.category === mutation.category).map((memory) => memory.content),
      ...accepted.filter((memory) => memory.category === mutation.category).map((memory) => memory.content),
    ];
    if (mutation.operation === "create" && sameCategory.some((content) => semanticOverlap(content, mutation.content) >= 0.72)) continue;
    accepted.push(mutation);
  }
  return accepted;
}

function semanticOverlap(left: string, right: string) {
  const grams = (value: string) => {
    const normalized = value.replace(/[\s，。！？、,.!?：“”"'（）()]/gu, "");
    return new Set(Array.from({ length: Math.max(0, normalized.length - 1) }, (_, index) => normalized.slice(index, index + 2)));
  };
  const a = grams(left);
  const b = grams(right);
  if (!a.size || !b.size) return left === right ? 1 : 0;
  const intersection = [...a].filter((gram) => b.has(gram)).length;
  return intersection / Math.max(a.size, b.size);
}
function publicErrorCode(error: unknown) { const code = error instanceof Error ? error.message : String(error); return ["rate_limited", "provider_unavailable", "invalid_response", "request_cancelled"].includes(code) ? code : "background_failed"; }
function delay(ms: number) { return new Promise((resolve) => setTimeout(resolve, ms)); }
