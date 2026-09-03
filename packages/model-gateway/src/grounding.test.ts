import { describe, expect, it } from "vitest";
import {
  defaultPersonalSkill,
  type CompiledContext,
  type MemoryRecord,
} from "@zhiwei/core";
import { buildDialogueSystem } from "./gateway";

function memory(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: crypto.randomUUID(),
    versionId: crypto.randomUUID(),
    category: "interest",
    content: "用户每天清晨跑十公里，因为独处能缓解焦虑。",
    tier: "long",
    confidence: 1,
    validUntil: null,
    reason: "模型推测出的解释",
    status: "active",
    kind: "profile",
    sourceType: "explicit",
    scope: "user",
    scopeKey: null,
    sensitivity: "normal",
    importance: 0.8,
    evidenceQuote: "我喜欢跑步",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function context(memories: MemoryRecord[]): CompiledContext {
  return {
    foundationInstructions: "知微基底技能",
    personalSkill: {
      ...defaultPersonalSkill,
      attention: {
        ...defaultPersonalSkill.attention,
        priorityTopics: ["模型猜测用户准备去西藏"],
        longTermConcerns: ["模型猜测用户害怕失业"],
      },
      evolution: {
        ...defaultPersonalSkill.evolution,
        reason: "模型猜测用户需要被保护",
      },
    },
    profileSummary: "模型猜测用户性格内向并且每天晨跑。",
    memories,
    sessionSummary: "模型猜测用户下个月会搬家。",
    recentMessages: [],
    estimatedTokens: 0,
    truncated: false,
  };
}

describe("dialogue memory grounding", () => {
  it("uses verbatim evidence instead of model-authored memory and profile fields", () => {
    const system = buildDialogueSystem(context([memory()]));

    expect(system).toContain('"evidence":"我喜欢跑步"');
    expect(system).toContain("只能复述当前用户消息、近期用户原话");
    expect(system).toContain("不得从证据补写原因、动机、频率、时间线");
    expect(system).not.toContain("每天清晨跑十公里");
    expect(system).not.toContain("模型推测出的解释");
    expect(system).not.toContain("模型猜测用户性格内向");
    expect(system).not.toContain("模型猜测用户下个月会搬家");
    expect(system).not.toContain("模型猜测用户准备去西藏");
    expect(system).not.toContain("模型猜测用户需要被保护");
  });

  it("drops untraceable legacy notes instead of presenting them as user facts", () => {
    const system = buildDialogueSystem(context([
      memory({ evidenceQuote: null, content: "没有证据的旧记忆" }),
    ]));

    expect(system).toContain("可用的用户逐字证据：无");
    expect(system).not.toContain("没有证据的旧记忆");
  });

  it("keeps existing user-edited memories grounded during migration", () => {
    const system = buildDialogueSystem(context([
      memory({
        content: "我希望你回答得更直接",
        sourceType: "confirmed",
        evidenceQuote: "用户编辑后的确认内容",
      }),
    ]));

    expect(system).toContain('"evidence":"我希望你回答得更直接"');
    expect(system).toContain('"origin":"user_confirmed_edit"');
    expect(system).not.toContain("用户编辑后的确认内容");
  });
});
