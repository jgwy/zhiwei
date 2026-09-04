import { createHash } from "node:crypto";
import {
  PersonalSkillSchema,
  addActivity,
  attachMemoryReceipt,
  callMemoryMcp as callMemoryMcpRequest,
  claimJob,
  compileContext,
  completeJob,
  enqueueJob,
  failJob,
  getConversationSummary,
  getUserSettings,
  isOnboardingComplete,
  normalizeDimensionWeights,
  recordModelCallMeta,
  recordTrace,
  updateConversationTitle,
  getBatchEvidence,
  listMessagesThrough,
  getOnboardingAnswers,
  publishQuestionCandidates,
  recoverRunningJobs,
  requeueInterruptedJob,
  nextJobDelay,
  subscribeDatabase,
  closeNotifications,
  closePool,
  isMemoryControl,
  selectPlannedQuestions,
  type MemoryRecord,
  type PersonalSkill,
  type ProfileSnapshot,
} from "@zhiwei/core";
import {
  CONSOLIDATION_TARGET_COUNT,
  CONSOLIDATION_TARGET_TOKENS,
  LONG_PROFILE_SCHEMA_VERSION,
  getModelGateway,
  shouldConsolidateMemories,
} from "@zhiwei/model-gateway";
import { composeFoundationInstructions } from "@zhiwei/skills";
import {
  alignEmbeddings,
  backgroundReflection,
  consolidationMemories,
  embeddingInputs,
  prepareReflectionActions,
  profileMemories,
  shouldRefreshSessionSummary,
} from "./pipeline";

const gateway = getModelGateway();
const PROFILE_PROMPT_VERSION = LONG_PROFILE_SCHEMA_VERSION;
const REFLECTION_PROMPT_VERSION = "batch-memory-v1";
const CONSOLIDATION_PROMPT_VERSION = "memory-consolidation-v1";
let stopping = false;
const shutdown = new AbortController();
const modelOptions = { signal: shutdown.signal };
function callMemoryMcp<T>(input: Parameters<typeof callMemoryMcpRequest>[0]) {
  return callMemoryMcpRequest<T>({ ...input, signal: shutdown.signal });
}

