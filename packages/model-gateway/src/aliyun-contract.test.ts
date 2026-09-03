import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const openAiMock = vi.hoisted(() => ({
  completionCreate: vi.fn(),
  responseCreate: vi.fn(),
}));

vi.mock("openai", () => ({
  default: class MockOpenAI {
    chat = { completions: { create: openAiMock.completionCreate } };
    responses = { create: openAiMock.responseCreate };
    embeddings = { create: vi.fn() };
  },
}));

import { defaultPersonalSkill, type CompiledContext } from "@zhiwei/core";
import { AliyunBailianGateway } from "./gateway";

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

function completion(data: unknown) {
  return {
    choices: [{ message: { content: JSON.stringify(data) }, finish_reason: "stop" }],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 30,
      prompt_tokens_details: { cached_tokens: 10 },
    },
    request_id: crypto.randomUUID(),
  };
}

function streamedText(content: string, id: string = crypto.randomUUID()) {
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: "response.output_text.delta", delta: content };
      yield {
        type: "response.completed",
        response: {
          id,
          status: "completed",
          usage: { input_tokens: 120, output_tokens: Math.ceil(content.length / 2) },
        },
      };
    },
  };
}

function streamedChatText(content: string, id: string = crypto.randomUUID()) {
  return {
    async *[Symbol.asyncIterator]() {
      yield { id, choices: [{ delta: { content }, finish_reason: null }] };
      yield { id, choices: [{ delta: {}, finish_reason: "stop" }] };
      yield {
        id,
        choices: [],
        usage: { prompt_tokens: 120, completion_tokens: Math.ceil(content.length / 2) },
      };
    },
  };
}

function reflectionDecision(memories: unknown[]) {
  return {
    memories,
    mood: null,
    refreshProfile: memories.length > 0,
    refreshSummary: false,
    returnTopic: null,
    shouldEvolveSkill: false,
    evolutionReason: null,
    needsDeepReview: false,
    decisionReason: memories.length ? "用户表达了可用于后续交流的信息。" : "本轮没有形成新认识。",
  };
}

