import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamEvent } from "@zhiwei/core";

const core = vi.hoisted(() => ({
  addMessage: vi.fn(),
  assessRisk: vi.fn(),
  recordRiskEvent: vi.fn(),
  recordTrace: vi.fn(),
  recordModelCallMeta: vi.fn(),
  saveMessageSources: vi.fn(),
  enqueueJob: vi.fn(),
  getConversation: vi.fn(),
  getConversationSummary: vi.fn(),
  listMessages: vi.fn(),
  compileContext: vi.fn(),
  callMemoryMcp: vi.fn(),
  callScienceMcp: vi.fn(),
}));

const gatewayModule = vi.hoisted(() => ({
  getModelGateway: vi.fn(),
}));

vi.mock("@zhiwei/core", () => core);
vi.mock("@zhiwei/model-gateway", () => gatewayModule);
vi.mock("@zhiwei/skills", () => ({ composeFoundationInstructions: vi.fn(() => "基底指令") }));
vi.mock("@/lib/session", () => ({ getSessionUserId: vi.fn(async () => "11111111-1111-4111-8111-111111111111") }));

import { POST } from "./route";
import { resetRateLimits } from "@/lib/rate-limit";

const meta = {
  task: "dialogue" as const,
  provider: "test",
  model: "test-model",
  transport: "scripted" as const,
  usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, reasoningTokens: 0, searchCalls: 0 },
  estimatedCostCny: 0,
  durationMs: 1,
  finishReason: "completed",
  retries: 0,
  sources: [],
  thinking: false,
};

function makeGateway(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "test-gateway",
    capabilities: { streaming: true, structuredOutput: true, toolCalls: true, nativeWebSearch: true, usage: true, maxContextTokens: 24_000 },
    embed: vi.fn(async () => ({ data: [Array.from({ length: 1024 }, () => 0.01)], meta })),
    routeFacts: vi.fn(async () => ({
      data: { needsSearch: false, scientific: false, responseMode: "character", depth: "light", physicalSymptom: false, query: "q", impact: "ordinary", reason: "普通陪伴" },
      meta,
    })),
    buildFactBrief: vi.fn(),
    streamDialogue: vi.fn(async function* () {
      yield { type: "text.delta", delta: "你好" };
      yield { type: "completed", meta };
    }),
    ...overrides,
  };
}

function makeRequest(content = "你好", signal?: AbortSignal) {
  return new Request("http://localhost:3000/api/conversations/conv-1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content }),
    signal,
  });
}

const routeContext = { params: Promise.resolve({ id: "conv-1" }) };

