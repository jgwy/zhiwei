import { afterAll, describe, expect, it } from "vitest";
import {
  addMessage,
  closePool,
  commitReflection,
  confirmMemory,
  createConversation,
  deleteAllUserData,
  ensureUser,
  getPool,
  listMemoriesForUser,
  recordMemoryUsage,
  rejectMemory,
  searchMemories,
  withdrawMemory,
} from "./index";
import type { MemoryMutation, ReflectionOutput } from "./types";

const runIntegration = process.env.RUN_DB_INTEGRATION === "true";
const integration = runIntegration ? describe : describe.skip;
const equalWeights = {
  basic: 1,
  goal: 1,
  interest: 1,
  expression: 1,
  emotion: 1,
  experience: 1,
  challenge: 1,
  boundary: 1,
};

integration("memory lifecycle with PostgreSQL", () => {
  const userId = crypto.randomUUID();

  afterAll(async () => {
    await deleteAllUserData(userId).catch(() => undefined);
    await closePool();
  });

  it("isolates short memory, confirms by version, replays idempotently, and keeps withdrawals final", async () => {
    await ensureUser(userId);
    const conversationA = await createConversation(userId);
    const conversationB = await createConversation(userId);
    const source = await addMessage({
      userId,
      conversationId: conversationA.id,
      role: "user",
      content: "我喜欢周末跑步，这周五前要交设计稿；最近压力大时我常常只想先安静一会儿。",
    });

    const initial = await commitReflection({
      userId,
      conversationId: conversationA.id,
      sourceMessageId: source.id,
      reflection: reflection([
        mutation(source.id, {
          category: "interest",
          content: "喜欢周末跑步",
          tier: "long",
          sourceType: "user_stated",
          evidenceQuote: "喜欢周末跑步",
        }),
        mutation(source.id, {
          category: "challenge",
          content: "这周五前要交设计稿",
          tier: "short",
          sourceType: "user_stated",
          evidenceQuote: "这周五前要交设计稿",
        }),
        mutation(source.id, {
          category: "expression",
          content: "在压力出现时可能更需要先倾听",
          tier: "long",
          sourceType: "inferred",
        }),
      ]),
      idempotencyKey: `reflection:${source.id}:integration-v1`,
    });
    expect(initial.memoryCount).toBe(3);

    const listed = await listMemoriesForUser(userId);
    const short = listed.find((memory) => memory.tier === "short");
    const pending = listed.find((memory) => memory.status === "pending");
    expect(short).toMatchObject({ status: "active", scope: "conversation", scopeKey: conversationA.id });
    expect(pending).toBeDefined();

    const inA = await searchMemories(userId, "设计稿", 8, undefined, { conversationId: conversationA.id });
    const inB = await searchMemories(userId, "设计稿", 8, undefined, { conversationId: conversationB.id });
    expect(inA.some((memory) => memory.versionId === short?.versionId)).toBe(true);
    expect(inB.some((memory) => memory.versionId === short?.versionId)).toBe(false);
    expect(inA.some((memory) => memory.versionId === pending?.versionId)).toBe(false);

    const confirmKey = `confirm:${pending!.id}:${pending!.versionId}`;
    const confirmed = await confirmMemory({
      userId,
      memoryId: pending!.id,
      versionId: pending!.versionId,
      idempotencyKey: confirmKey,
    });
    const replayed = await confirmMemory({
      userId,
      memoryId: pending!.id,
      versionId: pending!.versionId,
      idempotencyKey: confirmKey,
    });
    expect(confirmed.memory.versionId).not.toBe(pending!.versionId);
    expect(confirmed.memory.confirmedAt).toBeTruthy();
    expect(replayed.memory.versionId).toBe(confirmed.memory.versionId);
    expect(replayed.receipt.replayed).toBe(true);
    await expect(rejectMemory({
      userId,
      memoryId: pending!.id,
      versionId: pending!.versionId,
      idempotencyKey: `reject-stale:${pending!.versionId}`,
    })).rejects.toThrow("memory_version_conflict");

    const correctionSource = await addMessage({
      userId,
      conversationId: conversationA.id,
      role: "user",
      content: "其实我在压力大时更希望你和我一起梳理。",
    });
    await commitReflection({
      userId,
      conversationId: conversationA.id,
      sourceMessageId: correctionSource.id,
      reflection: reflection([
        mutation(correctionSource.id, {
          operation: "supersede",
          memoryId: pending!.id,
          expectedVersionId: confirmed.memory.versionId,
          category: "expression",
          content: "压力大时更希望和知微一起梳理",
          tier: "long",
          sourceType: "user_stated",
          evidenceQuote: "压力大时更希望你和我一起梳理",
        }),
      ]),
      idempotencyKey: `reflection:${correctionSource.id}:integration-v1`,
    });
    const pendingCorrection = (await listMemoriesForUser(userId)).find((memory) => (
      memory.id === pending!.id && memory.status === "pending"
    ));
    expect(pendingCorrection).toBeDefined();

    const withdrawn = await withdrawMemory({
      userId,
      memoryId: pending!.id,
      versionId: confirmed.memory.versionId,
      idempotencyKey: `withdraw:${confirmed.memory.versionId}`,
    });
    expect(withdrawn.tier).toBe("long");
    expect((await listMemoriesForUser(userId)).some((memory) => memory.id === pending!.id)).toBe(false);

    const staleReplay = await commitReflection({
      userId,
      conversationId: conversationA.id,
      sourceMessageId: source.id,
      reflection: reflection([
        mutation(source.id, {
          category: "expression",
          content: "在压力出现时可能更需要先倾听",
          tier: "long",
          sourceType: "inferred",
        }),
      ]),
      idempotencyKey: `reflection:${source.id}:stale-replay`,
    });
    expect(staleReplay.memoryCount).toBe(0);

    const activeLong = (await listMemoriesForUser(userId)).find((memory) => memory.status === "active" && memory.tier === "long");
    expect(activeLong).toBeDefined();
    const usage = await recordMemoryUsage({
      userId,
      conversationId: conversationB.id,
      versionIds: [activeLong!.versionId],
      idempotencyKey: `usage:${conversationB.id}:integration`,
    });
    expect(usage.count).toBe(1);

    await deleteAllUserData(userId);
    const tables = await getPool().query(
      `SELECT table_name FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name = 'user_id'`,
    );
    for (const { table_name: tableName } of tables.rows) {
      const remaining = await getPool().query(`SELECT count(*)::int AS count FROM ${tableName} WHERE user_id = $1`, [userId]);
      expect(remaining.rows[0].count, tableName).toBe(0);
    }
  });
});

function mutation(messageId: string, overrides: Partial<MemoryMutation>): MemoryMutation {
  return {
    operation: "create",
    category: "interest",
    content: "一条测试记忆",
    tier: "long",
    confidence: 0.78,
    validUntil: null,
    reason: "集成测试",
    evidenceMessageIds: [messageId],
    ...overrides,
  };
}

function reflection(memories: MemoryMutation[]): ReflectionOutput {
  return {
    memories,
    profileSummary: "集成测试画像",
    dimensionWeights: equalWeights,
    mood: null,
    sessionSummary: "集成测试摘要",
    returnNote: null,
    shouldEvolveSkill: false,
    evolutionReason: null,
    profileChanged: false,
    summaryChanged: false,
  };
}
