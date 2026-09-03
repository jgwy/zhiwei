import { describe, expect, it } from "vitest";
import {
  SHORT_MEMORY_MAX_AGE_MS,
  isExplicitMemoryRequestForQuote,
  isMemoryDenial,
  memoryContentHash,
  memoryIsRecallable,
  normalizeMemoryMutation,
  shouldPersistMemory,
  validatedMemorySourceType,
} from "./memory-policy";
import { MemoryMutationSchema, type MemoryMutation, type MemoryRecord } from "./types";

const messageId = "11111111-1111-4111-8111-111111111111";
const memoryId = "22222222-2222-4222-8222-222222222222";
const versionId = "33333333-3333-4333-8333-333333333333";

function mutation(overrides: Partial<MemoryMutation> = {}): MemoryMutation {
  return {
    operation: "create",
    category: "interest",
    content: "喜欢在周末跑步",
    tier: "long",
    confidence: 0.7,
    validUntil: null,
    reason: "测试",
    evidenceMessageIds: [messageId],
    ...overrides,
  };
}

describe("memory lifecycle policy", () => {
  it("requires optimistic version identity for model updates", () => {
    expect(MemoryMutationSchema.safeParse(mutation({ operation: "supersede", memoryId })).success).toBe(false);
    expect(MemoryMutationSchema.safeParse(mutation({ operation: "supersede", memoryId, expectedVersionId: versionId })).success).toBe(true);
  });

  it("only trusts a chat user_stated claim backed by an exact evidence quote", () => {
    expect(validatedMemorySourceType("user_stated", "周末跑步", ["我喜欢周末跑步"], "chat")).toBe("user_stated");
    expect(validatedMemorySourceType("user_stated", "每天跑十公里", ["我喜欢周末跑步"], "chat")).toBe("inferred");
    expect(validatedMemorySourceType("user_stated", undefined, ["我喜欢周末跑步"], "chat")).toBe("inferred");
  });

  it("treats an onboarding answer as user-stated while keeping sensitive answers pending", () => {
    const source = validatedMemorySourceType(undefined, undefined, ["正在服药"], "onboarding");
    const normalized = normalizeMemoryMutation(mutation({ content: "正在服药" }), {
      conversationId: "conversation-a",
      sourceText: "正在服药",
      sourceType: source,
    });
    expect(source).toBe("user_stated");
    expect(normalized).toMatchObject({ status: "pending", sensitivity: "sensitive", scope: "user" });
  });

  it("keeps every replacement pending without displacing the expected active version", () => {
    const normalized = normalizeMemoryMutation(mutation({
      operation: "supersede",
      memoryId,
      expectedVersionId: versionId,
      sourceType: "user_stated",
      evidenceQuote: "现在喜欢游泳",
    }), {
      conversationId: "conversation-a",
      sourceText: "现在喜欢游泳",
      sourceType: "user_stated",
    });
    expect(normalized.status).toBe("pending");
  });

  it("forces short memory into its conversation and caps expiry at seven days", () => {
    const now = new Date("2026-09-03T00:00:00.000Z");
    const normalized = normalizeMemoryMutation(mutation({ tier: "short", validUntil: "2027-01-01T00:00:00.000Z" }), {
      conversationId: "conversation-a",
      sourceText: "最近在准备答辩",
      sourceType: "inferred",
      now,
    });
    expect(normalized.scope).toBe("conversation");
    expect(normalized.scopeKey).toBe("conversation-a");
    expect(new Date(normalized.validUntil!).getTime() - now.getTime()).toBe(SHORT_MEMORY_MAX_AGE_MS);
  });

  it("recalls short memory only inside its source conversation", () => {
    const record: MemoryRecord = {
      id: memoryId,
      versionId,
      category: "challenge",
      content: "正在准备答辩",
      tier: "short",
      confidence: 0.7,
      validUntil: "2026-09-05T00:00:00.000Z",
      reason: "测试",
      status: "active",
      scope: "conversation",
      scopeKey: "conversation-a",
      createdAt: "2026-09-03T00:00:00.000Z",
    };
    const now = new Date("2026-09-04T00:00:00.000Z");
    expect(memoryIsRecallable(record, { conversationId: "conversation-a", now })).toBe(true);
    expect(memoryIsRecallable(record, { conversationId: "conversation-b", now })).toBe(false);
  });

  it("normalizes tombstone hashes and recognizes explicit memory denial", () => {
    expect(memoryContentHash(" 喜欢  跑步 ")).toBe(memoryContentHash("喜欢 跑步"));
    expect(isMemoryDenial("这句话不要记住")).toBe(true);
    expect(isMemoryDenial("不要忘记我明天答辩")).toBe(false);
  });

  it("keeps sensitive facts as confirmable candidates instead of silently discarding them", () => {
    expect(shouldPersistMemory("最近上课时会头晕", "我最近上课时会头晕", "user_stated", "challenge", "上课时会头晕")).toBe(true);
    const normalized = normalizeMemoryMutation(mutation({
      category: "challenge",
      content: "最近上课时会头晕",
      tier: "short",
    }), {
      conversationId: "conversation-a",
      sourceText: "我最近上课时会头晕",
      sourceType: "user_stated",
    });
    expect(normalized.status).toBe("pending");
  });

  it("applies a denial to its quoted fact without suppressing another clause", () => {
    const source = "不要记住我今天头晕，不过请记住我明天要答辩";
    expect(shouldPersistMemory("今天头晕", source, "user_stated", "challenge", "不要记住我今天头晕")).toBe(false);
    expect(shouldPersistMemory("明天要答辩", source, "user_stated", "challenge", "请记住我明天要答辩")).toBe(true);
    expect(isExplicitMemoryRequestForQuote(source, "请记住我明天要答辩")).toBe(true);
  });
});
