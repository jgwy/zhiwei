import { afterEach, describe, expect, it, vi } from "vitest";
import { compileContext, defaultPersonalSkill, estimateContextTokens, type ChatMessage, type CompiledContext } from "@zhiwei/core";
import { prepareDialogueRequest, requestSnapshot } from "./dialogue-prompt";

function context(): CompiledContext {
  return {
    foundationInstructions: '<skill name="zhiwei-persona" version="1.2.0">安静陪伴，按用户的处境回应。</skill>',
    personalSkill: defaultPersonalSkill,
    profileSummary: "",
    memories: [],
    sessionSummary: "",
    recentMessages: [],
    estimatedTokens: 0,
    truncated: false,
  };
}
function input(value = context()) {
  return { userId: "user", conversationId: "conversation", messageId: "message", content: "能多陪我说会儿吗？", context: value };
}
afterEach(() => vi.unstubAllEnvs());

describe("actual dialogue request", () => {
  it("budgets actual task, facts, and retry hint while retaining the current user message", () => {
    const value = context();
    value.memories = [{ id: "memory", versionId: "version", category: "challenge", content: "相关旧认识".repeat(80), tier: "long", confidence: 0.8, validUntil: null, reason: "相关", createdAt: "2026-09-04T01:00:00.000Z" }];
    value.sessionSummary = "旧会话背景".repeat(1_000);
    value.profileSummary = "长期背景".repeat(1_000);
    value.recentMessages = Array.from({ length: 12 }, (_, index) => ({
      id: String(index), role: index % 2 === 0 ? "user" : "assistant", content: "历史内容".repeat(100), createdAt: "2026-09-04T01:00:00.000Z",
    } as ChatMessage));
    const args = {
      instructions: ["本轮额外说明".repeat(25)],
      retryHint: "上次出现技术异常，请重新回应。",
      maxInputTokens: 1_650,
    };
    const prepared = prepareDialogueRequest({ ...input(value), factBrief: {
      summary: "不应进入正文模型的未经审计总结",
      claims: [{ text: "已知的具体主张", status: "supported", sourceIndices: [1], note: "来源正文支持" }],
    } }, args);
    expect(prepared.truncated).toBe(true);
    expect(prepared.memoryVersionIds).toEqual([]);
    expect(prepared.estimatedTokens).toBe(estimateContextTokens(prepared.messages));
    expect(prepared.estimatedTokens).toBeLessThanOrEqual(args.maxInputTokens);
    expect(prepared.messages.at(-1)).toEqual({ role: "user", content: input().content });
    expect(prepared.messages[0]?.content).toContain(value.foundationInstructions);
    expect(prepared.messages[0]?.content).toContain(args.retryHint);
    expect(prepared.messages[0]?.content).toContain("已知的具体主张");
    expect(prepared.messages[0]?.content).not.toContain("未经审计总结");
    expect(value.recentMessages).toHaveLength(12);
    expect(value.sessionSummary.length).toBeGreaterThan(1_200);
  });

  it("fails before a request if mandatory rules plus the current user input exceed budget", () => {
    expect(() => prepareDialogueRequest(input(), { instructions: ["必要说明".repeat(1_000)], maxInputTokens: 100 }))
      .toThrow("context_budget_exceeded");
  });

  it("does not duplicate a persisted latest user message or expand beyond twelve events", () => {
    const messages = Array.from({ length: 20 }, (_, index): ChatMessage => ({
      id: String(index), role: "user", content: index === 19 ? input().content : `第${index}条`, createdAt: "2026-09-04T01:00:00.000Z",
    }));
    const compiled = compileContext({ foundationInstructions: context().foundationInstructions, personalSkill: defaultPersonalSkill, profile: null, memories: [], sessionSummary: null, messages, maxInputTokens: 18_000 });
    const prepared = prepareDialogueRequest(input(compiled), { instructions: [], maxInputTokens: 18_000 });
    expect(compiled.maxInputTokens).toBe(18_000);
    expect(prepared.messages.slice(1)).toHaveLength(12);
    expect(prepared.messages.filter((message) => message.content === input().content)).toHaveLength(1);
  });

  it("includes fact availability without an emotional planning field", () => {
    const unavailable = prepareDialogueRequest({ ...input(), factVerification: "unavailable" }, { instructions: [], maxInputTokens: 18_000 });
    expect(unavailable.messages[0]?.content).toContain("未实时核实的通用原理或非时效常识");
    expect(unavailable.messages[0]?.content).toContain("人物具体履历、作品发行时间、最新信息及高影响结论不作猜测");
    const available = prepareDialogueRequest({ ...input(), factVerification: "available" }, { instructions: [], maxInputTokens: 18_000 });
    expect(available.messages[0]?.content).toContain("status=supported 且 sourceIndices 非空");
  });

  it("redacts known secrets from the snapshot without changing the provider messages", () => {
    vi.stubEnv("MODEL_API_KEY", "sk-unit-snapshot-api-key");
    vi.stubEnv("INTERNAL_MCP_TOKEN", "unit-mcp-private-token");
    vi.stubEnv("ANON_COOKIE_SECRET", "unit-cookie-private-secret");
    const messages = [{ role: "system" as const, content: `${context().foundationInstructions}\nsk-unit-snapshot-api-key unit-mcp-private-token unit-cookie-private-secret Bearer user-token-from-chat` }];
    const snapshot = requestSnapshot({ task: "dialogue", model: "qwen-plus-character", transport: "openai-chat-completions", attempt: 1, messages, memoryVersionIds: [], estimatedTokens: 100, contextBudget: 18_000, truncated: false });
    expect(snapshot.skillVersions).toEqual([{ name: "zhiwei-persona", version: "1.2.0" }]);
    expect(snapshot.messages[0]?.content).not.toContain("private");
    expect(snapshot.messages[0]?.content).not.toContain("sk-unit");
    expect(snapshot.messages[0]?.content).not.toContain("user-token-from-chat");
    expect(messages[0]?.content).toContain("sk-unit-snapshot-api-key");
  });
});
