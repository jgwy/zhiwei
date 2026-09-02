import { describe, expect, it } from "vitest";
import { pickNextQuestion } from "./questions";

describe("pickNextQuestion", () => {
  it("always covers the three core questions before allowing exploration", () => {
    expect(
      pickNextQuestion({ answeredQuestionIds: [], seed: "a" })?.id,
    ).toBe("current-stage");
    expect(
      pickNextQuestion({
        answeredQuestionIds: ["current-stage"],
        seed: "a",
      })?.id,
    ).toBe("current-focus");
  });

  it("never repeats an answered question", () => {
    const answered = ["current-stage", "current-focus", "conversation-style"];
    const next = pickNextQuestion({
      answeredQuestionIds: answered,
      lastAnswer: "最近工作压力有点大",
      seed: "user-1",
    });
    expect(next).not.toBeNull();
    expect(answered).not.toContain(next!.id);
  });
});

