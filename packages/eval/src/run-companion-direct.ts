import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compileContext, defaultPersonalSkill, type ChatMessage, type ModelCallMeta } from "@zhiwei/core";
import { AliyunBailianGateway, type ModelRequestSnapshot } from "@zhiwei/model-gateway";
import { composeFoundationInstructions } from "@zhiwei/skills";
import { companionBudget, companionLengthDiagnostic, companionReportName, companionScenarios, conservativeCompanionCost } from "./run-companion-real";
import { redactExperienceReport } from "./run-experience-real";

export function directCompanionSelection(raw = "more-company,verification-unavailable", maxTurns = "3") {
  const ids = new Set(raw.split(",").map((value) => value.trim()).filter(Boolean));
  const scenarios = companionScenarios.filter((scenario) => ids.has(scenario.id));
  const limit = Number(maxTurns);
  if (!scenarios.length || scenarios.length !== ids.size) throw new Error("unknown_companion_scenario");
  if (!Number.isInteger(limit) || limit < 1 || limit > 4) throw new Error("invalid_companion_turn_limit");
  return scenarios.map((scenario) => ({ ...scenario, messages: scenario.messages.slice(0, limit) }));
}

/** Direct dialogue evidence, separate from Web end-to-end tests and actual retrieval failures. */
export async function runCompanionDirect(): Promise<void> {
  if (process.env.ALLOW_PAID_MODEL_TESTS !== "true") throw new Error("真实陪伴验收默认关闭；需要 ALLOW_PAID_MODEL_TESTS=true。");
  if (process.env.MODEL_DIALOGUE_NAME && process.env.MODEL_DIALOGUE_NAME !== "qwen-plus-character") throw new Error("character_model_required");
  const budget = companionBudget({ limit: process.env.COMPANION_BUDGET_CNY, alreadySpent: process.env.COMPANION_ALREADY_SPENT_CNY, remaining: process.env.COMPANION_REMAINING_CNY });
  const scenarios = directCompanionSelection(process.env.COMPANION_DIRECT_SCENARIOS, process.env.COMPANION_MAX_TURNS);
  const gateway = new AliyunBailianGateway();
  const startedAt = new Date();
  const outputPath = fileURLToPath(new URL(`../../../reports/${companionReportName(startedAt).replace("companion-real-", "companion-direct-")}`, import.meta.url));
  const foundationInstructions = composeFoundationInstructions([
    "risk-and-boundary", "privacy-and-withdrawal", "fact-and-tool-use", "scientific-answering", "zhiwei-persona", "dialogue-orchestrator",
  ]);
  const reports: Array<Record<string, unknown>> = [];
  let costCny = 0;
  let unknownCalls = 0;
  let stoppedReason: string | null = null;

  try {
    for (const scenario of scenarios) {
      const history: ChatMessage[] = [];
      const turns: Array<Record<string, unknown>> = [];
      const userId = randomUUID();
      const conversationId = randomUUID();
      const injectedUnavailable = scenario.mode === "verification-unavailable-context";
      reports.push({ id: scenario.id, name: scenario.name, mode: injectedUnavailable ? "injected-verification-unavailable" : "direct-dialogue", reviewFocus: scenario.reviewFocus,
        retrievalExecuted: false, injectedContext: injectedUnavailable ? "factVerification=unavailable" : null, turns });
      for (const content of scenario.messages) {
        if (conservativeCompanionCost({ costCny, unknownCalls, inFlightReserveCny: 0 }) + 0.60 > budget.runAllowanceCny) throw new Error("budget_reserve_reached");
        const started = Date.now();
        const messageId = randomUUID();
        const requests: ModelRequestSnapshot[] = [];
        const chunks: Array<{ elapsedMs: number; text: string }> = [];
        let output = "";
        let meta: ModelCallMeta | undefined;
        let error: string | null = null;
        const context = compileContext({ foundationInstructions, personalSkill: structuredClone(defaultPersonalSkill), profile: null,
          memories: [], sessionSummary: null, messages: history, maxInputTokens: 18_000 });
        try {
          for await (const event of gateway.streamDialogue({ userId, conversationId, messageId, content, context,
            factVerification: injectedUnavailable ? "unavailable" : "not-requested", factBrief: null, scienceMode: false,
          }, { signal: AbortSignal.timeout(180_000), onRequest: (snapshot) => { requests.push(snapshot); } })) {
            if (event.type === "text.delta") { output += event.delta; chunks.push({ elapsedMs: Date.now() - started, text: event.delta }); }
            if (event.type === "completed") meta = event.meta;
          }
          if (!meta || !output.trim()) throw new Error("incomplete_dialogue");
        } catch (cause) {
          meta = (cause as { modelMeta?: ModelCallMeta })?.modelMeta;
          error = cause instanceof Error && /^[a-z_0-9:]+$/u.test(cause.message) ? cause.message : "dialogue_failed";
        }
        costCny += meta?.estimatedCostCny ?? 0;
        unknownCalls += meta ? Math.max(meta.usageReported === false ? 1 : 0, meta.attempts?.filter((attempt) => attempt.usageReported === false).length ?? 0) : Math.max(1, requests.length);
        turns.push({ input: content, output, chunks, firstDeltaMs: chunks[0]?.elapsedMs, completedMs: Date.now() - started, actualRequests: requests,
          modelUsage: meta ?? null, diagnostics: companionLengthDiagnostic(output), error });
        process.stdout.write(JSON.stringify({ scenario: scenario.id, turn: turns.length, characters: companionLengthDiagnostic(output).characters,
          actualModel: meta?.model, fallbackFrom: meta?.fallbackFrom, costCny,
          conservativeCumulativeCny: budget.alreadySpentCny + conservativeCompanionCost({ costCny, unknownCalls, inFlightReserveCny: 0 }), error }) + "\n");
        if (error) throw new Error(error);
        history.push({ id: messageId, role: "user", content, createdAt: new Date(started).toISOString() },
          { id: randomUUID(), role: "assistant", content: output, createdAt: new Date().toISOString() });
      }
    }
  } catch (cause) { stoppedReason = cause instanceof Error && /^[a-z_0-9:]+$/u.test(cause.message) ? cause.message : "direct_run_failed"; }
  finally {
    await mkdir(fileURLToPath(new URL("../../../reports/", import.meta.url)), { recursive: true });
    const report = { schemaVersion: "companion-direct-v1", syntheticOnly: true, liveDialogueModel: true, qualityIsManualReview: true,
      routingExecuted: false, retrievalExecuted: false, memoryPipelineExecuted: false, startedAt: startedAt.toISOString(), completedAt: new Date().toISOString(),
      budget, usageBasedEstimatedCostCny: costCny, unreportedUsageCalls: unknownCalls, unknownUsageReserveCny: unknownCalls * 0.25,
      conservativeCumulativeCny: budget.alreadySpentCny + conservativeCompanionCost({ costCny, unknownCalls, inFlightReserveCny: 0 }),
      costNotice: "按实际对话usage估算，不等同于阿里云账单；不可用核验状态由测试注入，不代表实际发生过检索失败。", stoppedReason, scenarios: reports };
    await writeFile(outputPath, JSON.stringify(redactExperienceReport(report), null, 2) + "\n", { flag: "wx" });
    process.stdout.write(JSON.stringify({ reportPath: outputPath, usageBasedEstimatedCostCny: costCny, unknownUsageReserveCny: unknownCalls * 0.25,
      conservativeCumulativeCny: report.conservativeCumulativeCny, stoppedReason }) + "\n");
    if (stoppedReason) process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCompanionDirect().catch(() => { process.stderr.write("direct_companion_setup_failed\n"); process.exitCode = 1; });
}