const stop = () => {
  stopping = true;
  shutdown.abort();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
process.stdout.write(`知微后台进程已启动：${gateway.id}\n`);
await recoverRunningJobs();
await Promise.all([runLane("planning"), runLane("memory")]);
await closeNotifications();
await closePool();

async function runLane(lane: "planning" | "memory") {
  const subscription = subscribeDatabase("zhiwei_jobs");
  try {
    while (!stopping) {
      const job = await claimJob(lane);
      if (!job) {
        await subscription.wait(await nextJobDelay(lane), shutdown.signal);
        continue;
      }
      try {
        await dispatchJob(job);
        await completeJob(job.id);
      } catch (error) {
        const failedMeta = (error as { modelMeta?: any })?.modelMeta;
        if (failedMeta)
          await recordCall(
            job.user_id,
            job.payload?.traceId ?? crypto.randomUUID(),
            job.payload?.conversationId,
            failedMeta,
          ).catch(() => undefined);
        if (stopping) {
          await requeueInterruptedJob(job.id).catch(() => undefined);
          continue;
        }
        const terminal = Number(job.attempts ?? 0) >= 3;
        if (terminal && job.type === "memory_consolidation") {
          await enqueueProfileSynthesis(job.user_id, {
            sourceMessageId: job.payload?.sourceMessageId,
            conversationId: job.payload?.conversationId,
            traceId: job.payload?.traceId,
            trigger: "consolidation-fallback",
            idempotencySuffix: job.id,
          });
        }
        await failJob(job, error).catch(() => undefined);
        await recordTrace({
          userId: job.user_id,
          traceId: job.payload?.traceId ?? crypto.randomUUID(),
          stage: `background.${job.type}.failed`,
          payload: {
            jobId: job.id,
            attempt: Number(job.attempts ?? 0),
            terminal,
            code: publicErrorCode(error),
          },
        }).catch(() => undefined);
        if (terminal) {
          await addActivity({
            userId: job.user_id,
            type: "background.error",
            payload: {
              jobId: job.id,
              code: publicErrorCode(error),
              message: "后台更新暂时没有完成，知微会保留上一份可靠结果。",
            },
          }).catch(() => undefined);
        }
      }
    }
  } finally {
    subscription.close();
  }
}

async function dispatchJob(job: any) {
  switch (job.type) {
    case "reflection":
      return handleReflection(job);
    case "profile_synthesis":
      return handleProfileSynthesis(job);
    case "session_summary":
      return handleSessionSummary(job);
    case "return_note":
      return handleReturnNote(job);
    case "evolve_skill":
      return handleEvolution(job);
    case "conversation_title":
      return handleConversationTitle(job);
    case "onboarding_plan":
      return handleQuestionPlanning(job);
    case "memory_embedding":
      return handleMemoryEmbedding(job);
    case "memory_consolidation":
      return handleMemoryConsolidation(job);
    default:
      throw new Error(`unknown_background_job:${job.type}`);
  }
}

async function handleConversationTitle(job: any) {
  const payload = job.payload as {
    conversationId: string;
    content: string;
    traceId?: string;
  };
  const traceId = payload.traceId ?? crypto.randomUUID();
  const result = await gateway.generateTitle(payload.content, modelOptions);
  await updateConversationTitle(
    job.user_id,
    payload.conversationId,
    result.data.title,
    "model",
  );
  await recordCall(job.user_id, traceId, payload.conversationId, result.meta);
  await recordTrace({
    userId: job.user_id,
    traceId,
    stage: "conversation.title.generated",
    payload: { title: result.data.title, meta: result.meta },
  });
  await addActivity({
    userId: job.user_id,
    type: "conversation.title.updated",
    payload: {
      conversationId: payload.conversationId,
      title: result.data.title,
    },
  });
}

async function handleQuestionPlanning(job: any) {
  const answers = await getOnboardingAnswers(job.user_id);
  if (!answers.length || (await isOnboardingComplete(job.user_id))) return;
  const traceId = crypto.randomUUID();
  const result = await gateway.planQuestions(
    {
      answered: answers.map((answer) => ({
        questionId: answer.metadata?.questionId,
        content: answer.content,
      })),
    },
    modelOptions,
  );
  const questions = selectPlannedQuestions(result.data,job.user_id,answers.length);
  await publishQuestionCandidates(
    job.user_id,
    questions,
    result.meta.model,
    answers.length,
  );
  await recordCall(
    job.user_id,
    traceId,
    undefined,
    result.meta,
    "onboarding-prefetch-v1",
  );
}

async function handleReflection(job: any) {
  const payload = job.payload as {
    conversationId: string;
    messageId: string;
    sourceMessageIds?: string[];
    content: string;
    kind: "chat" | "onboarding";
    questionId?: string;
    questionCategory?: any;
    traceId?: string;
  };
  const traceId = payload.traceId ?? crypto.randomUUID();
  const started = Date.now();
  const sourceMessages = await getBatchEvidence(
    job.user_id,
    payload.conversationId,
    payload.sourceMessageIds ?? [payload.messageId],
  );
  const sourceMessageIds = sourceMessages.map((message) => message.id);
  payload.messageId = sourceMessageIds.at(-1)!;
  payload.content = sourceMessages.at(-1)!.content;
  const [messages, summary, settings] = await Promise.all([
    listMessagesThrough(
      job.user_id,
      payload.conversationId,
      payload.messageId,
      24,
    ),
    getConversationSummary(job.user_id, payload.conversationId),
    getUserSettings(job.user_id),
  ]);
  const queryVectors =
    settings.memoryEnabled === false
      ? null
      : await tryEmbedding(
          job.user_id,
          traceId,
          payload.conversationId,
          sourceMessages.map((message) => message.content),
          "retrieval",
        );
  const [profileResult, skillResult, memoryResults] = await Promise.all([
    callMemoryMcp<{ profile: ProfileSnapshot | null }>({
      tool: "profile_get_current",
      userId: job.user_id,
      traceId,
    }),
    callMemoryMcp<any>({
      tool: "personal_skill_get_active",
      userId: job.user_id,
      traceId,
    }),
    Promise.all(
      sourceMessages.map((message, index) =>
        callMemoryMcp<{
          memories: MemoryRecord[];
          mutationCursor?: number;
          withdrawals?: Array<{
            memoryId: string;
            versionId: string;
            content: string;
            withdrawnAt: string;
          }>;
        }>({
          tool: "memory_search",
          userId: job.user_id,
          traceId,
          signal: shutdown.signal,
          arguments: {
            query: message.content.slice(0, 1000),
            limit: 12,
            purpose: "reflection",
            afterEvidenceAt: sourceMessages[0]!.createdAt,
            ...(queryVectors?.[index]
              ? { queryEmbedding: queryVectors[index] }
              : {}),
          },
        }),
      ),
    ),
  ]);
  const candidates = Array.from({ length: 12 }, (_, index) =>
    memoryResults.flatMap((result) =>
      result.memories[index] ? [result.memories[index]!] : [],
    ),
  ).flat();
  const memories = [
    ...new Map(candidates.map((memory) => [memory.versionId, memory])).values(),
  ].slice(0, 12);
  const cursors = memoryResults.flatMap((result) =>
    typeof result.mutationCursor === "number" ? [result.mutationCursor] : [],
  );
  const expectedMutationCursor = cursors.length
    ? Math.min(...cursors)
    : undefined;
  const withdrawals = [
    ...new Map(
      memoryResults
        .flatMap((result) => result.withdrawals ?? [])
        .map((withdrawal) => [withdrawal.versionId, withdrawal]),
    ).values(),
  ].slice(0, 12);
  const personalSkill = PersonalSkillSchema.parse(
    skillResult.skill.content,
  ) as PersonalSkill;
  const context = compileContext({
    foundationInstructions: composeFoundationInstructions([
      "zhiwei-persona",
      "dialogue-orchestrator",
      "memory-reflection",
      "profile-synthesis",
      "emotion-and-return",
      "fact-and-tool-use",
      "privacy-and-withdrawal",
    ]),
    personalSkill,
    profile: profileResult.profile,
    memories,
    memoryLimit: 12,
    sessionSummary: summary,
    messages,
    maxInputTokens: Math.min(
      18_000,
      gateway.capabilities.maxContextTokens - 2_000,
    ),
  });
  await recordTrace({
    userId: job.user_id,
    traceId,
    stage: "reflection.context_compiled",
    payload: {
      estimatedTokens: context.estimatedTokens,
      truncated: context.truncated,
      memoryVersionIds: context.memories.map((memory) => memory.versionId),
      profileSyncStatus: profileResult.profile?.syncStatus ?? "absent",
      skillVersion: skillResult.skill.version,
      context,
    },
  });

  const reflectionResult = await gateway.reflect(
    {
      userId: job.user_id,
      conversationId: payload.conversationId,
      messageId: payload.messageId,
      sourceMessages,
      batchId: job.id,
      withdrawals,
      content: payload.content,
      context,
      kind: payload.kind,
      questionId: payload.questionId,
      questionCategory: payload.questionCategory,
    },
    modelOptions,
  );
  await recordCall(
    job.user_id,
    traceId,
    payload.conversationId,
    reflectionResult.meta,
    REFLECTION_PROMPT_VERSION,
  );
  const prepared = prepareReflectionActions(
    reflectionResult.data,
    sourceMessageIds,
    settings,
  );
  await recordTrace({
    userId: job.user_id,
    traceId,
    stage: "reflection.actions.validated",
    payload: {
      proposed: reflectionResult.data.memories.length,
      accepted: prepared.actions.length,
      blockedSecretCount: prepared.blockedSecretCount,
      disabledLayerCount: prepared.disabledLayerCount,
      validityAdjustments: prepared.validityAdjustments,
      decisionReason: reflectionResult.data.decisionReason,
    },
  });
  const inputs = embeddingInputs(prepared.actions);
  const vectors = inputs.length
    ? await tryEmbedding(
        job.user_id,
        traceId,
        payload.conversationId,
        inputs.map((item) => item.content),
        "memory-write",
      )
    : [];
  const embeddings = alignEmbeddings(prepared.actions.length, inputs, vectors);
  const reflection = backgroundReflection({
    memories: prepared.actions,
    mood:
      settings.emotionTrackingEnabled === false
        ? null
        : reflectionResult.data.mood,
  });
  const committed = await callMemoryMcp<any>({
    tool: "memory_commit_reflection",
    userId: job.user_id,
    traceId,
    arguments: {
      conversationId: payload.conversationId,
      sourceMessageId: payload.messageId,
      sourceMessageIds,
      summaryEvidenceMessageIds:
        reflectionResult.data.summaryEvidenceMessageIds ?? [],
      expectedMutationCursor,
      reflection,
      embeddings,
      idempotencyKey: `reflection:${job.id}:${REFLECTION_PROMPT_VERSION}`,
    },
  });
  await enqueueMissingEmbeddings(
    job.user_id,
    traceId,
    payload.conversationId,
    committed.mutations ?? [],
  );
  if (
    isMemoryControl(payload.content) &&
    prepared.actions.length === 3 &&
    prepared.actions.every((action) => action.operation === "withdraw")
  ) {
    await enqueueJob({
      userId: job.user_id,
      type: "reflection",
      idempotencyKey: `withdrawal-continuation:${job.id}`,
      payload: { ...payload, sourceMessageIds, sealed: true, immediate: true },
    });
  }

  const canRefreshOnboardingProfile =
    payload.kind !== "onboarding" || (await isOnboardingComplete(job.user_id));
  if (committed.longTermChanged && canRefreshOnboardingProfile) {
    const longMemories = await listLongMemories(job.user_id, traceId);
    if (shouldConsolidateMemories(consolidationMemories(longMemories))) {
      await enqueueJob({
        userId: job.user_id,
        type: "memory_consolidation",
        idempotencyKey: `memory_consolidation:${payload.messageId}:${CONSOLIDATION_PROMPT_VERSION}`,
        payload: {
          sourceMessageId: payload.messageId,
          conversationId: payload.conversationId,
          traceId,
        },
      });
    } else {
      await enqueueProfileSynthesis(job.user_id, {
        sourceMessageId: payload.messageId,
        conversationId: payload.conversationId,
        traceId,
        trigger: "long-memory-change",
        idempotencySuffix: payload.messageId,
      });
    }
  }
  if (
    reflectionResult.data.summaryEvidenceMessageIds?.length &&
    shouldRefreshSessionSummary(reflectionResult.data, summary, messages.length)
  ) {
    await enqueueJob({
      userId: job.user_id,
      type: "session_summary",
      idempotencyKey: `session_summary:${payload.messageId}:v2`,
      payload: {
        conversationId: payload.conversationId,
        sourceMessageId: payload.messageId,
        traceId,
      },
    });
  }
  if (
    reflectionResult.data.returnTopic &&
    settings.returnNotesEnabled !== false
  ) {
    await enqueueJob({
      userId: job.user_id,
      type: "return_note",
      idempotencyKey: `return_note:${payload.messageId}:v2`,
      payload: {
        conversationId: payload.conversationId,
        sourceMessageId: payload.messageId,
        topic: reflectionResult.data.returnTopic,
        profileSummary: profileResult.profile?.summary,
        traceId,
      },
    });
  }
  if (
    reflectionResult.data.shouldEvolveSkill &&
    settings.skillEvolutionEnabled !== false
  ) {
    await enqueueJob({
      userId: job.user_id,
      type: "evolve_skill",
      idempotencyKey: `evolve_skill:${payload.messageId}:v2`,
      payload: {
        evidenceIds: [payload.messageId],
        latestUserMessage: payload.content,
        profileSummary: profileResult.profile?.summary,
        feedbackReason: reflectionResult.data.evolutionReason,
        traceId,
      },
    });
  }

  await recordTrace({
    userId: job.user_id,
    traceId,
    stage: "reflection.completed",
    durationMs: Date.now() - started,
    payload: {
      gateway: gateway.id,
      decision: reflectionResult.data,
      prepared,
      committed,
    },
  });
  await addActivity({
    userId: job.user_id,
    type: "memory.updated",
    payload: {
      sourceMessageId: payload.messageId,
      memoryCount: committed.memoryCount,
      longTermChanged: committed.longTermChanged,
      profilePending: committed.longTermChanged,
    },
  });
}

async function handleProfileSynthesis(job: any) {
  const payload = job.payload as {
    sourceMessageId?: string;
    conversationId?: string;
    traceId?: string;
    trigger?: string;
  };
  const traceId = payload.traceId ?? crypto.randomUUID();
  const settings = await getUserSettings(job.user_id);
  if (
    settings.memoryEnabled === false ||
    settings.longTermMemoryEnabled === false
  ) {
    await recordTrace({
      userId: job.user_id,
      traceId,
      stage: "profile.synthesis.paused",
      payload: { trigger: payload.trigger },
    });
    return;
  }
  const listed = await listLongMemories(job.user_id, traceId);
  if (!listed.length) return;
  const memories = profileMemories(listed);
  const profileSourceVersionIds = listed
    .filter(
      (memory) =>
        (memory.status ?? "active") === "active" && memory.tier === "long",
    )
    .map((memory) => memory.versionId);
  const current = await callMemoryMcp<{ profile: ProfileSnapshot | null }>({
    tool: "profile_get_current",
    userId: job.user_id,
    traceId,
  });
  const result = await gateway.synthesizeProfile(
    { memories, currentSummary: current.profile?.summary },
    modelOptions,
  );
  await recordCall(
    job.user_id,
    traceId,
    payload.conversationId,
    result.meta,
    PROFILE_PROMPT_VERSION,
  );
  const committed = await callMemoryMcp<any>({
    tool: "profile_commit_snapshot",
    userId: job.user_id,
    traceId,
    arguments: {
      summary: result.data.summary,
      dimensionWeights: normalizeDimensionWeights(result.data.dimensionWeights),
      sourceMemoryVersionIds: profileSourceVersionIds,
      schemaVersion: result.data.schemaVersion,
      idempotencyKey: `profile_synthesis:${profileSourceSignature(profileSourceVersionIds, settings.emotionTrackingEnabled !== false)}:${PROFILE_PROMPT_VERSION}`,
    },
  });
  await recordTrace({
    userId: job.user_id,
    traceId,
    stage: "profile.synthesis.completed",
    payload: {
      trigger: payload.trigger,
      sourceMemoryVersionIds: profileSourceVersionIds,
      summarySourceMemoryVersionIds: result.data.sourceMemoryVersionIds,
      schemaVersion: result.data.schemaVersion,
      profileId: committed.profile?.id,
      score: committed.profile?.score,
    },
  });
  const receipt = "知微重新整理了对你的长期认识。";
  const assistantMessageId =
    payload.sourceMessageId && payload.conversationId
      ? await attachMemoryReceipt({
          userId: job.user_id,
          conversationId: payload.conversationId,
          sourceMessageId: payload.sourceMessageId,
          receipt,
        }).catch(() => null)
      : null;
  await addActivity({
    userId: job.user_id,
    type: "profile.updated",
    payload: {
      conversationId: payload.conversationId,
      sourceMessageId: payload.sourceMessageId,
      assistantMessageId,
      traceId,
      profile: committed.profile,
      receipt,
    },
  });
}

async function handleSessionSummary(job: any) {
  const payload = job.payload as {
    conversationId: string;
    sourceMessageId: string;
    throughMessageId?: string;
    traceId?: string;
  };
  const traceId = payload.traceId ?? crypto.randomUUID();
  const [messages, previousSummary] = await Promise.all([
    listMessagesThrough(
      job.user_id,
      payload.conversationId,
      payload.throughMessageId ?? payload.sourceMessageId,
      36,
      true,
    ),
    getConversationSummary(job.user_id, payload.conversationId),
  ]);
  if (!messages.length) return;
  const result = await gateway.summarizeSession(
    { messages, previousSummary: previousSummary ?? undefined },
    modelOptions,
  );
  await recordCall(
    job.user_id,
    traceId,
    payload.conversationId,
    result.meta,
    "session-summary-v2",
  );
  await callMemoryMcp({
    tool: "memory_commit_reflection",
    userId: job.user_id,
    traceId,
    arguments: {
      conversationId: payload.conversationId,
      sourceMessageId: payload.sourceMessageId,
      reflection: backgroundReflection({
        nextSessionSummary: result.data.summary,
      }),
      idempotencyKey: `session_summary:${job.id}:v3`,
    },
  });
  await recordTrace({
    userId: job.user_id,
    traceId,
    stage: "session.summary.completed",
    payload: { conversationId: payload.conversationId },
  });
}

async function handleReturnNote(job: any) {
  const payload = job.payload as {
    conversationId: string;
    sourceMessageId: string;
    topic: string;
    profileSummary?: string;
    traceId?: string;
  };
  const traceId = payload.traceId ?? crypto.randomUUID();
  const result = await gateway.generateReturnNote(
    { topic: payload.topic, profileSummary: payload.profileSummary },
    modelOptions,
  );
  await recordCall(
    job.user_id,
    traceId,
    payload.conversationId,
    result.meta,
    "return-note-v2",
  );
  const now = Date.now();
  const returnNote = {
    content: result.data.content,
    validAfter: new Date(now + 6 * 60 * 60 * 1_000).toISOString(),
    expiresAt: new Date(now + 72 * 60 * 60 * 1_000).toISOString(),
  };
  await callMemoryMcp({
    tool: "memory_commit_reflection",
    userId: job.user_id,
    traceId,
    arguments: {
      conversationId: payload.conversationId,
      sourceMessageId: payload.sourceMessageId,
      reflection: backgroundReflection({ returnNote }),
      idempotencyKey: `return_note:${payload.sourceMessageId}:v2`,
    },
  });
  await recordTrace({
    userId: job.user_id,
    traceId,
    stage: "return-note.completed",
    payload: {
      conversationId: payload.conversationId,
      validAfter: returnNote.validAfter,
    },
  });
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
  const currentResult = await callMemoryMcp<any>({
    tool: "personal_skill_get_active",
    userId: job.user_id,
    traceId,
  });
  const currentSkill = PersonalSkillSchema.parse(currentResult.skill.content);
  const result = await gateway.evolvePersonalSkill(
    { currentSkill, ...payload },
    { ...modelOptions, deep: payload.feedback === "not-me" },
  );
  const nextSkill = PersonalSkillSchema.parse(result.data);
  const published = await callMemoryMcp<any>({
    tool: "personal_skill_publish_rewrite",
    userId: job.user_id,
    traceId,
    arguments: { skill: nextSkill, idempotencyKey: `skill:${job.id}:v3` },
  });
  await recordCall(
    job.user_id,
    traceId,
    undefined,
    result.meta,
    "personal-skill-v2",
  );
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

async function handleMemoryEmbedding(job: any) {
  const payload = job.payload as {
    memoryId: string;
    versionId: string;
    content: string;
    conversationId?: string;
    traceId?: string;
  };
  const traceId = payload.traceId ?? crypto.randomUUID();
  const result = await gateway.embed([payload.content], modelOptions);
  await recordCall(
    job.user_id,
    traceId,
    payload.conversationId,
    result.meta,
    "memory-embedding-v1",
  );
  await callMemoryMcp({
    tool: "memory_set_embedding",
    userId: job.user_id,
    traceId,
    arguments: {
      memoryId: payload.memoryId,
      versionId: payload.versionId,
      embedding: result.data[0],
      idempotencyKey: `memory_embedding:${payload.versionId}:v1`,
    },
  });
  await recordTrace({
    userId: job.user_id,
    traceId,
    stage: "memory.embedding.completed",
    payload: { memoryId: payload.memoryId, versionId: payload.versionId },
  });
}

async function handleMemoryConsolidation(job: any) {
  const payload = job.payload as {
    sourceMessageId?: string;
    conversationId?: string;
    traceId?: string;
  };
  const traceId = payload.traceId ?? crypto.randomUUID();
  const listed = await listLongMemories(job.user_id, traceId);
  const memories = consolidationMemories(listed);
  if (!shouldConsolidateMemories(memories)) {
    await recordTrace({
      userId: job.user_id,
      traceId,
      stage: "memory.consolidation.skipped",
      payload: { count: memories.length },
    });
    await enqueueProfileSynthesis(job.user_id, {
      sourceMessageId: payload.sourceMessageId,
      conversationId: payload.conversationId,
      traceId,
      trigger: "consolidation-not-needed",
      idempotencySuffix: job.id,
    });
    return;
  }

  const consolidationInput = {
    memories,
    targetCount: CONSOLIDATION_TARGET_COUNT,
    targetTokens: CONSOLIDATION_TARGET_TOKENS,
  };
  const plan = await gateway.planMemoryConsolidation(
    consolidationInput,
    modelOptions,
  );
  await recordCall(
    job.user_id,
    traceId,
    payload.conversationId,
    plan.meta,
    `${CONSOLIDATION_PROMPT_VERSION}-plan`,
  );
  await recordTrace({
    userId: job.user_id,
    traceId,
    stage: "memory.consolidation.planned",
    payload: { plan: plan.data, sourceCount: memories.length },
  });
  const review = await gateway.reviewMemoryConsolidation(
    { ...consolidationInput, plan: plan.data },
    modelOptions,
  );
  await recordCall(
    job.user_id,
    traceId,
    payload.conversationId,
    review.meta,
    `${CONSOLIDATION_PROMPT_VERSION}-review`,
  );
  await recordTrace({
    userId: job.user_id,
    traceId,
    stage: "memory.consolidation.reviewed",
    payload: { review: review.data },
  });
  if (!review.data.approved) throw new Error("memory_consolidation_rejected");

  const committed = await callMemoryMcp<any>({
    tool: "memory_commit_consolidation",
    userId: job.user_id,
    traceId,
    arguments: {
      rewrites: plan.data.rewrites.map(
        ({ topic: _topic, ...rewrite }) => rewrite,
      ),
      verification: {
        approved: review.data.approved,
        checkedSourceVersionIds: review.data.checkedSourceVersionIds,
        omittedFacts: review.data.omittedFacts,
        contradictions: review.data.contradictions,
        overInferences: review.data.overInferences,
      },
      idempotencyKey: `memory_consolidation:${job.id}:${CONSOLIDATION_PROMPT_VERSION}`,
    },
  });
  await enqueueMissingEmbeddings(
    job.user_id,
    traceId,
    payload.conversationId,
    committed.mutations ?? [],
  );
  await enqueueProfileSynthesis(job.user_id, {
    sourceMessageId: payload.sourceMessageId,
    conversationId: payload.conversationId,
    traceId,
    trigger: "memory-consolidated",
    idempotencySuffix: job.id,
  });
  await recordTrace({
    userId: job.user_id,
    traceId,
    stage: "memory.consolidation.completed",
    payload: { committed },
  });
}

async function listLongMemories(
  userId: string,
  traceId: string,
): Promise<MemoryRecord[]> {
  const result = await callMemoryMcp<{ memories: MemoryRecord[] }>({
    tool: "memory_list",
    userId,
    traceId,
    arguments: { tiers: ["long"], statuses: ["active"], limit: 1_000 },
  });
  return result.memories;
}

async function enqueueProfileSynthesis(
  userId: string,
  input: {
    sourceMessageId?: string;
    conversationId?: string;
    traceId?: string;
    trigger: string;
    idempotencySuffix: string;
  },
) {
  const sourceMemories = await listLongMemories(
    userId,
    input.traceId ?? crypto.randomUUID(),
  );
  const settings = await getUserSettings(userId);
  const sourceSignature = profileSourceSignature(
    sourceMemories
      .filter(
        (memory) =>
          (memory.status ?? "active") === "active" && memory.tier === "long",
      )
      .map((memory) => memory.versionId),
    settings.emotionTrackingEnabled !== false,
  );
  await enqueueJob({
    userId,
    type: "profile_synthesis",
    idempotencyKey: `profile_synthesis:sources:${sourceSignature}:${PROFILE_PROMPT_VERSION}`,
    payload: { ...input, sourceSignature },
  });
}

function profileSourceSignature(
  versionIds: string[],
  emotionTrackingEnabled: boolean,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        versionIds: [...new Set(versionIds)].sort(),
        emotionTrackingEnabled,
      }),
    )
    .digest("hex")
    .slice(0, 20);
}

