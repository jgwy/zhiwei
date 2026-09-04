import { describe, expect, it } from "vitest";
import { bindFactSources, factRoutingInput } from "./fact-grounding";

describe("fact evidence binding", () => {
  it("deduplicates real sources and remaps one-based indices without promoting uncertainty", () => {
    const result = bindFactSources({ summary: "原始模型综述", claims: [
      { text: "主张一", status: "supported", sourceIndices: [2, 3, 90] },
      { text: "主张二", status: "uncertain", sourceIndices: [3] },
    ] }, [
      { title: "无效协议", url: "javascript:alert(1)" },
      { title: "来源", url: "https://example.org/source" },
      { title: "重复来源", url: "https://example.org/source" },
    ]);
    expect(result.sources).toEqual([{ title: "来源", url: "https://example.org/source" }]);
    expect(result.brief.claims[0]).toMatchObject({ status: "supported", sourceIndices: [1] });
    expect(result.brief.claims[1]).toMatchObject({ status: "uncertain", sourceIndices: [1] });
  });

  it("downgrades a claim with only invalid links while retaining its model-authored text", () => {
    const result = bindFactSources({ summary: "没有绑定", claims: [
      { text: "需要核验的具体说法", status: "supported", sourceIndices: [1, 2] },
    ] }, [{ title: "", url: "https://example.org/" }, { title: "坏链接", url: "not-a-url" }]);
    expect(result.sources).toEqual([]);
    expect(result.downgradedClaims).toBe(1);
    expect(result.brief.claims[0]).toMatchObject({ text: "需要核验的具体说法", status: "uncertain", sourceIndices: [] });
  });

  it("keeps source cards tied to claims and compacts their indices", () => {
    const result = bindFactSources({ summary: "问题的答案", claims: [
      { text: "有依据的说法", status: "supported", sourceIndices: [3] },
    ] }, [
      { title: "无关检索结果", url: "https://example.org/unrelated" },
      { title: "同名但不同对象", url: "https://example.org/another" },
      { title: "使用的来源", url: "https://example.org/used" },
    ]);
    expect(result.sources.map((source) => source.url)).toEqual(["https://example.org/used"]);
    expect(result.brief.claims[0]?.sourceIndices).toEqual([1]);
  });

  it("retains the preceding question and answer for a verification follow-up without treating it as proof", () => {
    const value = JSON.parse(factRoutingInput("来源呢？", [
      { role: "user", content: "这首曲子是哪一年发表的？" },
      { role: "assistant", content: "某个未经核验的年份。" },
      { role: "user", content: "来源呢？" },
    ]));
    expect(value.recentMessages).toHaveLength(2);
    expect(value.currentMessage).toBe("来源呢？");
    expect(value.instructions).toContain("不是证据");
    expect(value.instructions).toContain("情绪上的确认");
  });
});
