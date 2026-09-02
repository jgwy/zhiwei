import { describe, expect, it } from "vitest";
import { assessRisk } from "./risk";

describe("assessRisk", () => {
  it("distinguishes immediate danger from ambiguous distress", () => {
    expect(assessRisk("我现在准备伤害自己").level).toBe("immediate");
    expect(assessRisk("最近真的觉得活不下去").level).toBe("ambiguous");
  });

  it("does not treat quoted or negated text as the user's current danger", () => {
    expect(assessRisk("小说里的角色说他想死").level).toBe("ordinary");
    expect(assessRisk("我没有想死，只是今天很累").level).toBe("ordinary");
  });
});
