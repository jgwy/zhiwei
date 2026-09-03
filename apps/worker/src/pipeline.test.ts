import { describe, expect, it } from "vitest";
import type { MemoryRecord, ReflectionDecision } from "@zhiwei/core";
import {
  alignEmbeddings,
  embeddingInputs,
  prepareReflectionActions,
  profileMemories,
} from "./pipeline";

const messageId = "11111111-1111-4111-8111-111111111111";
const memoryId = "22222222-2222-4222-8222-222222222222";
const versionId = "33333333-3333-4333-8333-333333333333";

function decision(memories: ReflectionDecision["memories"]): ReflectionDecision {
  return {
    memories,
    mood: null,
    refreshProfile: memories.some((memory) => "tier" in memory && memory.tier === "long"),
    refreshSummary: false,
    returnTopic: null,
    shouldEvolveSkill: false,
    evolutionReason: null,
    needsDeepReview: false,
    decisionReason: "测试决策",
  };
}

describe("后台记忆流水线", () => {
  it("将缺失或越界的近期期限规范为七天", () => {
    const now = new Date("2026-09-03T00:00:00.000Z");
    const result = prepareReflectionActions(decision([{
      operation: "create",
      category: "challenge",
      content: "这周正在准备一场演示",
      tier: "short",
      confidence: 0.8,
      reason: "对后续交流有用",
      evidenceMessageIds: [messageId],
    }]), messageId, {}, now);

    expect(result.actions[0]).toMatchObject({
      validUntil: "2026-09-10T00:00:00.000Z",
    });
    expect(result.validityAdjustments).toHaveLength(1);
  });

  it("撤回精确保留memoryId和expectedVersionId且不生成向量", () => {
    const result = prepareReflectionActions(decision([{
      operation: "withdraw",
      memoryId,
      expectedVersionId: versionId,
      reason: "用户明确要求忘记",
      evidenceMessageIds: [messageId],
    }]), messageId, {});

    expect(result.actions).toHaveLength(1);
    expect(embeddingInputs(result.actions)).toEqual([]);
  });

  it("不为关闭的记忆层或明显凭证内容产生写入", () => {
    const result = prepareReflectionActions(decision([
      {
        operation: "create",
        category: "interest",
        content: "长期喜欢读科幻小说",
        tier: "long",
        confidence: 0.8,
        validUntil: null,
        reason: "稳定偏好",
        evidenceMessageIds: [messageId],
      },
      {
        operation: "create",
        category: "basic",
        content: `API key 是 ${["sk", "example-secret-value-123456"].join("-")}`,
        tier: "long",
        confidence: 0.9,
        validUntil: null,
        reason: "测试凭证过滤",
        evidenceMessageIds: [messageId],
      },
    ]), messageId, { longTermMemoryEnabled: false });

    expect(result.actions).toEqual([]);
    expect(result.disabledLayerCount).toBe(1);
    expect(result.blockedSecretCount).toBe(1);
  });

  it("把向量放回对应动作位置", () => {
    const actions = decision([
      { operation: "withdraw", memoryId, expectedVersionId: versionId, reason: "撤回", evidenceMessageIds: [messageId] },
      { operation: "create", category: "interest", content: "喜欢摄影", tier: "long", confidence: 0.8, validUntil: null, reason: "稳定偏好", evidenceMessageIds: [messageId] },
    ]).memories;
    const inputs = embeddingInputs(actions);
    const vector = Array.from({ length: 1024 }, () => 0.01);

    expect(inputs).toEqual([{ index: 1, content: "喜欢摄影" }]);
    expect(alignEmbeddings(actions.length, inputs, [vector])).toEqual([null, vector]);
  });

  it("长期综述输入排除情绪和边界", () => {
    const base = {
      id: memoryId,
      versionId,
      content: "内容",
      tier: "long" as const,
      confidence: 0.8,
      validUntil: null,
      reason: "理由",
      status: "active" as const,
      createdAt: "2026-09-03T00:00:00.000Z",
    };
    const records: MemoryRecord[] = [
      { ...base, category: "interest" },
      { ...base, id: "44444444-4444-4444-8444-444444444444", versionId: "55555555-5555-4555-8555-555555555555", category: "emotion" },
      { ...base, id: "66666666-6666-4666-8666-666666666666", versionId: "77777777-7777-4777-8777-777777777777", category: "boundary" },
    ];

    expect(profileMemories(records)).toEqual([expect.objectContaining({ category: "interest", versionId })]);
  });
});
