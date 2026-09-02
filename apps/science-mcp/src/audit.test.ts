import { describe, expect, it } from "vitest";
import { assessScienceSources, auditScienceClaims } from "./audit";

describe("assessScienceSources", () => {
  it("区分公共机构、一手研究、二手报道与社区来源", () => {
    const result = assessScienceSources([
      { title: "太阳耀斑", url: "https://www.noaa.gov/example", kind: "official" },
      { title: "论文", url: "https://doi.org/10.1000/test", kind: "research" },
      { title: "报道", url: "https://www.reuters.com/example", kind: "secondary" },
      { title: "讨论", url: "https://www.zhihu.com/question/1", kind: "community" },
    ]);

    expect(result.map((item) => item.authorityLevel)).toEqual([
      "authoritative_primary",
      "primary_research",
      "reputable_secondary",
      "low_quality",
    ]);
  });
});

describe("auditScienceClaims", () => {
  it("将缺少权威一手支撑的高影响主张降为人工复核", () => {
    const result = auditScienceClaims({
      impact: "high",
      sources: [{ title: "新闻报道", url: "https://www.reuters.com/example", kind: "secondary" }],
      claims: [{ text: "某种治疗一定有效。", status: "supported", sourceIndices: [0] }],
    });

    expect(result.auditedClaims[0]?.status).toBe("human_review");
    expect(result.auditedClaims[0]?.auditReason).toContain("权威一手来源");
  });

  it("保留有公共机构支撑的高影响主张并清理无效索引", () => {
    const result = auditScienceClaims({
      impact: "high",
      sources: [{ title: "官方资料", url: "https://www.cdc.gov/example", kind: "official" }],
      claims: [{ text: "这是一条需核验的健康主张。", status: "supported", sourceIndices: [0, 9, 0] }],
    });

    expect(result.auditedClaims[0]).toMatchObject({
      status: "supported",
      sourceIndices: [0],
      invalidSourceIndices: [9],
    });
  });

  it("不把无来源的 supported 状态原样放行", () => {
    const result = auditScienceClaims({
      impact: "low",
      sources: [],
      claims: [{ text: "一条普通科学主张。", status: "supported", sourceIndices: [] }],
    });

    expect(result.auditedClaims[0]?.status).toBe("human_review");
  });
});
