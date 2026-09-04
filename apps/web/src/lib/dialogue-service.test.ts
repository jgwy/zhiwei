import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultPersonalSkill, type TurnAccepted } from "@zhiwei/core";
import { streamAcceptedTurn } from "./dialogue-service";

const mocks = vi.hoisted(() => ({
  mcp: vi.fn(), trace: vi.fn(), finish: vi.fn(), record: vi.fn(),
  gateway: { id: "unit-gateway", capabilities: { maxContextTokens: 32_000 }, embed: vi.fn(), routeFacts: vi.fn(), buildFactBrief: vi.fn(), streamDialogue: vi.fn() },
}));
vi.mock("@zhiwei/core", async (original) => ({
  ...await original<typeof import("@zhiwei/core")>(),
  callMemoryMcp: mocks.mcp, callScienceMcp: vi.fn(), recordTrace: mocks.trace,
  recordModelCallMeta: mocks.record, finishReplyAttempt: mocks.finish,
  listMessagesThrough: vi.fn(async () => []), getConversationSummary: vi.fn(async () => null),
  saveMessageSources: vi.fn(async () => {}), enqueueJob: vi.fn(async () => "job"),
}));
vi.mock("@zhiwei/model-gateway", async (original) => ({
  ...await original<typeof import("@zhiwei/model-gateway")>(), getModelGateway: () => mocks.gateway,
}));

const meta = { task: "dialogue", provider: "scripted", model: "unit-model", finishReason: "stop", usage: {}, sources: [] };
const accepted = {
  userMessage: { id: "user-message", role: "user", content: "这首作品是哪一年发行的？", createdAt: "2026-09-04T00:00:00.000Z" },
  assistant: { id: "assistant-message" }, traceId: "trace", jobId: "job", riskAssessment: { level: "ordinary" },
} as unknown as TurnAccepted;

function response() {
  return streamAcceptedTurn(new Request("http://localhost/api/unit", { method: "POST" }), "owner", "conversation", accepted);
}

describe("fact verification dialogue orchestration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.trace.mockResolvedValue(undefined);
    mocks.finish.mockResolvedValue(undefined);
    mocks.record.mockResolvedValue(undefined);
    mocks.mcp.mockImplementation(async ({ tool }) => {
      if (tool === "memory_search") return { memories: [{ id: "kept-root", versionId: "kept" }, { id: "dropped-root", versionId: "dropped" }] };
      if (tool === "profile_get_current") return { profile: null };
      if (tool === "personal_skill_get_active") return { skill: { content: defaultPersonalSkill, version: 2 } };
      return {};
    });
    mocks.gateway.embed.mockResolvedValue({ data: [[]], meta: { ...meta, task: "embedding" } });
    mocks.gateway.routeFacts.mockResolvedValue({ data: { needsSearch: true, scientific: false, query: "作品发行年份", impact: "ordinary", responseMode: "character", depth: "light", physicalSymptom: false, reason: "外部事实" }, meta: { ...meta, task: "fact-routing" } });
    mocks.gateway.streamDialogue.mockImplementation(async function* (_input, options) {
      await options.onRequest({ model: "unit-model", messages: [{ role: "system", content: "实际发送的提示" }], memoryVersionIds: ["kept"], skillVersions: [] });
      yield { type: "text.delta", delta: "这部分资料目前没有核实，我先把已知与未知分清楚。" };
      yield { type: "completed", meta };
    });
  });

  it("binds sources before generation and records only memories in the actual model request", async () => {
    const startedAt = "2026-09-04T00:00:00.000Z";
    mocks.gateway.buildFactBrief.mockImplementation(async (_input, options) => {
      options.onSearch({ status: "started", startedAt });
      options.onSearch({ status: "completed", startedAt });
      return { data: { summary: "原始概述", claims: [{ text: "待核验年份", status: "supported", sourceIndices: [99] }] },
        meta: { ...meta, task: "fact-brief", sources: [{ title: "坏链接", url: "javascript:bad" }] } };
    });
    const body = await response().text();
    expect(body).toContain(`"stage":"search","message":"正在查找资料","startedAt":"${startedAt}"`);
    expect(body).toContain("message.completed");
    expect(body).not.toContain("javascript:bad");
    const input = mocks.gateway.streamDialogue.mock.calls[0]![0];
    expect(input.factVerification).toBe("unavailable");
    expect(input.factBrief.claims[0]).toMatchObject({ status: "uncertain", sourceIndices: [] });
    expect(mocks.trace).toHaveBeenCalledWith(expect.objectContaining({ userId: "owner", stage: "dialogue.request", payload: expect.objectContaining({ personalSkillVersion: 2 }) }));
    const usage = mocks.mcp.mock.calls.map(([call]) => call).find((call) => call.tool === "memory_record_usage");
    expect(usage.arguments.versionIds).toEqual(["kept"]);
  });

  it("passes unavailable verification to the existing text stream after an actual tool failure", async () => {
    mocks.gateway.buildFactBrief.mockImplementation(async (_input, options) => {
      const startedAt = new Date().toISOString();
      options.onSearch({ status: "started", startedAt });
      options.onSearch({ status: "completed", startedAt });
      throw new Error("provider unavailable internal English");
    });
    const body = await response().text();
    expect(mocks.gateway.streamDialogue.mock.calls[0]![0]).toMatchObject({ factVerification: "unavailable", factBrief: null });
    expect(body).toContain("这部分资料目前没有核实");
    expect(body).not.toContain("provider unavailable");
    expect(body).toContain("message.completed");
  });
});
