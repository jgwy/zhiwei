import { describe, expect, it } from "vitest";
import { extractQueryTerms } from "./terms";

describe("extractQueryTerms", () => {
  it("keeps short Chinese tokens whole", () => {
    expect(extractQueryTerms("周末 跑步")).toEqual(["周末", "跑步"]);
  });

  it("splits long unsegmented Chinese sentences into bigrams", () => {
    const terms = extractQueryTerms("最近工作压力很大不知道怎么办");
    expect(terms).toContain("最近");
    expect(terms).toContain("近工");
    expect(terms).toContain("工作");
    expect(terms).toContain("压力");
    expect(terms.every((term) => term.length === 2)).toBe(true);
  });

  it("lowercases latin tokens and drops separators", () => {
    expect(extractQueryTerms("Hello，World！q")).toEqual(["hello", "world"]);
  });

  it("splits mixed-script tokens into CJK and latin terms", () => {
    const terms = extractQueryTerms("引力波LIGO探测");
    expect(terms).toContain("引力波");
    expect(terms).toContain("ligo");
    expect(terms).toContain("探测");
  });

  it("respects the maxTerms budget", () => {
    expect(extractQueryTerms("周末跑步阅读音乐旅行", 3)).toHaveLength(3);
  });
});
