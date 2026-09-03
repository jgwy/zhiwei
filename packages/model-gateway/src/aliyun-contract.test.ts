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

describe("Aliyun structured-output quality retry contract", () => {
  const original = {
    apiKey: process.env.MODEL_API_KEY,
    baseUrl: process.env.MODEL_BASE_URL,
    searchTimeoutMs: process.env.MODEL_SEARCH_TIMEOUT_MS,
  };

  beforeEach(() => {
    process.env.MODEL_API_KEY = "unit-test-placeholder";
    process.env.MODEL_BASE_URL = "https://unit-test.invalid/compatible-mode/v1";
    openAiMock.completionCreate.mockReset();
    openAiMock.responseCreate.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (original.apiKey === undefined) delete process.env.MODEL_API_KEY;
    else process.env.MODEL_API_KEY = original.apiKey;
    if (original.baseUrl === undefined) delete process.env.MODEL_BASE_URL;
    else process.env.MODEL_BASE_URL = original.baseUrl;
    if (original.searchTimeoutMs === undefined) delete process.env.MODEL_SEARCH_TIMEOUT_MS;
    else process.env.MODEL_SEARCH_TIMEOUT_MS = original.searchTimeoutMs;
  });

  it("retries a schema-valid profile that violates the no-psychological-inference rule", async () => {
    openAiMock.completionCreate
      .mockResolvedValueOnce(completion({
        summary: "用户表现出很强的心理整合能力和潜在人格倾向。",
        dimensionWeights: weights,
      }))
      .mockResolvedValueOnce(completion({
        summary: "用户正在准备毕业论文，并明确希望交流时先听后建议。",
        dimensionWeights: weights,
      }));

    const result = await new AliyunBailianGateway().synthesizeProfile({
      memories: ["正在准备毕业论文", "希望先听后建议"],
      latestMessage: "这段时间主要在写毕业论文",
    });

    expect(openAiMock.completionCreate).toHaveBeenCalledTimes(2);
    expect(result.data.summary).toBe("用户正在准备毕业论文，并明确希望交流时先听后建议。");
    expect(result.meta).toMatchObject({
      task: "profile-synthesis",
      retries: 1,
      transport: "openai-chat-completions",
    });
    const repairedRequest = openAiMock.completionCreate.mock.calls[1]?.[0];
    expect(repairedRequest.messages[0].content).toContain("上一次输出未通过业务校验");
    expect(repairedRequest.messages[0].content).toContain("不得补写抽象能力、人格或心理动机");
  });

  it("fills omitted profile dimensions without retrying the model call", async () => {
    openAiMock.completionCreate.mockResolvedValueOnce(completion({
      summary: "你正在准备毕业论文。",
      dimensionWeights: { basic: 0.4, goal: 0.2 },
    }));

    const result = await new AliyunBailianGateway().synthesizeProfile({
      memories: ["正在准备毕业论文"],
      latestMessage: "这段时间主要在写毕业论文",
    });

    expect(openAiMock.completionCreate).toHaveBeenCalledTimes(1);
    expect(result.data.dimensionWeights).toEqual({
      basic: 0.4,
      goal: 0.2,
      interest: 0.3,
      expression: 0.3,
      emotion: 0.3,
      experience: 0.3,
      challenge: 0.3,
      boundary: 0.3,
    });
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
    openAiMock.responseCreate.mockResolvedValue({
      async *[Symbol.asyncIterator]() {
        yield { type: "response.output_text.delta", delta: "我听见了。" };
        yield {
          type: "response.completed",
          response: {
            id: "response-unit-test",
            status: "completed",
            usage: { input_tokens: 120, output_tokens: 12 },
          },
        };
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

    const events = [];
    for await (const event of new AliyunBailianGateway().streamDialogue({
      userId: crypto.randomUUID(),
      conversationId: crypto.randomUUID(),
      messageId: crypto.randomUUID(),
      content: "今天被当众否定以后，我一直觉得自己特别差，只想找个人说说。",
      context,
    })) events.push(event);

    expect(openAiMock.responseCreate).toHaveBeenCalledTimes(1);
    const request = openAiMock.responseCreate.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      model: "qwen-plus-character",
      stream: true,
      store: false,
      temperature: 0.58,
      max_output_tokens: 4_000,
      reasoning: { effort: "none" },
    });
    const system = request.input[0].content as string;
    expect(system).toContain("4至8个完整句子");
    expect(system).toContain("最刺痛或最为难的部分");
    expect(system).toContain("不能只换一种说法重复原文");
    expect(system).toContain("brevity是可调的简洁偏好，不是硬性截断");
    expect(system).not.toContain("只用1至3句具体承接");
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      meta: { task: "dialogue", model: "qwen-plus-character" },
    });
  });

  it("surfaces a provider-incomplete long reply instead of marking it completed", async () => {
    openAiMock.responseCreate.mockResolvedValue({
      async *[Symbol.asyncIterator]() {
        yield { type: "response.output_text.delta", delta: "回答还没写完" };
        yield {
          type: "response.completed",
          response: {
            id: "response-incomplete",
            status: "incomplete",
            incomplete_details: { reason: "max_output_tokens" },
          },
        };
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

    await expect(async () => {
      for await (const _event of new AliyunBailianGateway().streamDialogue({
        userId: crypto.randomUUID(),
        conversationId: crypto.randomUUID(),
        messageId: crypto.randomUUID(),
        content: "请详细回答这个问题",
        context,
      })) {
        // Consume the partial stream so the incomplete status is handled.
      }
    }).rejects.toThrow("invalid_response");
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

  it("aborts web search at the configured deadline", async () => {
    process.env.MODEL_SEARCH_TIMEOUT_MS = "20";
    vi.stubGlobal("fetch", vi.fn((_url: URL, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Timed out", "AbortError")), { once: true });
    })));
    const gateway = new AliyunBailianGateway();

    await expect(gateway.buildFactBrief({
      content: "刘一民是谁？",
      route: {
        needsSearch: true,
        scientific: false,
        responseMode: "character",
        depth: "light",
        physicalSymptom: false,
        query: "刘一民是谁",
        impact: "ordinary",
        reason: "人物事实需要核验",
      },
    })).rejects.toThrow("request_cancelled");
  });

  it("uses Flash strict structured output for a routed deep emotional reply", async () => {
    const paragraphs = [
      ", 一上课就头晕，会直接打断注意力，也很容易让你把身体的不舒服和“是不是跟不上”连在一起。大学物理本来就需要持续跟住概念和推导，所以当身体状态先把节奏打乱，那种慌张可能不只是怕漏掉一节课，而是担心自己会从这里一路落下去。",
      "我先把这两件事都认真放在这里，不急着把它变成学习技巧清单，也不会仅凭头晕替你判断原因。头晕这件事本身值得现实地留意，害怕跟不上也并不说明你能力不够。为了先陪你找准最迫近的部分，此刻更让你不安的，是头晕本身，还是已经听不懂某些物理内容的感觉？",
    ];
    openAiMock.completionCreate.mockResolvedValue(completion({
      paragraphs,
      acknowledgedThreads: ["上课时头晕", "担心跟不上大学物理"],
      primaryNeed: "keep-listening",
      clarifyingDirection: "确认此刻头晕和物理学习焦虑中哪一项最迫近。",
    }));
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

    expect(openAiMock.responseCreate).not.toHaveBeenCalled();
    expect(openAiMock.completionCreate).toHaveBeenCalledTimes(1);
    const request = openAiMock.completionCreate.mock.calls[0]?.[0];
    expect(request.model).toBe("qwen3.8-flash");
    expect(request.temperature).toBe(0.38);
    expect(request.response_format).toMatchObject({ type: "json_schema" });
    expect(request.messages[0].content).toContain("身体不适与现实压力");
    expect(request.messages[0].content).toContain("唯一主要动作");
    expect(request.messages[1].content).toContain("我最近感觉一上课头就晕，我又害怕大学物理课跟不上");
    expect(output).toBe(paragraphs.map((paragraph) => paragraph.replace(/^[,，、；;]+\s*/u, "")).join("\n\n"));
    expect(output).not.toMatch(/^[,，、；;]/u);
    expect(output.length).toBeGreaterThanOrEqual(120);
    expect(completed).toMatchObject({
      task: "dialogue",
      model: "qwen3.8-flash",
      transport: "openai-chat-completions",
      usage: { inputTokens: 100, outputTokens: 30, cachedInputTokens: 10 },
    });
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
