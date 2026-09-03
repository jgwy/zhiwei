import { describe, expect, it } from "vitest";
import {
  inferMemoryKind,
  isExplicitMemoryRequest,
  memoryIsRecallable,
  normalizeMemoryMutation,
  selectMemoryMutations,
  validateMemoryEvidence,
} from "./memory-policy";
import type { MemoryMutation, MemoryRecord } from "./types";

function mutation(overrides: Partial<MemoryMutation> = {}): MemoryMutation {
  return {
    operation: "create",
    category: "interest",
    content: "最近在准备一个科普项目",
    tier: "short",
    confidence: 0.7,
    validUntil: null,
    reason: "测试",
    evidenceMessageIds: [crypto.randomUUID()],
    sourceType: "inferred",
    scope: "user",
    sensitivity: "normal",
    importance: 0.5,
    kind: "profile",
    ...overrides,
  };
}

function memory(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: crypto.randomUUID(),
    versionId: crypto.randomUUID(),
    category: "interest",
    content: "当前会话的临时上下文",
    tier: "short",
    confidence: 0.7,
    validUntil: new Date(Date.now() + 86_400_000).toISOString(),
    reason: "测试",
    status: "active",
    kind: "episode",
    sourceType: "inferred",
    scope: "conversation",
    scopeKey: "conversation-a",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("memory lifecycle policy", () => {
  it("does not treat a negative instruction as an explicit save request", () => {
    expect(isExplicitMemoryRequest("请记住我喜欢图示")).toBe(true);
    expect(isExplicitMemoryRequest("这句话不要记住")).toBe(false);
    expect(isExplicitMemoryRequest("不要忘记我明天要答辩")).toBe(true);
  });

  it("forces short-term memory into the current conversation and caps it at seven days", () => {
    const now = new Date("2026-09-03T00:00:00.000Z");
    const normalized = normalizeMemoryMutation(mutation(), { conversationId: "conversation-a", now });
    expect(normalized).toMatchObject({
      tier: "short",
      kind: "episode",
      scope: "conversation",
      scopeKey: "conversation-a",
      status: "active",
    });
    expect(normalized.validUntil).toBe("2026-09-10T00:00:00.000Z");
  });

  it("keeps inferred long-term knowledge pending until confirmation", () => {
    const normalized = normalizeMemoryMutation(mutation({
      content: "正在学习事件视界，并已经掌握其基本定义",
      tier: "long",
      validUntil: null,
      kind: "learning",
    }), { conversationId: "conversation-a" });
    expect(normalized).toMatchObject({
      tier: "long",
      kind: "learning",
      scope: "user",
      scopeKey: null,
      status: "pending",
    });
  });

  it("only recalls short-term episodes inside their source conversation", () => {
    expect(memoryIsRecallable(memory(), { conversationId: "conversation-a" })).toBe(true);
    expect(memoryIsRecallable(memory(), { conversationId: "conversation-b" })).toBe(false);
    expect(memoryIsRecallable(memory({ status: "pending" }), { conversationId: "conversation-a" })).toBe(false);
  });

  it("recognizes learning progress and explicit misconceptions", () => {
    expect(inferMemoryKind("已经掌握事件视界的基本定义")).toBe("learning");
    expect(inferMemoryKind("一直以为事件视界就是奇点，正确区分是二者并不相同")).toBe("misconception");
  });

  it("rejects unrelated current-message text as identity evidence", () => {
    const sourceMessageId = crypto.randomUUID();
    const candidate = mutation({
      category: "basic",
      content: "用户是华中科技大学药学院刘一民。",
      tier: "long",
      evidenceMessageIds: [sourceMessageId],
      evidenceQuote: "111",
    });

    expect(validateMemoryEvidence(candidate, { sourceMessageId, sourceText: "111" }))
      .toBe("quote_does_not_support_memory");
    expect(selectMemoryMutations({
      mutations: [candidate],
      activeMemories: [],
      sourceText: "111",
      sourceMessageId,
      sourceKind: "chat",
    }).accepted).toHaveLength(0);
  });

  it("only accepts evidence attached to the current source message", () => {
    const sourceMessageId = crypto.randomUUID();
    const candidate = mutation({
      category: "basic",
      content: "用户是刘一民。",
      tier: "long",
      evidenceMessageIds: [crypto.randomUUID()],
      evidenceQuote: "我是刘一民",
    });
    expect(validateMemoryEvidence(candidate, { sourceMessageId, sourceText: "我是刘一民" }))
      .toBe("invalid_evidence_message");
  });

  it("keeps a plain identity disclosure pending but activates an explicit save request", () => {
    const sourceMessageId = crypto.randomUUID();
    const plain = selectMemoryMutations({
      mutations: [mutation({
        category: "basic",
        content: "用户是华中科技大学药学院刘一民。",
        tier: "long",
        sourceType: "explicit",
        evidenceMessageIds: [sourceMessageId],
        evidenceQuote: "我是华中科技大学药学院刘一民",
      })],
      activeMemories: [],
      sourceText: "我是华中科技大学药学院刘一民",
      sourceMessageId,
      sourceKind: "chat",
    }).accepted[0]!;
    const explicit = selectMemoryMutations({
      mutations: [{ ...plain, evidenceQuote: "请记住我是华中科技大学药学院刘一民" }],
      activeMemories: [],
      sourceText: "请记住我是华中科技大学药学院刘一民",
      sourceMessageId,
      sourceKind: "chat",
    }).accepted[0]!;

    expect(normalizeMemoryMutation(plain, { conversationId: "conversation-a" }).status).toBe("pending");
    expect(plain.sourceType).toBe("inferred");
    expect(normalizeMemoryMutation(explicit, { conversationId: "conversation-a" }).status).toBe("active");
    expect(explicit.sourceType).toBe("explicit");
  });
});
