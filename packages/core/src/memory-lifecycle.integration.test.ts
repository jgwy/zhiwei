import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addMessage,
  commitMemoryConsolidation,
  commitProfileSnapshot,
  commitReflection,
  createConversation,
  deleteAllUserData,
  ensureUser,
  getProfileForContext,
  listMemoriesForUser,
  recordMemoryUsage,
  restoreMemoryVersion,
  searchMemories,
  setMemoryEmbedding,
  updateSettings,
  withdrawMemory,
} from "./repository";
import { closePool } from "./db";

const integration = process.env.INTEGRATION_DATABASE_URL ? describe : describe.skip;

integration("memory lifecycle with PostgreSQL", () => {
  const userId = crypto.randomUUID();
  const originalDatabaseUrl = process.env.DATABASE_URL;

  beforeAll(async () => {
    await closePool();
    process.env.DATABASE_URL = process.env.INTEGRATION_DATABASE_URL!;
  });

  afterAll(async () => {
    try {
      await deleteAllUserData(userId);
    } finally {
      await closePool();
      if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = originalDatabaseUrl;
    }
  });

  it("keeps direct memory writes scoped, idempotent, reversible and auditable", async () => {
    await ensureUser(userId);
    const firstConversation = await createConversation(userId);
    const firstMessage = await addMessage({
      userId,
      conversationId: firstConversation.id,
      role: "user",
      content: "我这周要准备物理考试",
    });

    const firstCommit = await commitReflection({
      userId,
      conversationId: firstConversation.id,
      sourceMessageId: firstMessage.id,
      idempotencyKey: `reflection:${firstMessage.id}:v2`,
      reflection: {
        memories: [{
          operation: "create",
          category: "challenge",
          content: "这周正在准备物理考试",
          tier: "short",
          confidence: 0.99,
          validUntil: null,
          reason: "用户明确提到近期任务",
          evidenceMessageIds: [firstMessage.id],
        }],
        mood: null,
      },
    });
    expect(firstCommit.memoryCount).toBe(1);
    expect(firstCommit.receipt.replayed).toBe(false);
    expect(firstCommit.mutations[0]?.embeddingMissing).toBe(true);
    const firstMemory = firstCommit.mutations[0]!;

    const replay = await commitReflection({
      userId,
      conversationId: firstConversation.id,
      sourceMessageId: firstMessage.id,
      idempotencyKey: `reflection:${firstMessage.id}:v2`,
      reflection: { memories: [], mood: null },
    });
    expect(replay.receipt.replayed).toBe(true);
    expect(replay.mutations[0]?.versionId).toBe(firstMemory.versionId);

    await createConversation(userId);
    const crossConversation = await searchMemories(userId, "物理考试", 8);
    expect(crossConversation.some((memory) => memory.versionId === firstMemory.versionId)).toBe(true);
    expect(new Date(crossConversation.find((memory) => memory.versionId === firstMemory.versionId)!.validUntil!).getTime())
      .toBeGreaterThan(Date.now() + 6 * 86_400_000);

    await setMemoryEmbedding({
      userId,
      memoryId: firstMemory.memoryId,
      versionId: firstMemory.versionId,
      embedding: Array.from({ length: 1024 }, (_, index) => index === 0 ? 1 : 0),
      idempotencyKey: `embedding:${firstMemory.versionId}`,
    });
    await recordMemoryUsage({
      userId,
      conversationId: firstConversation.id,
      versionIds: [firstMemory.versionId],
      idempotencyKey: `usage:${firstMessage.id}`,
    });

    const withdrawn = await withdrawMemory({
      userId,
      memoryId: firstMemory.memoryId,
      versionId: firstMemory.versionId,
      reason: "不再记录这件事",
      idempotencyKey: `withdraw:${firstMemory.versionId}`,
    });
    expect(withdrawn.tier).toBe("short");
    expect((await searchMemories(userId, "物理考试", 8))).toHaveLength(0);

    await expect(commitReflection({
      userId,
      conversationId: firstConversation.id,
      sourceMessageId: firstMessage.id,
      idempotencyKey: `reflection:${firstMessage.id}:late`,
      reflection: {
        memories: [{
          operation: "create",
          category: "challenge",
          content: "这周正在准备物理考试",
          tier: "short",
          confidence: 0.8,
          validUntil: null,
          reason: "积压任务",
          evidenceMessageIds: [firstMessage.id],
        }],
      },
    })).rejects.toThrow("memory_stale_after_withdrawal");

    const laterMessage = await addMessage({
      userId,
      conversationId: firstConversation.id,
      role: "user",
      content: "请重新记住，我这周要准备物理考试",
    });
    const relearned = await commitReflection({
      userId,
      conversationId: firstConversation.id,
      sourceMessageId: laterMessage.id,
      idempotencyKey: `reflection:${laterMessage.id}:v2`,
      reflection: {
        memories: [{
          operation: "create",
          category: "challenge",
          content: "这周正在准备物理考试",
          tier: "short",
          confidence: 0.8,
          validUntil: null,
          reason: "用户在撤回后重新表达",
          evidenceMessageIds: [laterMessage.id],
        }],
      },
    });
    expect(relearned.memoryCount).toBe(1);

    await updateSettings(userId, { emotionTrackingEnabled: false });
    const emotionMessage = await addMessage({
      userId,
      conversationId: firstConversation.id,
      role: "user",
      content: "今天心情有点低落",
    });
    const emotion = await commitReflection({
      userId,
      conversationId: firstConversation.id,
      sourceMessageId: emotionMessage.id,
      idempotencyKey: `reflection:${emotionMessage.id}:v2`,
      reflection: {
        memories: [{
          operation: "create",
          category: "emotion",
          content: "今天心情有点低落",
          tier: "short",
          confidence: 0.9,
          validUntil: null,
          reason: "情绪片段",
          evidenceMessageIds: [emotionMessage.id],
        }],
        mood: { score: -2, summary: "有些低落", meaningful: true },
      },
    });
    expect(emotion.memoryCount).toBe(0);

    await updateSettings(userId, { emotionTrackingEnabled: true });
    const longMessage = await addMessage({
      userId,
      conversationId: firstConversation.id,
      role: "user",
      content: "我长期喜欢跑步，也喜欢阅读",
    });
    const longCommit = await commitReflection({
      userId,
      conversationId: firstConversation.id,
      sourceMessageId: longMessage.id,
      idempotencyKey: `reflection:${longMessage.id}:v2`,
      reflection: {
        memories: ["跑步", "阅读"].map((topic) => ({
          operation: "create" as const,
          category: "interest" as const,
          content: `长期喜欢${topic}`,
          tier: "long" as const,
          confidence: 0.8,
          validUntil: null,
          reason: "稳定兴趣",
          evidenceMessageIds: [longMessage.id],
        })),
      },
    });
    expect(longCommit.longTermChanged).toBe(true);

    const consolidation = await commitMemoryConsolidation({
      userId,
      idempotencyKey: `consolidate:${longMessage.id}`,
      rewrites: [{
        sourceVersionIds: longCommit.mutations.map((mutation) => mutation.versionId),
        category: "interest",
        content: "长期喜欢跑步和阅读",
        confidence: 0.8,
        reason: "同主题稳定兴趣收拢",
      }],
      verification: {
        approved: true,
        checkedSourceVersionIds: longCommit.mutations.map((mutation) => mutation.versionId),
        omittedFacts: [],
        contradictions: [],
        overInferences: [],
      },
    });
    expect(consolidation.memoryCount).toBe(1);
    const consolidatedVersionId = consolidation.mutations[0]!.versionId;

    const activeLong = await listMemoriesForUser(userId, { tiers: ["long"], statuses: ["active"], limit: 1000 });
    const profile = await commitProfileSnapshot({
      userId,
      summary: "你长期喜欢跑步和阅读，也在认真面对阶段性的学习任务。",
      dimensionWeights: { interest: 1, challenge: 1 },
      sourceMemoryVersionIds: activeLong.filter((memory) => !["emotion", "boundary"].includes(memory.category)).map((memory) => memory.versionId),
      schemaVersion: "long-profile-v2",
      idempotencyKey: `profile:${consolidatedVersionId}`,
    });
    expect(profile.syncStatus).toBe("current");
    expect((await getProfileForContext(userId))?.id).toBe(profile.id);

    const restored = await restoreMemoryVersion({
      userId,
      memoryId: firstMemory.memoryId,
      versionId: firstMemory.versionId,
      expectedActiveVersionId: null,
      idempotencyKey: `restore:${firstMemory.versionId}`,
    });
    expect(restored.memory.status).toBe("active");
    expect(restored.memory.validUntil).not.toBeNull();
  }, 20_000);
});
