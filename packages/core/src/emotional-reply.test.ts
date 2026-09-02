import { describe, expect, it } from "vitest";
import { EmotionalReplyOutputSchema, FactRoutingOutputSchema } from "./types";

const base = {
  acknowledgedThreads: ["身体不适", "学业压力"],
  primaryNeed: "keep-listening" as const,
  clarifyingDirection: "确认此刻哪一项压力最迫近。",
};

describe("deep emotional reply contracts", () => {
  it("requires enough substance across two to four paragraphs", () => {
    const tooShort = EmotionalReplyOutputSchema.safeParse({
      ...base,
      paragraphs: ["我听到了身体上的不舒服。", "论文的压力也在同时逼近。"],
    });
    const enough = EmotionalReplyOutputSchema.safeParse({
      ...base,
      paragraphs: [
        "身体一直不舒服，本身就会持续消耗注意力，而论文期限又在靠近，你像是同时被两股力量往不同方向拉。这不是简单的忙，而是连停下来喘口气都可能伴着担心。",
        "我先把这两件事都认真放在这里，不急着替你安排一整套办法。身体上的疼痛值得照顾，论文带来的焦虑也确实正在压着你。此刻更让你撑不住的，是身体的不适，还是期限逼近的紧迫感？",
      ],
    });

    expect(tooShort.success).toBe(false);
    expect(enough.success).toBe(true);
  });

  it("allows at most two related clarification questions", () => {
    const result = EmotionalReplyOutputSchema.safeParse({
      ...base,
      paragraphs: [
        "身体一直不舒服，本身就会持续消耗注意力，而论文期限又在靠近，你像是同时被两股力量往不同方向拉。这不是简单的忙，而是连停下来喘口气都可能伴着担心。",
        "你现在胃还疼吗？论文还有多久截止？这种不适会不会在休息后缓解？我先把身体上的疼痛和论文带来的焦虑都认真放在这里，不急着替你安排一整套办法，也不会仅凭这些描述判断原因。",
      ],
    });

    expect(result.success).toBe(false);
  });

  it("normalizes older routing output to the ordinary Character path", () => {
    const result = FactRoutingOutputSchema.parse({
      needsSearch: false,
      scientific: false,
      query: "",
      impact: "ordinary",
      reason: "普通陪伴",
    });

    expect(result).toMatchObject({
      responseMode: "character",
      depth: "light",
      physicalSymptom: false,
    });
  });
});
