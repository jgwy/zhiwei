import { afterEach, describe, expect, it, vi } from "vitest";
import {
  companionBudget, companionLengthDiagnostic, companionReportName, companionScenarios, conservativeCompanionCost,
  recordCompanionEvent, runCompanionReal, selectCompanionScenarios, type CompanionTurn,
} from "./run-companion-real";
import { directCompanionSelection, runCompanionDirect } from "./run-companion-direct";

describe("真实陪伴验收辅助逻辑", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("默认不产生付费调用", async () => {
    vi.stubEnv("ALLOW_PAID_MODEL_TESTS", "false");
    await expect(runCompanionReal()).rejects.toThrow("真实陪伴验收默认关闭");
    await expect(runCompanionDirect()).rejects.toThrow("真实陪伴验收默认关闭");
  });

  it("直接调用支持短轨迹且如实标识不可用上下文", () => {
    const scenarios = directCompanionSelection(undefined, "2");
    expect(scenarios.map((scenario) => scenario.id)).toEqual(["more-company", "verification-unavailable"]);
    expect(scenarios.every((scenario) => scenario.messages.length === 2)).toBe(true);
    expect(scenarios[1]?.mode).toBe("verification-unavailable-context");
    expect(() => directCompanionSelection("missing")).toThrow();
    expect(() => directCompanionSelection(undefined, "0")).toThrow();
  });

  it("总预算封顶20元，并同时遵守既有消耗与剩余预算", () => {
    expect(companionBudget()).toEqual({ limitCny: 20, alreadySpentCny: 0, runAllowanceCny: 20 });
    expect(companionBudget({ limit: "100", alreadySpent: "3", remaining: "4.5" })).toEqual({ limitCny: 20, alreadySpentCny: 3, runAllowanceCny: 4.5 });
    expect(companionBudget({ alreadySpent: "19", remaining: "4.5" }).runAllowanceCny).toBe(1);
    expect(companionBudget({ alreadySpent: "21" }).runAllowanceCny).toBe(0);
    expect(companionBudget({ remaining: "0" }).runAllowanceCny).toBe(0);
    for (const limit of ["0", "-1", "NaN", "Infinity"]) expect(() => companionBudget({ limit })).toThrow();
    for (const alreadySpent of ["-1", "NaN", "Infinity"]) expect(() => companionBudget({ alreadySpent })).toThrow();
    for (const remaining of ["-1", "NaN", "Infinity"]) expect(() => companionBudget({ remaining })).toThrow();
  });

  it("未知usage与进行中调用计入保守预留", () => {
    expect(conservativeCompanionCost({ costCny: 0.3, unknownCalls: 2, inFlightReserveCny: 0.4 })).toBeCloseTo(1.2);
  });

  it("八类轨迹均为3至4轮，检索失败明确区分注入上下文与Web路径", () => {
    expect(companionScenarios).toHaveLength(8);
    expect(companionScenarios.every((scenario) => scenario.messages.length >= 3 && scenario.messages.length <= 4)).toBe(true);
    expect(selectCompanionScenarios()).toHaveLength(7);
    expect(selectCompanionScenarios("more-company,tone-repair").map((scenario) => scenario.id)).toEqual(["more-company", "tone-repair"]);
    expect(() => selectCompanionScenarios("sad-music,missing")).toThrow("unknown_companion_scenario");
    expect(() => selectCompanionScenarios("verification-unavailable")).toThrow("requires_direct_context_runner");
  });

  it("长度目标只是诊断，不成为回复硬门禁", () => {
    expect(companionLengthDiagnostic("我在这里。")).toMatchObject({ withinMoreCompanyTarget: false, targetIsDiagnosticOnly: true });
    expect(companionLengthDiagnostic(`${"陪".repeat(110)}\n\n${"伴".repeat(110)}`)).toMatchObject({ characters: 220, paragraphs: 2, withinMoreCompanyTarget: true });
  });

  it("每次运行独立命名，不覆盖旧报告", () => {
    const now = new Date("2026-09-04T00:00:00.000Z");
    expect(companionReportName(now, "first")).toBe("companion-real-2026-09-04T00-00-00-000Z-first.json");
    expect(companionReportName(now, "first")).not.toBe(companionReportName(now, "second"));
  });

  it("逐块保留正文、阶段、真实搜索起点及服务端关联", () => {
    const turn: CompanionTurn = { input: "输入", output: "", startedAt: "2026-09-04T00:00:00Z", deltaCount: 0, terminal: "missing", sources: [], chunks: [], stages: [] };
    recordCompanionEvent(turn, { type: "message.started", messageId: "assistant", traceId: "trace", userMessage: { id: "user" } }, 2);
    recordCompanionEvent(turn, { type: "phase", stage: "search", message: "正在查找资料", startedAt: "2026-09-04T00:00:01Z" }, 1000);
    recordCompanionEvent(turn, { type: "text.delta", delta: "先接住" }, 2000);
    recordCompanionEvent(turn, { type: "text.delta", delta: "你的难过。" }, 2100);
    recordCompanionEvent(turn, { type: "message.completed", status: "completed", sources: [{ title: "资料", url: "https://example.com" }] }, 2200);
    expect(turn).toMatchObject({ assistantId: "assistant", userMessageId: "user", traceId: "trace", output: "先接住你的难过。", firstDeltaMs: 2000, completedMs: 2200, deltaCount: 2, terminal: "completed" });
    expect(turn.stages).toEqual([{ elapsedMs: 1000, stage: "search", message: "正在查找资料", startedAt: "2026-09-04T00:00:01Z" }]);
    expect(turn.chunks).toEqual([{ elapsedMs: 2000, text: "先接住" }, { elapsedMs: 2100, text: "你的难过。" }]);
  });
});