describe("Aliyun structured-output quality retry contract", () => {
  const original = {
    apiKey: process.env.MODEL_API_KEY,
    baseUrl: process.env.MODEL_BASE_URL,
  };

  beforeEach(() => {
    process.env.MODEL_API_KEY = "unit-test-placeholder";
    process.env.MODEL_BASE_URL = "https://unit-test.invalid/compatible-mode/v1";
    openAiMock.completionCreate.mockReset();
    openAiMock.responseCreate.mockReset();
  });

  afterEach(() => {
    if (original.apiKey === undefined) delete process.env.MODEL_API_KEY;
    else process.env.MODEL_API_KEY = original.apiKey;
    if (original.baseUrl === undefined) delete process.env.MODEL_BASE_URL;
    else process.env.MODEL_BASE_URL = original.baseUrl;
  });

  it("retries a schema-valid profile that violates the no-psychological-inference rule", async () => {
    const firstVersionId = "11111111-1111-4111-8111-111111111111";
    const secondVersionId = "22222222-2222-4222-8222-222222222222";
    openAiMock.completionCreate
      .mockResolvedValueOnce(completion({
        summary: "你表现出很强的心理整合能力和潜在人格倾向。这些内在特征让你能够始终保持稳定，也足以预测你以后会如何面对各种困难和关系。从这些特点还可以继续推断你面对陌生环境时的每一种选择，并把它们当成稳定不变的结论。",
        dimensionWeights: weights,
        sourceMemoryVersionIds: [firstVersionId, secondVersionId],
        schemaVersion: "long-profile-v2",
      }))
      .mockResolvedValueOnce(completion({
        summary: "你正在准备毕业论文，也明确希望交流时先被听见，再一起考虑具体建议。目前我对你的长期了解主要就是这两点，以后会随你更明确的表达继续校准，不把当下阶段当成永久结论。",
        dimensionWeights: weights,
        sourceMemoryVersionIds: [firstVersionId, secondVersionId],
        schemaVersion: "long-profile-v2",
      }));

    const result = await new AliyunBailianGateway().synthesizeProfile({
      memories: [
        { memoryId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", versionId: firstVersionId, category: "challenge", content: "正在准备毕业论文", confidence: 0.9 },
        { memoryId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", versionId: secondVersionId, category: "expression", content: "希望先听后建议", confidence: 0.9 },
      ],
    });

    expect(openAiMock.completionCreate).toHaveBeenCalledTimes(2);
    expect(result.data.summary).toContain("你正在准备毕业论文");
    expect(result.meta).toMatchObject({
      task: "profile-synthesis",
      retries: 1,
      transport: "openai-chat-completions",
      usage: {
        inputTokens: 200,
        outputTokens: 60,
        cachedInputTokens: 20,
      },
      attempts: [
        expect.objectContaining({ outcome: "quality-rejected" }),
        expect.objectContaining({ outcome: "completed" }),
      ],
    });
    const repairedRequest = openAiMock.completionCreate.mock.calls[1]?.[0];
    expect(repairedRequest.messages[0].content).toContain("上一次输出未通过业务校验");
    expect(repairedRequest.messages[0].content).toContain("不得补写抽象能力、人格或心理动机");
  });

  it("retries a schema-valid question plan that uses research-style wording", async () => {
    const invalid = {
      gapCandidates: [
        { category: "basic", text: "你当前阶段最大的核心卡点是什么？", options: ["学习", "工作"], rationale: "补足阶段" },
        { category: "expression", text: "你希望我怎么回应你？", options: ["先听", "建议"], rationale: "了解表达" },
      ],
      adjacentCandidates: [
        { category: "interest", text: "最近什么事让你投入？", options: ["阅读", "运动"], rationale: "相邻探索" },
      ],
    };
    const repaired = {
      ...invalid,
      gapCandidates: [
        { ...invalid.gapCandidates[0], text: "最近哪件事最让你挂心？" },
        invalid.gapCandidates[1],
      ],
    };
    openAiMock.completionCreate
      .mockResolvedValueOnce(completion(invalid))
      .mockResolvedValueOnce(completion(repaired));

    const result = await new AliyunBailianGateway().planQuestions({ answered: [] });

    expect(openAiMock.completionCreate).toHaveBeenCalledTimes(2);
    expect(result.data.gapCandidates[0]?.text).toBe("最近哪件事最让你挂心？");
    expect(result.meta.retries).toBe(1);
    expect(openAiMock.completionCreate.mock.calls[1]?.[0].messages[0].content).toContain("问题带有研究腔或诊断腔");
  });

  it("gives emotional dialogue enough output budget and a concrete listening protocol", async () => {
    openAiMock.completionCreate.mockResolvedValue(streamedChatText("我听见你今天被当众否定后的难受了，这不只是尴尬，也会让人怀疑自己的价值。我先陪你把最刺痛的部分说清楚。", "response-unit-test"));
    const context: CompiledContext = {
      foundationInstructions: "知微基底技能",
      personalSkill: defaultPersonalSkill,
      profileSummary: "",
      memories: [],
      sessionSummary: "",
      recentMessages: [],
      estimatedTokens: 0,
      truncated: false,
    };

    const events = [];
    for await (const event of new AliyunBailianGateway().streamDialogue({
      userId: crypto.randomUUID(),
      conversationId: crypto.randomUUID(),
      messageId: crypto.randomUUID(),
      content: "今天被当众否定以后，我一直觉得自己特别差，只想找个人说说。",
      context,
    })) events.push(event);

    expect(openAiMock.completionCreate).toHaveBeenCalledTimes(1);
    expect(openAiMock.responseCreate).not.toHaveBeenCalled();
    const request = openAiMock.completionCreate.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      model: "qwen-plus-character",
      stream: true,
      temperature: 0.58,
      max_tokens: 1_200,
      stream_options: { include_usage: true },
    });
    const system = request.messages[0].content as string;
    expect(system).toContain("4至8个完整句子");
    expect(system).toContain("最难受、最为难的部分");
    expect(system).toContain("不要用空泛安慰替代具体理解");
    expect(system).toContain("简洁偏好不是硬性截断");
    expect(system).not.toContain("只用1至3句具体承接");
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      meta: { task: "dialogue", model: "qwen-plus-character" },
    });
  });

  it("routes high-emotion and physical-symptom signals in the existing fact-routing call", async () => {
    openAiMock.completionCreate.mockResolvedValue(completion({
      needsSearch: false,
      scientific: false,
      responseMode: "emotional-deep",
      depth: "high",
      physicalSymptom: true,
      query: "",
      impact: "ordinary",
      reason: "用户同时表达上课时头晕与跟不上大学物理的焦虑。",
    }));

    const result = await new AliyunBailianGateway().routeFacts(
      "我最近感觉一上课头就晕，我又害怕大学物理课跟不上",
    );

    expect(result.data).toMatchObject({
      needsSearch: false,
      responseMode: "emotional-deep",
      depth: "high",
      physicalSymptom: true,
    });
    const system = openAiMock.completionCreate.mock.calls[0]?.[0].messages[0].content as string;
    expect(system).toContain("同时完成事实与回复深度路由");
    expect(system).toContain("不增加后续规划调用");
    expect(system).toContain("responseMode必须为emotional-deep");
    expect(openAiMock.completionCreate.mock.calls[0]?.[0].response_format.json_schema.schema.required)
      .toEqual(expect.arrayContaining(["responseMode", "depth", "physicalSymptom"]));
  });

  it("treats a hypothetical listening preference as an ordinary concise acknowledgement", async () => {
    const reply = "我记住了：以后你难受时，我会先听懂具体处境，再和你确认是否需要建议。";
    openAiMock.completionCreate.mockResolvedValue(streamedChatText(reply));
    const context: CompiledContext = {
      foundationInstructions: "知微基底技能",
      personalSkill: defaultPersonalSkill,
      profileSummary: "",
      memories: [],
      sessionSummary: "",
      recentMessages: [],
      estimatedTokens: 0,
      truncated: false,
    };
    let output = "";
    for await (const event of new AliyunBailianGateway().streamDialogue({
      userId: crypto.randomUUID(),
      conversationId: crypto.randomUUID(),
      messageId: crypto.randomUUID(),
      content: "我难受的时候希望你先听懂我，别急着给一串建议。",
      context,
      responsePlan: { responseMode: "emotional-deep", depth: "high", physicalSymptom: false, reason: "模型误把偏好表述判成当前高情绪" },
    })) {
      if (event.type === "text.delta") output += event.delta;
    }

    expect(output).toBe(reply);
    expect(openAiMock.completionCreate).toHaveBeenCalledTimes(1);
    expect(openAiMock.responseCreate).not.toHaveBeenCalled();
  });

  it("keeps an explicit memory-control command on the concise acknowledgement path", async () => {
    const reply = "好，这条认识会立即撤回，之后不再用于回答。";
    openAiMock.completionCreate.mockResolvedValue(streamedChatText(reply));
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
    let output = "";
    for await (const event of new AliyunBailianGateway().streamDialogue({
      userId: crypto.randomUUID(),
      conversationId: crypto.randomUUID(),
      messageId: crypto.randomUUID(),
      content: "忘掉我刚才说的上海求职吧，之后也别再主动提。",
      context,
      responsePlan: { responseMode: "emotional-deep", depth: "high", physicalSymptom: false, reason: "错误的深度路由" },
    })) {
      if (event.type === "text.delta") output += event.delta;
    }

    expect(output).toBe(reply);
    expect(openAiMock.completionCreate).toHaveBeenCalledTimes(1);
    expect(openAiMock.responseCreate).not.toHaveBeenCalled();
  });

  it("repairs onboarding memory output that omits the current question category", async () => {
    const messageId = crypto.randomUUID();
    const wrong = {
      operation: "create",
      category: "expression",
      content: "愿意慢慢交流",
      tier: "long",
      confidence: 0.8,
      validUntil: null,
      reason: "错误分类",
      evidenceMessageIds: [messageId],
    };
    const repaired = { ...wrong, category: "basic", content: "希望被称作小满，目前是大四学生" };
    openAiMock.completionCreate
      .mockResolvedValueOnce(completion(reflectionDecision([wrong])))
      .mockResolvedValueOnce(completion(reflectionDecision([repaired])));
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

    const result = await new AliyunBailianGateway().reflect({
      userId: crypto.randomUUID(),
      conversationId: crypto.randomUUID(),
      messageId,
      content: "我叫小满，现在是大四学生。",
      context,
      kind: "onboarding",
      questionCategory: "basic",
    });

    expect(result.meta.retries).toBe(1);
    expect(result.data.memories).toEqual([expect.objectContaining({ category: "basic" })]);
  });

  it("repairs an explicit forget request unless it contains only exact withdrawals", async () => {
    const messageId = crypto.randomUUID();
    const memoryId = crypto.randomUUID();
    const versionId = crypto.randomUUID();
    const wrongSelection = {
      memoryId: crypto.randomUUID(),
      expectedVersionId: crypto.randomUUID(),
      reason: "错误地选择了候选之外的认识",
    };
    const withdrawal = {
      memoryId,
      expectedVersionId: versionId,
      reason: "用户明确要求忘掉这条认识",
    };
    openAiMock.completionCreate
      .mockResolvedValueOnce(completion({ withdrawals: [wrongSelection], decisionReason: "错误选择" }))
      .mockResolvedValueOnce(completion({ withdrawals: [withdrawal], decisionReason: "精确匹配上海求职认识" }));
    const context: CompiledContext = {
      foundationInstructions: "",
      personalSkill: defaultPersonalSkill,
      profileSummary: "",
      memories: [{
        id: memoryId,
        versionId,
        category: "challenge",
        content: "正在考虑去上海找工作",
        tier: "short",
        confidence: 0.8,
        validUntil: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        reason: "用户明确表达",
        status: "active",
        createdAt: new Date().toISOString(),
      }],
      sessionSummary: "",
      recentMessages: [],
      estimatedTokens: 0,
      truncated: false,
    };

    const result = await new AliyunBailianGateway().reflect({
      userId: crypto.randomUUID(),
      conversationId: crypto.randomUUID(),
      messageId,
      content: "忘掉我刚才说的上海求职吧，之后也别再主动提。",
      context,
      kind: "chat",
    });

    expect(result.meta.retries).toBe(1);
    expect(result.data.memories).toEqual([expect.objectContaining({ operation: "withdraw", memoryId, expectedVersionId: versionId })]);
  });

  it("does not turn a neutral statement into a mood sample", async () => {
    openAiMock.completionCreate.mockResolvedValue(completion({
      ...reflectionDecision([]),
      mood: { score: 5, summary: "用户情绪高涨。", meaningful: true },
    }));
    const messageId = crypto.randomUUID();
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

    const result = await new AliyunBailianGateway().reflect({
      userId: crypto.randomUUID(),
      conversationId: crypto.randomUUID(),
      messageId,
      content: "我是做交互设计的，目前在带一个小团队。",
      context,
      kind: "chat",
    });

    expect(result.data.mood).toBeNull();
  });

  it("retries an interaction preference placed in boundary instead of expression", async () => {
    const messageId = crypto.randomUUID();
    const common = {
      operation: "create",
      content: "用户害怕时希望先被听懂，不要急着给方法。",
      tier: "long",
      confidence: 0.9,
      validUntil: null,
      reason: "明确的回应偏好",
      evidenceMessageIds: [messageId],
    };
    openAiMock.completionCreate
      .mockResolvedValueOnce(completion(reflectionDecision([{ ...common, category: "boundary" }])))
      .mockResolvedValueOnce(completion(reflectionDecision([{ ...common, category: "expression" }])));
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

    const result = await new AliyunBailianGateway().reflect({
      userId: crypto.randomUUID(),
      conversationId: crypto.randomUUID(),
      messageId,
      content: "我现在不想要很多方法，只希望你先把我的害怕听明白。",
      context,
      kind: "chat",
    });

    expect(result.meta.retries).toBe(1);
    expect(result.data.memories).toEqual([expect.objectContaining({ category: "expression" })]);
  });

  it("rejects a supersede that leaves the memory text unchanged", async () => {
    const messageId = crypto.randomUUID();
    const memoryId = crypto.randomUUID();
    const versionId = crypto.randomUUID();
    const unchanged = {
      operation: "supersede",
      memoryId,
      expectedVersionId: versionId,
      category: "challenge",
      content: "今天因为截止时间而凭直觉快速做决定。",
      tier: "short",
      confidence: 0.9,
      validUntil: new Date(Date.now() + 86_400_000).toISOString(),
      reason: "没有实质变化",
      evidenceMessageIds: [messageId],
    };
    openAiMock.completionCreate
      .mockResolvedValueOnce(completion(reflectionDecision([unchanged])))
      .mockResolvedValueOnce(completion(reflectionDecision([])));
    const context: CompiledContext = {
      foundationInstructions: "",
      personalSkill: defaultPersonalSkill,
      profileSummary: "",
      memories: [{
        id: memoryId,
        versionId,
        category: "challenge",
        content: unchanged.content,
        tier: "short",
        confidence: 0.9,
        validUntil: unchanged.validUntil,
        reason: "当前处境",
        status: "active",
        createdAt: new Date().toISOString(),
      }],
      sessionSummary: "",
      recentMessages: [],
      estimatedTokens: 0,
      truncated: false,
    };

    const result = await new AliyunBailianGateway().reflect({
      userId: crypto.randomUUID(),
      conversationId: crypto.randomUUID(),
      messageId,
      content: "这只是今晚截止导致的例外，不代表长期变化。",
      context,
      kind: "chat",
    });

    expect(result.meta.retries).toBe(1);
    expect(result.data.memories).toEqual([]);
  });

  it("buffers and validates a Character reply for routed deep emotional dialogue", async () => {
    const paragraphs = [
      "一上课就头晕，会直接打断注意力，也很容易让你把身体的不舒服和“是不是跟不上”连在一起。大学物理本来就需要持续跟住概念和推导，所以当身体状态先把节奏打乱，那种慌张可能不只是怕漏掉一节课，而是担心自己会从这里一路落下去。",
      "我先把这两件事都认真放在这里，不急着把它变成学习技巧清单，也不会仅凭头晕替你判断原因。头晕这件事本身值得现实地留意，害怕跟不上也并不说明你能力不够。为了先陪你找准最迫近的部分，此刻更让你不安的，是头晕本身，还是已经听不懂某些物理内容的感觉？",
    ];
    openAiMock.completionCreate.mockResolvedValue(streamedChatText(paragraphs.join("\n\n"), "11111111-1111-4111-8111-111111111111"));
    const context: CompiledContext = {
      foundationInstructions: "知微基底技能",
      personalSkill: defaultPersonalSkill,
      profileSummary: "正在学习大学物理。",
      memories: [],
      sessionSummary: "",
      recentMessages: [],
      estimatedTokens: 0,
      truncated: false,
    };

    let output = "";
    let completed: any;
    for await (const event of new AliyunBailianGateway().streamDialogue({
      userId: crypto.randomUUID(),
      conversationId: crypto.randomUUID(),
      messageId: crypto.randomUUID(),
      content: "我最近感觉一上课头就晕，我又害怕大学物理课跟不上",
      context,
      responsePlan: {
        responseMode: "emotional-deep",
        depth: "high",
        physicalSymptom: true,
        reason: "上课时头晕与大学物理学习焦虑并存。",
      },
    })) {
      if (event.type === "text.delta") output += event.delta;
      if (event.type === "completed") completed = event.meta;
    }

    expect(openAiMock.completionCreate).toHaveBeenCalledTimes(1);
    expect(openAiMock.responseCreate).not.toHaveBeenCalled();
    const request = openAiMock.completionCreate.mock.calls[0]?.[0];
    expect(request.model).toBe("qwen-plus-character");
    expect(request.temperature).toBe(0.52);
    expect(request.max_tokens).toBe(1_400);
    expect(request.messages[0].content).toContain("身体不适与现实压力");
    expect(request.messages.at(-1).content).toContain("我最近感觉一上课头就晕，我又害怕大学物理课跟不上");
    expect(output).toBe(paragraphs.join("\n\n"));
    expect(output.length).toBeGreaterThanOrEqual(120);
    expect(completed).toMatchObject({
      task: "dialogue",
      model: "qwen-plus-character",
      transport: "openai-chat-completions",
      requestId: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("rejects punctuation-only deep replies even when the provider reports completion", async () => {
    openAiMock.completionCreate
      .mockResolvedValueOnce(streamedChatText("{ ,,,,,,,,,,,,,,,,,,,,,,,,, }", "21111111-1111-4111-8111-111111111111"))
      .mockResolvedValueOnce(streamedChatText("{ ,,,,,,,,,,,,,,,,,,,,,,,,, }", "31111111-1111-4111-8111-111111111111"));
    openAiMock.responseCreate.mockResolvedValueOnce(streamedText("{ ,,,,,,,,,,,,,,,,,,,,,,,,, }", "41111111-1111-4111-8111-111111111111"));
    const context: CompiledContext = {
      foundationInstructions: "知微基底技能",
      personalSkill: defaultPersonalSkill,
      profileSummary: "",
      memories: [],
      sessionSummary: "",
      recentMessages: [],
      estimatedTokens: 0,
      truncated: false,
    };
    const events: unknown[] = [];

    await expect(async () => {
      for await (const event of new AliyunBailianGateway().streamDialogue({
        userId: crypto.randomUUID(),
        conversationId: crypto.randomUUID(),
        messageId: crypto.randomUUID(),
        content: "我最近感觉一上课头就晕，我又害怕大学物理课跟不上",
        context,
        responsePlan: { responseMode: "emotional-deep", depth: "high", physicalSymptom: true, reason: "两条处境同时出现" },
      })) events.push(event);
    }).rejects.toThrow("invalid_response");

    expect(events).toEqual([]);
    expect(openAiMock.completionCreate).toHaveBeenCalledTimes(2);
    expect(openAiMock.completionCreate.mock.calls.map((call) => call[0].model)).toEqual([
      "qwen-plus-character",
      "qwen-plus-character",
    ]);
    expect(openAiMock.responseCreate).toHaveBeenCalledTimes(1);
    expect(openAiMock.responseCreate.mock.calls[0]?.[0].model).toBe("qwen3.8-flash");
  });

  it("falls back to validated Flash plain text after two invalid Character replies", async () => {
    const fallback = "一上课就头晕，不只会打断你跟住推导的节奏，也很容易让身体的不舒服和“是不是跟不上”缠在一起。你担心的可能不只是漏掉一节课，而是怕自己从这里逐渐落下。\n\n我先把这两件事都认真对待，不急着只给你一份学习技巧清单，也不会凭现在的描述替你判断头晕的原因。头晕本身值得被现实地留意，害怕跟不上也不意味着你的能力不够。我们可以先从此刻最压着你的那一边慢慢说起。";
    openAiMock.completionCreate
      .mockResolvedValueOnce(streamedChatText("{ ,,,,,,,,,,,,,,,,,,,,,,,,, }"))
      .mockResolvedValueOnce(streamedChatText("{ ,,,,,,,,,,,,,,,,,,,,,,,,, }"));
    openAiMock.responseCreate.mockResolvedValueOnce(streamedText(fallback));
    const context: CompiledContext = {
      foundationInstructions: "知微基底技能",
      personalSkill: defaultPersonalSkill,
      profileSummary: "",
      memories: [],
      sessionSummary: "",
      recentMessages: [],
      estimatedTokens: 0,
      truncated: false,
    };
    let output = "";
    let completed: any;

    for await (const event of new AliyunBailianGateway().streamDialogue({
      userId: crypto.randomUUID(),
      conversationId: crypto.randomUUID(),
      messageId: crypto.randomUUID(),
      content: "我最近感觉一上课头就晕，我又害怕大学物理课跟不上",
      context,
      responsePlan: { responseMode: "emotional-deep", depth: "high", physicalSymptom: true, reason: "两条处境同时出现" },
    })) {
      if (event.type === "text.delta") output += event.delta;
      if (event.type === "completed") completed = event.meta;
    }

    expect(output).toBe(fallback);
    expect(completed).toMatchObject({
      model: "qwen3.8-flash",
      fallbackFrom: "qwen-plus-character",
      retries: 2,
      transport: "openai-responses",
      usage: {
        inputTokens: 360,
      },
      attempts: [
        expect.objectContaining({ model: "qwen-plus-character", outcome: "quality-rejected" }),
        expect.objectContaining({ model: "qwen-plus-character", outcome: "quality-rejected" }),
        expect.objectContaining({ model: "qwen3.8-flash", outcome: "completed" }),
      ],
    });
  });

  it("does not report an ordinary stream as complete without a provider terminal event", async () => {
    openAiMock.completionCreate.mockResolvedValue({
      async *[Symbol.asyncIterator]() {
        yield { id: "incomplete-character", choices: [{ delta: { content: "这段内容不应提前显示。" }, finish_reason: null }] };
      },
    });
    openAiMock.responseCreate.mockResolvedValue({
      async *[Symbol.asyncIterator]() {
        yield { type: "response.output_text.delta", delta: "Flash 也没有完成。" };
        yield { type: "response.incomplete", response: { status: "incomplete" } };
      },
    });
    const context: CompiledContext = {
      foundationInstructions: "知微基底技能",
      personalSkill: defaultPersonalSkill,
      profileSummary: "",
      memories: [],
      sessionSummary: "",
      recentMessages: [],
      estimatedTokens: 0,
      truncated: false,
    };
    const events: unknown[] = [];

    await expect(async () => {
      for await (const event of new AliyunBailianGateway().streamDialogue({
        userId: crypto.randomUUID(),
        conversationId: crypto.randomUUID(),
        messageId: crypto.randomUUID(),
        content: "我想说一件普通的事。",
        context,
        responsePlan: { responseMode: "character", depth: "light", physicalSymptom: false, reason: "普通陪伴" },
      })) events.push(event);
    }).rejects.toThrow("invalid_response");

    expect(openAiMock.completionCreate).toHaveBeenCalledTimes(2);
    expect(openAiMock.responseCreate).toHaveBeenCalledTimes(1);
    expect(events).toEqual([]);
    expect(events).not.toContainEqual(expect.objectContaining({ type: "completed" }));
  });

  it("keeps an incomplete deep-emotion response fully buffered and invisible", async () => {
    openAiMock.completionCreate.mockResolvedValue({
      async *[Symbol.asyncIterator]() {
        yield { id: "incomplete-character", choices: [{ delta: { content: "这段内容不应提前显示。" }, finish_reason: null }] };
      },
    });
    openAiMock.responseCreate.mockResolvedValue({
      async *[Symbol.asyncIterator]() {
        yield { type: "response.output_text.delta", delta: "这段内容不应提前显示。" };
        yield { type: "response.incomplete", response: { status: "incomplete" } };
      },
    });
    const context: CompiledContext = {
      foundationInstructions: "知微基底技能",
      personalSkill: defaultPersonalSkill,
      profileSummary: "",
      memories: [],
      sessionSummary: "",
      recentMessages: [],
      estimatedTokens: 0,
      truncated: false,
    };
    const events: unknown[] = [];

    await expect(async () => {
      for await (const event of new AliyunBailianGateway().streamDialogue({
        userId: crypto.randomUUID(),
        conversationId: crypto.randomUUID(),
        messageId: crypto.randomUUID(),
        content: "我最近觉得很性压抑，也不知道该和谁说。",
        context,
        responsePlan: { responseMode: "emotional-deep", depth: "high", physicalSymptom: false, reason: "高情绪浓度" },
      })) events.push(event);
    }).rejects.toThrow("invalid_response");

    expect(openAiMock.completionCreate).toHaveBeenCalledTimes(2);
    expect(openAiMock.responseCreate).toHaveBeenCalledTimes(1);
    expect(events).toEqual([]);
  });

  it("uses two independent thinking calls for consolidation planning and review", async () => {
    const memories = [
      { memoryId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", versionId: "11111111-1111-4111-8111-111111111111", category: "interest" as const, content: "长期喜欢阅读科幻小说", confidence: 0.86 },
      { memoryId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", versionId: "22222222-2222-4222-8222-222222222222", category: "interest" as const, content: "经常关注科幻作品的世界观", confidence: 0.82 },
    ];
    openAiMock.completionCreate
      .mockResolvedValueOnce(completion({
        rewrites: [{
          sourceVersionIds: memories.map((memory) => memory.versionId),
          category: "interest",
          topic: "科幻阅读",
          content: "长期喜欢阅读并关注科幻作品的世界观",
          confidence: 0.82,
          reason: "两条认识同属科幻阅读主题。",
        }],
        estimatedResultCount: 1,
        estimatedResultTokens: 30,
        rationale: "保留兴趣对象与关注角度。",
      }))
      .mockResolvedValueOnce(completion({
        approved: true,
        checkedSourceVersionIds: memories.map((memory) => memory.versionId),
        omittedFacts: [],
        contradictions: [],
        overInferences: [],
      }));
    const gateway = new AliyunBailianGateway();

    const plan = await gateway.planMemoryConsolidation({ memories, targetCount: 1, targetTokens: 1_000 });
    const review = await gateway.reviewMemoryConsolidation({ memories, targetCount: 1, targetTokens: 1_000, plan: plan.data });

    expect(review.data.approved).toBe(true);
    expect(openAiMock.completionCreate).toHaveBeenCalledTimes(2);
    expect(openAiMock.completionCreate.mock.calls[0]?.[0]).toMatchObject({
      enable_thinking: true,
      clear_thinking: true,
      reasoning_effort: "medium",
    });
    expect(openAiMock.completionCreate.mock.calls[1]?.[0]).toMatchObject({
      enable_thinking: true,
      clear_thinking: true,
      reasoning_effort: "medium",
    });
    expect(openAiMock.completionCreate.mock.calls[0]?.[0].response_format.json_schema.name).toBe("memory_consolidation_plan");
    expect(openAiMock.completionCreate.mock.calls[1]?.[0].response_format.json_schema.name).toBe("memory_consolidation_review");
  });

  it("keeps ordinary scientific and writing tasks on their structured Flash path", async () => {
    openAiMock.completionCreate
      .mockResolvedValueOnce(completion({
        content: "太阳耀斑会释放增强的电磁辐射；这里先区分耀斑本身与随后可能到达的高能粒子影响。",
        claimIndicesUsed: [1],
        analogy: null,
        distinctions: ["电磁辐射与高能粒子不是同一种传播过程。"],
      }))
      .mockResolvedValueOnce(completion({
        content: "这是按用户要求生成的一段简短课程开场。",
      }));
    const context: CompiledContext = {
      foundationInstructions: "知微基底技能",
      personalSkill: defaultPersonalSkill,
      profileSummary: "",
      memories: [],
      sessionSummary: "",
      recentMessages: [],
      estimatedTokens: 0,
      truncated: false,
    };
    const gateway = new AliyunBailianGateway();

    for await (const _event of gateway.streamDialogue({
      userId: crypto.randomUUID(),
      conversationId: crypto.randomUUID(),
      messageId: crypto.randomUUID(),
      content: "太阳耀斑为什么会影响通信？",
      context,
      scienceMode: true,
      factBrief: {
        claims: [{ text: "太阳耀斑会释放增强的电磁辐射。", status: "supported", sourceIndices: [1] }],
        summary: "已核实一项机制事实。",
      },
      responsePlan: { responseMode: "character", depth: "light", physicalSymptom: false, reason: "普通科学问题" },
    })) {
      // Consume the simulated stream to verify routing and metadata generation.
    }
    for await (const _event of gateway.streamDialogue({
      userId: crypto.randomUUID(),
      conversationId: crypto.randomUUID(),
      messageId: crypto.randomUUID(),
      content: "帮我写一段大学物理课的开场。",
      context,
      responsePlan: { responseMode: "character", depth: "light", physicalSymptom: false, reason: "普通写作任务" },
    })) {
      // Consume the simulated stream to verify routing and metadata generation.
    }

    expect(openAiMock.responseCreate).not.toHaveBeenCalled();
    expect(openAiMock.completionCreate).toHaveBeenCalledTimes(2);
    for (const [request] of openAiMock.completionCreate.mock.calls) {
      expect(request).toMatchObject({
        model: "qwen3.8-flash",
        response_format: { type: "json_schema" },
      });
    }
  });
});