async function readSse(response: Response): Promise<StreamEvent[]> {
  const text = await response.text();
  return text
    .split("\n\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)) as StreamEvent);
}

beforeEach(() => {
  Object.values(core).forEach((fn) => fn.mockReset());
  core.assessRisk.mockReturnValue({ level: "ordinary", evidence: [], reason: "", responsePath: "normal-dialogue" });
  core.recordRiskEvent.mockResolvedValue("risk-1");
  core.recordTrace.mockResolvedValue(undefined);
  core.recordModelCallMeta.mockResolvedValue(undefined);
  core.saveMessageSources.mockResolvedValue(undefined);
  core.enqueueJob.mockResolvedValue("job-1");
  core.addMessage.mockImplementation(async (input: { id?: string; role: string; content: string }) => ({ id: input.id ?? "saved-id", role: input.role, content: input.content, createdAt: new Date().toISOString() }));
  core.getConversation.mockResolvedValue({ id: "conv-1", kind: "chat", title: "对话", has_messages: true });
  core.getConversationSummary.mockResolvedValue(null);
  core.listMessages.mockResolvedValue([]);
  core.compileContext.mockImplementation((input: Record<string, unknown>) => ({ ...input, estimatedTokens: 100, truncated: false }));
  core.callMemoryMcp.mockImplementation(async ({ tool }: { tool: string }) => {
    if (tool === "profile_get_current") return { profile: null };
    if (tool === "memory_search") return { memories: [] };
    if (tool === "personal_skill_get_active") return { skill: { version: 1, content: {} } };
    throw new Error(`unexpected tool ${tool}`);
  });
  core.callScienceMcp.mockRejectedValue(new Error("science unavailable"));
  gatewayModule.getModelGateway.mockReturnValue(makeGateway());
  process.env.MESSAGE_RATE_LIMIT_PER_MINUTE = "100";
  process.env.MESSAGE_RATE_LIMIT_PER_HOUR = "1000";
  resetRateLimits();
});

describe("POST /api/conversations/[id]/messages", () => {
  it("emits message.started before any tool work and streams the dialogue", async () => {
    const response = await POST(makeRequest(), routeContext);
    expect(response.status).toBe(200);

    const events = await readSse(response);
    expect(events[0]?.type).toBe("message.started");
    const types = events.map((event) => event.type);
    expect(types).toContain("tool.started");
    expect(types).toContain("tool.completed");
    expect(types).toContain("text.delta");
    expect(types.at(-1)).toBe("message.completed");

    const assistantSave = core.addMessage.mock.calls.find((call) => call[0].role === "assistant");
    expect(assistantSave?.[0]).toMatchObject({ content: "你好", metadata: { status: "completed" } });
    expect(core.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({ type: "reflection" }));
  });

  it("enqueues a title job only for the first message of a conversation", async () => {
    core.getConversation.mockResolvedValue({ id: "conv-1", kind: "chat", title: "对话", has_messages: false });
    await POST(makeRequest(), routeContext);
    expect(core.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({ type: "conversation_title" }));

    core.enqueueJob.mockClear();
    core.getConversation.mockResolvedValue({ id: "conv-1", kind: "chat", title: "对话", has_messages: true });
    await POST(makeRequest("第二条"), routeContext);
    const titleCalls = core.enqueueJob.mock.calls.filter((call) => call[0].type === "conversation_title");
    expect(titleCalls).toHaveLength(0);
  });

  it("still completes the dialogue when fact routing fails", async () => {
    gatewayModule.getModelGateway.mockReturnValue(makeGateway({
      routeFacts: vi.fn(async () => { throw new Error("provider_unavailable"); }),
    }));

    const response = await POST(makeRequest(), routeContext);
    const events = await readSse(response);
    const types = events.map((event) => event.type);
    expect(types).toContain("text.delta");
    expect(types.at(-1)).toBe("message.completed");
    expect(core.recordTrace).toHaveBeenCalledWith(expect.objectContaining({ stage: "fact.verification_unavailable" }));
  });

  it("saves the partial output and reports an error when streaming fails mid-way", async () => {
    gatewayModule.getModelGateway.mockReturnValue(makeGateway({
      streamDialogue: vi.fn(async function* () {
        yield { type: "text.delta", delta: "我先接住" };
        throw new Error("provider_unavailable");
      }),
    }));

    const response = await POST(makeRequest(), routeContext);
    const events = await readSse(response);
    const error = events.find((event) => event.type === "error");
    expect(error).toMatchObject({ code: "provider_unavailable" });

    const assistantSave = core.addMessage.mock.calls.find((call) => call[0].role === "assistant");
    expect(assistantSave?.[0]).toMatchObject({ content: "我先接住", metadata: { status: "interrupted" } });
  });

  it("runs fact search inside the stream and forwards verified sources", async () => {
    gatewayModule.getModelGateway.mockReturnValue(makeGateway({
      routeFacts: vi.fn(async () => ({
        data: { needsSearch: true, scientific: false, responseMode: "character", depth: "light", physicalSymptom: false, query: "q", impact: "ordinary", reason: "需要查证" },
        meta,
      })),
      buildFactBrief: vi.fn(async () => ({
        data: { claims: [], summary: "简报" },
        meta: { ...meta, sources: [{ title: "来源", url: "https://example.invalid/a" }] },
      })),
    }));

    const response = await POST(makeRequest(), routeContext);
    const events = await readSse(response);
    const started = events.find((event) => event.type === "tool.started" && event.name === "fact_search");
    const completed = events.find((event) => event.type === "tool.completed" && event.name === "fact_search");
    expect(started).toBeTruthy();
    expect(completed).toBeTruthy();

    const messageCompleted = events.at(-1) as Extract<StreamEvent, { type: "message.completed" }>;
    expect(messageCompleted.sources).toEqual([{ title: "来源", url: "https://example.invalid/a" }]);
    expect(core.saveMessageSources).toHaveBeenCalled();
  });

  it("rejects with 429 once the per-minute budget is exhausted", async () => {
    process.env.MESSAGE_RATE_LIMIT_PER_MINUTE = "1";
    process.env.MESSAGE_RATE_LIMIT_PER_HOUR = "1000";
    resetRateLimits();

    const first = await POST(makeRequest("第一条"), routeContext);
    expect(first.status).toBe(200);
    await first.text();

    const second = await POST(makeRequest("第二条"), routeContext);
    expect(second.status).toBe(429);
    expect(await second.json()).toMatchObject({ code: "rate_limited" });
  });

  it("returns 404 for a conversation outside the current user scope", async () => {
    core.getConversation.mockResolvedValue(null);
    const response = await POST(makeRequest(), routeContext);
    expect(response.status).toBe(404);
  });
});
