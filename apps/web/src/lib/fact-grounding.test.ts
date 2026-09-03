import { describe, expect, it } from "vitest";
import type { ChatMessage, FactBriefOutput } from "@zhiwei/core/client";
import {
  buildVerificationRequest,
  keepOnlyGroundedFacts,
  renderGroundedFactReply,
  requiresVerifiedFacts,
  verificationUnavailableReply,
} from "./fact-grounding";

function message(role: ChatMessage["role"], content: string): ChatMessage {
  return { id: crypto.randomUUID(), role, content, createdAt: new Date().toISOString() };
}

describe("verified-fact gate", () => {
  it("forces identity and affiliation claims through verification", () => {
    expect(requiresVerifiedFacts("刘俊军是谁？", [])).toBe(true);
    expect(requiresVerifiedFacts("华中科技大学的刘俊军教授", [message("user", "刘俊军是谁？")])).toBe(true);
  });

  it("sends ordinary external knowledge questions to verification more often", () => {
    expect(requiresVerifiedFacts("量子纠缠是什么？", [])).toBe(true);
    expect(requiresVerifiedFacts("介绍一下都江堰的历史", [])).toBe(true);
    expect(requiresVerifiedFacts("讲讲最近的诺贝尔奖", [])).toBe(true);
    expect(requiresVerifiedFacts("告诉我OpenAI最新模型", [])).toBe(true);
    expect(requiresVerifiedFacts("你是谁？", [])).toBe(false);
  });

  it("turns a confirmation follow-up into a contextual re-verification request", () => {
    const request = buildVerificationRequest("真的吗？", [
      message("user", "刘俊军是谁？"),
      message("assistant", "他是机械学院教授，研究智能制造。"),
      message("user", "真的吗？"),
    ]);

    expect(requiresVerifiedFacts("真的吗？", [])).toBe(true);
    expect(request).toContain("刘俊军是谁");
    expect(request).toContain("机械学院教授");
    expect(request).toContain("不得沿用");
  });

  it("rejects supported claims when there are no usable cited sources", () => {
    const brief: FactBriefOutput = {
      claims: [{ text: "他是某学院教授", status: "supported", sourceIndices: [1] }],
      summary: "模型声称已经确认。",
    };
    expect(keepOnlyGroundedFacts(brief, [])).toBeNull();
    expect(keepOnlyGroundedFacts(brief, [{ title: "伪来源", url: "not-a-url" }])).toBeNull();
  });

  it("keeps only sourced supported claims and discards the generated summary", () => {
    const result = keepOnlyGroundedFacts({
      claims: [
        { text: "官网列出的事实", status: "supported", sourceIndices: [2] },
        { text: "未经支持的推断", status: "uncertain", sourceIndices: [2] },
        { text: "错误序号", status: "supported", sourceIndices: [9] },
      ],
      summary: "官网列出的事实，而且还补充了不存在的信息。",
    }, [
      { title: "坏链接", url: "invalid" },
      { title: "学校官网", url: "https://example.edu.cn/profile" },
    ]);

    expect(result?.sources).toEqual([{ title: "学校官网", url: "https://example.edu.cn/profile" }]);
    expect(result?.brief.claims).toEqual([{ text: "官网列出的事实", status: "supported", sourceIndices: [1] }]);
    expect(result?.brief.summary).toBe("官网列出的事实");
  });

  it("returns a deterministic refusal instead of pretending a search succeeded", () => {
    const reply = verificationUnavailableReply("刘俊军是谁？");
    expect(reply).toContain("没能从可靠来源核实");
    expect(reply).not.toMatch(/刚刚查|已经确认|后台查询/u);
  });

  it("renders successful fact answers only from accepted claims and real source titles", () => {
    const reply = renderGroundedFactReply({
      claims: [{ text: "官网明确列出的职称", status: "supported", sourceIndices: [1] }],
      summary: "不应进入回答的模型补充内容",
    }, [{ title: "学校官网", url: "https://example.edu.cn/profile" }]);

    expect(reply).toContain("官网明确列出的职称");
    expect(reply).toContain("来源：学校官网");
    expect(reply).not.toContain("模型补充内容");
  });
});
