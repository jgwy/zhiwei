import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("./db", () => ({
  getPool: () => database,
  withTransaction: vi.fn((operation) => operation(database)),
}));

import { addMessage, commitReflection, rankMemories, recordModelRun, searchMemories, updateConversationTitle } from "./repository";
import type { MemoryRecord } from "./types";

function memory(overrides: Partial<MemoryRecord> & Pick<MemoryRecord, "id" | "content">): MemoryRecord {
  return {
    versionId: crypto.randomUUID(),
    category: "interest",
    tier: "short",
    confidence: 0.5,
    validUntil: null,
    eventTime: { kind: "unknown", start: null, end: null, precision: "unknown", expression: null, timeZone: null },
    firstObservedAt: null,
    lastConfirmedAt: null,
    reason: "测试证据",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("memory retrieval", () => {
  beforeEach(() => database.query.mockReset());

  it("ranks lexical relevance, confidence and long-term value deterministically", () => {
    const lexical = memory({ id: crypto.randomUUID(), content: "喜欢在周末跑步", confidence: 0.8 });
    const confident = memory({ id: crypto.randomUUID(), content: "目前专注阅读", confidence: 0.95, tier: "long" });
    const unrelated = memory({ id: crypto.randomUUID(), content: "偏好安静环境", confidence: 0.2 });

    const ranked = rankMemories([unrelated, confident, lexical], "周末 跑步", 2);

    expect(ranked.map((item) => item.id)).toEqual([lexical.id, confident.id]);
  });

  it("prefers a recently confirmed short-term state over an old equivalent state", () => {
    const recent = memory({ id: crypto.randomUUID(), content: "最近工作压力很大", category: "emotion", lastConfirmedAt: new Date().toISOString() });
    const old = memory({ id: crypto.randomUUID(), content: "最近工作压力很大", category: "emotion", lastConfirmedAt: new Date(Date.now() - 120 * 86_400_000).toISOString() });

    expect(rankMemories([old, recent], "工作压力", 2).map((item) => item.id)).toEqual([recent.id, old.id]);
  });

  it("does not decay stable long-term boundaries solely because they are old", () => {
    const old = memory({ id: crypto.randomUUID(), content: "不要主动提及家人", category: "boundary", tier: "long", lastConfirmedAt: "2020-01-01T00:00:00.000Z" });
    const recent = memory({ id: crypto.randomUUID(), content: "不要主动提及家人", category: "boundary", tier: "long", lastConfirmedAt: new Date().toISOString() });

    expect(rankMemories([old, recent], "家人", 2).map((item) => item.id)).toEqual([old.id, recent.id]);
  });

  it("uses a 1024-dimensional embedding and keeps the database query user-scoped", async () => {
    const userId = crypto.randomUUID();
    const now = new Date().toISOString();
    database.query.mockResolvedValue({
      rowCount: 2,
      rows: [
        {
          id: crypto.randomUUID(), version_id: crypto.randomUUID(), category: "interest",
          content: "与问题无关但向量接近", tier: "short", confidence: 0.5,
          valid_until: null, reason: "测试", created_at: now, similarity: 0.95,
        },
        {
          id: crypto.randomUUID(), version_id: crypto.randomUUID(), category: "interest",
          content: "喜欢周末跑步", tier: "long", confidence: 0.9,
          valid_until: null, reason: "测试", created_at: now, similarity: 0.75,
        },
      ],
    });

    const result = await searchMemories(userId, "周末 跑步", 1, Array.from({ length: 1024 }, () => 0.01));

    expect(result).toHaveLength(1);
    expect(result[0]?.content).toBe("喜欢周末跑步");
    expect(database.query).toHaveBeenCalledTimes(1);
    const [sql, parameters] = database.query.mock.calls[0]!;
    expect(sql).toContain("WHERE m.user_id = $1");
    expect(parameters[0]).toBe(userId);
    expect(String(parameters[1]).split(",")).toHaveLength(1024);
  });

  it("falls back to keyword retrieval when an embedding has the wrong dimension", async () => {
    const userId = crypto.randomUUID();
    database.query.mockResolvedValue({
      rowCount: 1,
      rows: [{
        id: crypto.randomUUID(), version_id: crypto.randomUUID(), category: "goal",
        content: "希望完成毕业论文", tier: "long", confidence: 0.8,
        valid_until: null, reason: "测试", created_at: new Date().toISOString(),
      }],
    });

    const result = await searchMemories(userId, "毕业论文", 8, [0.1, 0.2]);

    expect(result[0]?.content).toBe("希望完成毕业论文");
    expect(database.query).toHaveBeenCalledTimes(1);
    expect(database.query.mock.calls[0]?.[0]).not.toContain("embedding_v2 <=>");
    expect(database.query.mock.calls[0]?.[1]).toEqual([userId]);
  });

  it("updates a title within the current user scope and preserves the manual lock guard", async () => {
    database.query.mockResolvedValue({ rowCount: 1, rows: [] });
    const userId = crypto.randomUUID();
    const conversationId = crypto.randomUUID();

    await updateConversationTitle(userId, conversationId, "模型生成的会话标题", "model");
    await updateConversationTitle(userId, conversationId, "我自己改的标题", "manual");

    const [modelSql, modelParameters] = database.query.mock.calls[0]!;
    expect(modelSql).toContain("title_locked = false");
    expect(modelParameters).toEqual([conversationId, userId, "模型生成的会话标题", "model"]);
    expect(database.query.mock.calls[1]?.[1]).toEqual([conversationId, userId, "我自己改的标题", "manual"]);
  });

  it("allocates a stable per-conversation message sequence before inserting", async () => {
    const userId = crypto.randomUUID();
    const conversationId = crypto.randomUUID();
    database.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ sequence_no: 9 }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{
        id: crypto.randomUUID(), role: "user", content: "测试", created_at: new Date().toISOString(), sequence_no: 9, metadata: {},
      }] });

    const message = await addMessage({ userId, conversationId, role: "user", content: "测试" });

    expect(message.sequence).toBe(9);
    expect(database.query.mock.calls[0]?.[0]).toContain("next_message_sequence = next_message_sequence + 1");
    expect(database.query.mock.calls[1]?.[0]).toContain("sequence_no");
  });

  it("reinforces an active memory by appending evidence without creating a version", async () => {
    const userId = crypto.randomUUID();
    const conversationId = crypto.randomUUID();
    const messageId = crypto.randomUUID();
    const memoryId = crypto.randomUUID();
    const versionId = crypto.randomUUID();
    const observedAt = new Date().toISOString();
    database.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ settings: { memoryEnabled: true } }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: messageId, created_at: observedAt }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: versionId }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    await commitReflection({
      userId,
      conversationId,
      sourceMessageId: messageId,
      reflection: {
        memories: [{
          operation: "reinforce",
          memoryId,
          category: "expression",
          content: "希望先听后建议",
          tier: "long",
          confidence: 0.9,
          validUntil: null,
          eventTime: { kind: "unknown", start: null, end: null, precision: "unknown", expression: null, timeZone: null },
          reason: "用户再次明确确认",
          evidenceMessageIds: [messageId],
        }],
        profileSummary: "保持原画像",
        dimensionWeights: { basic: 1, goal: 1, interest: 1, expression: 1, emotion: 1, experience: 1, challenge: 1, boundary: 1 },
        mood: null,
        sessionSummary: "保持摘要",
        returnNote: null,
        shouldEvolveSkill: false,
        evolutionReason: null,
        profileChanged: false,
        summaryChanged: false,
      },
    });

    const sql = database.query.mock.calls.map((call) => String(call[0])).join("\n");
    expect(sql).toContain("INSERT INTO memory_evidence");
    expect(sql).toContain("last_confirmed_at = GREATEST");
    expect(sql).not.toContain("INSERT INTO memory_versions");
  });

  it("writes every model-run column with exactly 27 positional parameters", async () => {
    database.query.mockResolvedValue({ rowCount: 1, rows: [] });
    const userId = crypto.randomUUID();
    const conversationId = crypto.randomUUID();

    await recordModelRun({
      userId,
      traceId: "trace-test",
      role: "dialogue",
      adapterId: "gateway-test",
      modelName: "qwen-plus-character",
      transport: "openai-responses",
      conversationId,
      inputTokens: 100,
      outputTokens: 50,
      cachedInputTokens: 20,
      reasoningTokens: 0,
      searchCalls: 0,
      estimatedInputTokens: 110,
      estimatedOutputTokens: 60,
      estimatedCostCny: 0.000183,
      firstTokenMs: 321,
      requestId: "request-test",
      retries: 1,
      fallbackFrom: "qwen-plus-character-old",
      errorCode: undefined,
      thinking: false,
      sources: [{ title: "官方来源", url: "https://example.invalid/source" }],
      promptVersion: "v2",
      status: "completed",
      durationMs: 987,
      finishReason: "completed",
    });

    expect(database.query).toHaveBeenCalledTimes(1);
    const [sql, parameters] = database.query.mock.calls[0]!;
    expect(sql).toContain("$27");
    expect(parameters).toHaveLength(27);
    expect(parameters[5]).toBe("qwen-plus-character");
    expect(parameters[8]).toBe(0.000183);
    expect(JSON.parse(parameters[24])).toEqual([{ title: "官方来源", url: "https://example.invalid/source" }]);
    expect(parameters[25]).toBe("v2");
    expect(parameters[26]).toBe("openai-responses");
  });
});
