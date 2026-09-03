import { describe, expect, it } from "vitest";
import { checkClaims } from "./check";

describe("Check MCP claim checks", () => {
  it("rejects a person identity claim without a matching institutional source", () => {
    const result = checkClaims({
      query: "刘俊军是谁？",
      impact: "ordinary",
      claims: [{ text: "刘俊军是某大学教授。", status: "supported", sourceIndices: [0] }],
      sources: [{ title: "一篇论坛讨论", url: "https://www.zhihu.com/question/1", kind: "community" }],
    });
    expect(result.checkedClaims[0]?.status).toBe("human_review");
  });

  it("accepts a person identity claim bound to a matching university source", () => {
    const result = checkClaims({
      query: "华中科技大学的刘俊军教授",
      impact: "ordinary",
      claims: [{ text: "刘俊军是华中科技大学教授。", status: "supported", sourceIndices: [0, 7] }],
      sources: [{ title: "刘俊军教师主页", url: "https://example.hust.edu.cn/liujunjun" }],
    });
    expect(result.checkedClaims[0]).toMatchObject({
      status: "supported",
      sourceIndices: [0],
      invalidSourceIndices: [7],
    });
  });

  it("never preserves supported status without a valid source", () => {
    const result = checkClaims({
      query: "某个外部事实",
      impact: "ordinary",
      claims: [{ text: "没有来源的主张。", status: "supported", sourceIndices: [] }],
      sources: [],
    });
    expect(result.checkedClaims[0]?.status).toBe("human_review");
  });
});