async function enqueueMissingEmbeddings(
  userId: string,
  traceId: string,
  conversationId: string | undefined,
  mutations: Array<{
    memoryId: string;
    versionId: string;
    content: string;
    embeddingMissing: boolean;
    status: string;
  }>,
) {
  for (const mutation of mutations) {
    if (!mutation.embeddingMissing || mutation.status !== "active") continue;
    await enqueueJob({
      userId,
      type: "memory_embedding",
      idempotencyKey: `memory_embedding:${mutation.versionId}:v1`,
      payload: { ...mutation, conversationId, traceId },
    });
  }
}

async function tryEmbedding(
  userId: string,
  traceId: string,
  conversationId: string,
  texts: string[],
  purpose: "retrieval" | "memory-write",
) {
  if (!texts.length) return [];
  try {
    const result = await gateway.embed(texts, modelOptions);
    await recordCall(
      userId,
      traceId,
      conversationId,
      result.meta,
      purpose === "retrieval"
        ? "retrieval-embedding-v1"
        : "memory-embedding-v1",
    );
    return result.data;
  } catch (error) {
    const failedMeta = (error as { modelMeta?: any })?.modelMeta;
    if (failedMeta)
      await recordCall(userId, traceId, conversationId, failedMeta).catch(
        () => undefined,
      );
    await recordTrace({
      userId,
      traceId,
      stage:
        purpose === "retrieval"
          ? "retrieval.degraded"
          : "memory.embedding.deferred",
      payload: {
        code: publicErrorCode(error),
        message:
          purpose === "retrieval"
            ? "向量服务暂时不可用，本次已改用关键词检索。"
            : "向量服务暂时不可用，记忆已先以关键词检索生效并安排后台补齐。",
      },
    });
    return null;
  }
}

async function recordCall(
  userId: string,
  traceId: string,
  conversationId: string | undefined,
  meta: any,
  promptVersion?: string,
) {
  await recordModelCallMeta({
    userId,
    traceId,
    conversationId,
    adapterId: gateway.id,
    meta,
    promptVersion,
  });
}

function publicErrorCode(error: unknown) {
  const code = error instanceof Error ? error.message : String(error);
  return [
    "rate_limited",
    "provider_unavailable",
    "invalid_response",
    "request_cancelled",
    "memory_version_conflict",
    "memory_consolidation_rejected",
  ].includes(code)
    ? code
    : "background_failed";
}
