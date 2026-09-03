import { describe, expect, it } from "vitest";
import { isMemoryControl, REFLECTION_BATCH_SIZE, REFLECTION_IDLE_MS } from "./turns";
import { selectPlannedQuestions } from "./questions";
import type { QuestionPlannerOutput } from "./types";

describe("reflection scheduling policy", () => {
  it("uses three messages or ten minutes of inactivity", () => {
    expect(REFLECTION_BATCH_SIZE).toBe(3);
    expect(REFLECTION_IDLE_MS).toBe(600_000);
  });

  it.each(["请记住我喜欢先听结论", "请忘掉刚才提到的上海工作", "你记错了，我的课程是周三", "我想修正你对我的认识"])("immediately schedules explicit memory intent: %s", (content) => {
    expect(isMemoryControl(content)).toBe(true);
  });

  it.each(["我这周要准备物理考试", "生活琐事让我有点烦", "今天退货没成功，我很委屈"])("keeps ordinary evidence in the batch: %s", (content) => {
    expect(isMemoryControl(content)).toBe(false);
  });

  it("draws without replacement when both slots prefer a one-question exploration bucket", () => {
    const plan: QuestionPlannerOutput = {
      gapCandidates: [
        { category: "goal", text: "这周最想推进哪件具体的事？", options: ["课程学习", "实验项目"], rationale: "补足目标" },
        { category: "expression", text: "你希望我如何回应你的困惑？", options: ["先倾听", "一起梳理"], rationale: "补足相处偏好" },
      ],
      adjacentCandidates: [
        { category: "interest", text: "最近有什么事情让你愿意投入时间？", options: ["阅读", "运动"], rationale: "相邻探索" },
      ],
    };
    const result = selectPlannedQuestions(plan, "11111111-1111-4111-8111-111111111110", 1);
    expect(result).toHaveLength(2);
    expect(result[0]?.text).toBe(plan.adjacentCandidates[0]!.text);
    expect(result[1]?.text).toBe(plan.gapCandidates[0]!.text);
    expect(new Set(result.map((question) => question.text)).size).toBe(2);
    expect(result[0]?.id).not.toBe(result[1]?.id);
  });
});
