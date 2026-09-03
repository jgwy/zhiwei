import { describe, expect, it } from "vitest";
import {
  ConsolidationPlanOutputSchema,
  ConsolidationReviewOutputSchema,
  LongProfileSynthesisOutputSchema,
  assertConsolidationPlan,
  assertConsolidationReview,
  assertProfileSources,
  shouldConsolidateMemories,
  type LifecycleMemoryInput,
} from "./lifecycle";
import { ScriptedGateway } from "./gateway";

const weights = {
  basic: 1,
  goal: 1,
  interest: 1,
  expression: 1,
  emotion: 1,
  experience: 1,
  challenge: 1,
  boundary: 1,
};

function memory(index: number, category: LifecycleMemoryInput["category"] = "interest"): LifecycleMemoryInput {
  const suffix = String(index).padStart(12, "0");
  return {
    memoryId: `10000000-0000-4000-8000-${suffix}`,
    versionId: `20000000-0000-4000-8000-${suffix}`,
    category,
    content: `第${index}条可持续使用的长期认识`,
    confidence: 0.8,
  };
}

describe("长期综述与记忆收拢契约", () => {
  it("长期综述的来源版本必须与输入精确一致", () => {
    const memories = [memory(1), memory(2)];
    const output = LongProfileSynthesisOutputSchema.parse({
      summary: "你目前已经明确表达了两项对长期交流有用的兴趣信息。这份认识还在形成中，我会以你后续更清楚的表达继续校准，不把当下的一次说法变成固定标签。在以后的具体对话里，只会在这两项认识确实与当前问题相关时自然参考它们。",
      dimensionWeights: weights,
      sourceMemoryVersionIds: memories.map((item) => item.versionId),
      schemaVersion: "long-profile-v2",
    });

    expect(() => assertProfileSources({ memories }, output)).not.toThrow();
    expect(() => assertProfileSources({ memories }, { ...output, sourceMemoryVersionIds: [memories[0]!.versionId] }))
      .toThrow("来源版本集");
  });

  it("空长期集合生成不沿用旧事实的稀疏状态文", async () => {
    const result = await new ScriptedGateway().synthesizeProfile({
      memories: [],
      currentSummary: "旧快照曾经写过已被撤回的具体事实",
    });

    expect(result.data.sourceMemoryVersionIds).toEqual([]);
    expect(result.data.summary.length).toBeGreaterThanOrEqual(80);
    expect(result.data.summary).not.toContain("已被撤回的具体事实");
  });

  it("达到48条活动长期记忆时触发收拢", () => {
    expect(shouldConsolidateMemories(Array.from({ length: 47 }, (_, index) => memory(index + 1)))).toBe(false);
    expect(shouldConsolidateMemories(Array.from({ length: 48 }, (_, index) => memory(index + 1)))).toBe(true);
  });

  it("收拢方案只接受同类别、不重叠的源版本", () => {
    const memories = [memory(1, "interest"), memory(2, "interest"), memory(3, "goal")];
    const plan = ConsolidationPlanOutputSchema.parse({
      rewrites: [{
        sourceVersionIds: [memories[0]!.versionId, memories[1]!.versionId],
        category: "interest",
        topic: "长期兴趣",
        content: "持续关注两个相关的兴趣方向",
        confidence: 0.8,
        reason: "两条认识的类别和主题一致。",
      }],
      estimatedResultCount: 2,
      estimatedResultTokens: 80,
      rationale: "只收拢语义兼容的认识。",
    });

    expect(() => assertConsolidationPlan({ memories }, plan)).not.toThrow();
    expect(() => assertConsolidationPlan({ memories }, {
      ...plan,
      rewrites: [{ ...plan.rewrites[0]!, sourceVersionIds: [memories[0]!.versionId, memories[2]!.versionId] }],
    })).toThrow("同类别");
    expect(() => assertConsolidationPlan({ memories, targetCount: 1, targetTokens: 1_000 }, plan))
      .toThrow("未达到目标");
  });

  it("核对只在全部问题为空时批准", () => {
    const sources = [memory(1).versionId, memory(2).versionId];
    const plan = ConsolidationPlanOutputSchema.parse({
      rewrites: [{ sourceVersionIds: sources, category: "interest", topic: "兴趣", content: "长期关注相关兴趣", confidence: 0.8, reason: "主题一致" }],
      estimatedResultCount: 1,
      estimatedResultTokens: 30,
      rationale: "合并兼容条目",
    });
    const approved = ConsolidationReviewOutputSchema.parse({ approved: true, checkedSourceVersionIds: sources, omittedFacts: [], contradictions: [], overInferences: [] });
    expect(() => assertConsolidationReview(plan, approved)).not.toThrow();
    expect(() => assertConsolidationReview(plan, { ...approved, overInferences: ["新增了证据未支持的喜好"] }))
      .toThrow("结论与问题列表不一致");
  });

  it("仿真网关使用两次独立阶段完成收拢", async () => {
    const gateway = new ScriptedGateway();
    const memories = [memory(1), memory(2), memory(3), memory(4)];
    const plan = await gateway.planMemoryConsolidation({ memories, targetCount: 2, targetTokens: 1_000 });
    const review = await gateway.reviewMemoryConsolidation({ memories, plan: plan.data });

    expect(plan.meta.task).toBe("memory-consolidation-plan");
    expect(review.meta.task).toBe("memory-consolidation-review");
    expect(review.data.approved).toBe(true);
    expect(plan.data.estimatedResultCount).toBe(2);
  });
});
