import { afterEach, describe, expect, it } from "vitest";
import { defaultPersonalSkill, type CompiledContext } from "@zhiwei/core";
import { getModelGateway, ReplayGateway, ScriptedGateway, type ModelGateway } from "./gateway";

const context: CompiledContext = {
  foundationInstructions: "",
  personalSkill: defaultPersonalSkill,
  profileSummary: "",
  memories: [],
  sessionSummary: "",
  recentMessages: [],
  estimatedTokens: 0,
  truncated: false,
};

describe("ScriptedGateway", () => {
  const originalProvider = process.env.MODEL_PROVIDER;

  afterEach(() => {
    if (originalProvider === undefined) delete process.env.MODEL_PROVIDER;
    else process.env.MODEL_PROVIDER = originalProvider;
  });

  it("generates a bounded conversation title with task metadata", async () => {
    const result = await new ScriptedGateway().generateTitle("最近工作压力很大，我不知道怎么办！");

    expect(result.data.title).toMatch(/^[\u3400-\u9fff]{4,18}$/u);
    expect(result.meta.task).toBe("conversation-title");
    expect(result.meta.model).toBe("zhiwei-scripted-v2");
    expect(result.meta.provider).toBe("scripted");
    expect(result.meta.transport).toBe("scripted");
    expect(result.meta.usage.outputTokens).toBeGreaterThan(0);
  });

  it("rejects an unknown provider instead of silently returning the simulator", () => {
    process.env.MODEL_PROVIDER = "misspelled-provider";
    expect(() => getModelGateway()).toThrow("不支持的模型供应商配置");
  });

  it("marks replay stream metadata without disguising it as a live model call", async () => {
    const events = [];
    for await (const event of new ReplayGateway().streamDialogue({
      userId: crypto.randomUUID(),
      conversationId: crypto.randomUUID(),
      messageId: crypto.randomUUID(),
      content: "继续上次的话题",
      context,
    })) events.push(event);

    expect(events.at(-1)).toMatchObject({
      type: "completed",
      meta: { provider: "replay", transport: "replay", model: "zhiwei-replay-v2" },
    });
  });

  it("returns schema-valid question candidates and task routing metadata", async () => {
    const gateway: ModelGateway = new ScriptedGateway();
    const result = await gateway.planQuestions({ answered: [] });

    expect(result.data.gapCandidates).toHaveLength(2);
    expect(result.data.adjacentCandidates).toHaveLength(1);
    expect(result.data.gapCandidates.every((candidate) => candidate.options.length >= 2)).toBe(true);
    expect(result.meta.task).toBe("question-planner");
  });

  it("routes current facts but leaves emotional companionship offline", async () => {
    const gateway = new ScriptedGateway();
    const current = await gateway.routeFacts("今天北京的天气怎么样？");
    const emotional = await gateway.routeFacts("我有点难过，想找人说说话");
    const deep = await gateway.routeFacts("我最近感觉一上课头就晕，我又害怕大学物理课跟不上");

    expect(current.data.needsSearch).toBe(true);
    expect(emotional.data.needsSearch).toBe(false);
    expect(deep.data).toMatchObject({
      responseMode: "emotional-deep",
      depth: "moderate",
      physicalSymptom: true,
    });
    expect(current.meta.task).toBe("fact-routing");
  });

  it("streams deltas followed by exactly one completed event", async () => {
    const events = [];
    for await (const event of new ScriptedGateway().streamDialogue({
      userId: crypto.randomUUID(),
      conversationId: crypto.randomUUID(),
      messageId: crypto.randomUUID(),
      content: "我想聊聊最近的状态",
      context,
    })) events.push(event);

    expect(events.some((event) => event.type === "text.delta")).toBe(true);
    expect(events.filter((event) => event.type === "completed")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "completed", meta: { task: "dialogue" } });
  });

  it("keeps the no-cost reflection path capable of producing model-owned memory", async () => {
    const messageId = crypto.randomUUID();
    const result = await new ScriptedGateway().reflect({
      userId: crypto.randomUUID(),
      conversationId: crypto.randomUUID(),
      messageId,
      content: "我更希望你先听我说，不要马上给建议",
      context,
      kind: "chat",
    });

    expect(result.data.memories).toHaveLength(1);
    expect(result.data.memories[0]).toMatchObject({
      category: "expression",
      evidenceMessageIds: [messageId],
    });
    expect(result.data.shouldEvolveSkill).toBe(true);
    expect(result.meta.task).toBe("reflection");
  });

  it("produces deterministic normalized 1024-dimensional embeddings", async () => {
    const gateway = new ScriptedGateway();
    const first = await gateway.embed(["同一段记忆", "另一段记忆"]);
    const second = await gateway.embed(["同一段记忆"]);

    expect(first.data).toHaveLength(2);
    expect(first.data[0]).toHaveLength(1024);
    expect(first.data[0]).toEqual(second.data[0]);
    const norm = Math.sqrt(first.data[0]!.reduce((sum, value) => sum + value * value, 0));
    expect(norm).toBeCloseTo(1, 8);
    expect(first.meta.task).toBe("embedding");
  });

  it.each(["最近有点烦", "生活琐事让我烦", "我目前因生活琐事感到烦恼"])("leaves vague evidence unmaterialized: %s", async (content) => {
    const result = await new ScriptedGateway().reflect({ userId: crypto.randomUUID(), conversationId: crypto.randomUUID(), messageId: crypto.randomUUID(), content, context, kind: "chat" });
    expect(result.data).toMatchObject({ memories: [], mood: null, refreshProfile: false, refreshSummary: false, summaryEvidenceMessageIds: [], returnTopic: null, shouldEvolveSkill: false });
  });

  it("keeps same-event detail in one action while preserving a separate preference", async () => {
    const sources = [
      { id: crypto.randomUUID(), role: "user" as const, content: "这次购物退货让我很烦恼", createdAt: "2026-09-04T00:00:00Z" },
      { id: crypto.randomUUID(), role: "user" as const, content: "购物退货被拒，我很委屈", createdAt: "2026-09-04T00:01:00Z" },
      { id: crypto.randomUUID(), role: "user" as const, content: "请你先听我说，不要马上给建议", createdAt: "2026-09-04T00:02:00Z" },
    ];
    const result = await new ScriptedGateway().reflect({ userId: crypto.randomUUID(), conversationId: crypto.randomUUID(), messageId: sources[2]!.id, content: sources[2]!.content, context, kind: "chat", sourceMessages: sources });
    expect(result.data.memories).toHaveLength(2);
    expect(result.data.memories[0]).toMatchObject({ evidenceMessageIds: [sources[0]!.id, sources[1]!.id], triggerMessageId: sources[1]!.id });
    expect(result.data.memories[1]).toMatchObject({ category: "expression", evidenceMessageIds: [sources[2]!.id], triggerMessageId: sources[2]!.id });
    expect(result.data.mood?.evidenceMessageIds).toEqual([sources[1]!.id]);
  });
});
