import {
  PersonalSkillSchema,
  addActivity,
  callMemoryMcp,
  claimJob,
  compileContext,
  completeJob,
  enqueueJob,
  failJob,
  getConversationSummary,
  getProfileForContext,
  getUserState,
  listMessages,
  recordTrace,
  recordModelRun,
  searchMemories,
  type MemoryRecord,
  type PersonalSkill,
} from "@zhiwei/core";
import { getModelAdapter } from "@zhiwei/model-gateway";
import { composeFoundationInstructions } from "@zhiwei/skills";

const adapter = getModelAdapter();
let stopping = false;

process.on("SIGINT", () => (stopping = true));
process.on("SIGTERM", () => (stopping = true));

process.stdout.write(`Zhiwei worker started with ${adapter.id}\n`);

while (!stopping) {
  const job = await claimJob();
  if (!job) {
    await delay(600);
    continue;
  }
  try {
    if (job.type === "reflection") await handleReflection(job);
    if (job.type === "evolve_skill") await handleEvolution(job);
    await completeJob(job.id);
  } catch (error) {
    await failJob(job, error);
    await addActivity({
      userId: job.user_id,
      type: "background.error",
      payload: {
        jobId: job.id,
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
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
  const [messages, profile, memories, summary, state] = await Promise.all([
    listMessages(job.user_id, payload.conversationId, 24),
    getProfileForContext(job.user_id),
    searchMemories(job.user_id, payload.content, 8),
    getConversationSummary(job.user_id, payload.conversationId),
    getUserState(job.user_id),
  ]);
  const personalSkill = (state.skill?.content ?? {}) as PersonalSkill;
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
    maxInputTokens: Math.min(18_000, adapter.capabilities.maxContextTokens - 2_000),
  });
  await recordTrace({
    userId: job.user_id,
    traceId,
    stage: "reflection.context_compiled",
    payload: {
      estimatedTokens: context.estimatedTokens,
      truncated: context.truncated,
      memoryIds: context.memories.map((memory: MemoryRecord) => memory.id),
      skillVersion: state.skill?.version,
      foundationSkills: [
        "memory-reflection@1.0.0",
        "profile-synthesis@1.0.0",
        "emotion-and-return@1.0.0",
      ],
      context,
    },
  });
  const reflection = await adapter.reflect({
    userId: job.user_id,
    conversationId: payload.conversationId,
    messageId: payload.messageId,
    content: payload.content,
    context,
    kind: payload.kind,
    questionId: payload.questionId,
    questionCategory: payload.questionCategory,
  });
  const committed = await callMemoryMcp<any>({
    tool: "memory_commit_reflection",
    userId: job.user_id,
    traceId,
    arguments: {
      conversationId: payload.conversationId,
      sourceMessageId: payload.messageId,
      reflection,
    },
  });
  await recordTrace({
    userId: job.user_id,
    traceId,
    stage: "reflection.completed",
    durationMs: Date.now() - started,
    payload: {
      adapter: adapter.id,
      output: reflection,
      committed,
    },
  });
  await recordModelRun({
    userId: job.user_id,
    traceId,
    role: "reflection",
    adapterId: adapter.id,
    inputTokens: context.estimatedTokens,
    outputTokens: Math.ceil(JSON.stringify(reflection).length / 2.4),
    durationMs: Date.now() - started,
    finishReason: "completed",
  });
  await addActivity({
    userId: job.user_id,
    type: "memory.updated",
    payload: {
      sourceMessageId: payload.messageId,
      memoryCount: committed.memoryCount,
      score: committed.profile?.score,
      profile: committed.profile,
      mood: reflection.mood,
    },
  });
  if (reflection.shouldEvolveSkill && state.user.settings?.skillEvolutionEnabled !== false) {
    await enqueueJob({
      userId: job.user_id,
      type: "evolve_skill",
      payload: {
        evidenceIds: [payload.messageId],
        latestUserMessage: payload.content,
        profileSummary: reflection.profileSummary,
        reason: reflection.evolutionReason,
        traceId,
      },
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
  const started = Date.now();
  const currentResult = await callMemoryMcp<any>({
    tool: "personal_skill_get_active",
    userId: job.user_id,
    traceId,
  });
  const currentSkill = PersonalSkillSchema.parse(currentResult.skill.content);
  const nextSkill = await adapter.evolvePersonalSkill({
    currentSkill,
    evidenceIds: payload.evidenceIds,
    feedback: payload.feedback,
    feedbackReason: payload.feedbackReason,
    latestUserMessage: payload.latestUserMessage,
    profileSummary: payload.profileSummary,
  });
  const published = await callMemoryMcp<any>({
    tool: "personal_skill_publish_rewrite",
    userId: job.user_id,
    traceId,
    arguments: { skill: nextSkill },
  });
  await recordTrace({
    userId: job.user_id,
    traceId,
    stage: "personal_skill.evolved",
    payload: {
      previousVersion: currentResult.skill.version,
      nextVersion: published.version.version,
      fullRewrite: nextSkill,
      reason: nextSkill.evolution.reason,
    },
  });
  await recordModelRun({
    userId: job.user_id,
    traceId,
    role: "skill-evolution",
    adapterId: adapter.id,
    inputTokens: Math.ceil(JSON.stringify(currentSkill).length / 2.4),
    outputTokens: Math.ceil(JSON.stringify(nextSkill).length / 2.4),
    durationMs: Date.now() - started,
    finishReason: "completed",
  });
  await addActivity({
    userId: job.user_id,
    type: "skill.evolved",
    payload: {
      version: published.version.version,
      message: "知微又更了解你一点。",
      reason: nextSkill.evolution.reason,
    },
  });
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
