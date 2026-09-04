import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { estimateModelCostCny, type ModelCallMeta } from "@zhiwei/core";
import { readDashScopeStream, type DashScopeStreamState } from "./dashscope-stream";

const mock = vi.hoisted(() => ({ completion: vi.fn() }));
vi.mock("openai", () => ({ default: class { chat = { completions: { create: mock.completion } }; } }));
import { AliyunBailianGateway } from "./gateway";

function initial(): DashScopeStreamState {
  return { content: "", sources: [], usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0, searchCalls: 0 }, usageReported: false, finishReason: "failed" };
}

function sse(frames: unknown[], chunkSize = 19): Response {
  const bytes = new TextEncoder().encode(frames.map(frame => `data: ${JSON.stringify(frame)}\r\n\r\n`).join(""));
  return new Response(new ReadableStream({ start(controller) {
    for (let index = 0; index < bytes.length; index += chunkSize) controller.enqueue(bytes.slice(index, index + chunkSize));
    controller.close();
  } }), { headers: { "content-type": "text/event-stream", "x-request-id": "native-header-id" } });
}

function nativeFrames() {
  return [
    { request_id: "native-request", output: { search_info: { search_results: [{ title: "官方资料", url: "https://www.noaa.gov/example" }] }, choices: [{ message: { reasoning_content: "不应保存的推理" }, finish_reason: "null" }] }, usage: { input_tokens: 120, output_tokens: 2 } },
    { output: { choices: [{ message: { content: [{ text: "太阳耀斑" }] }, finish_reason: "null" }] }, usage: { input_tokens: 120, output_tokens: 8 } },
    { output: { choices: [{ message: { content: [{ text: "释放能量。" }] }, finish_reason: "stop" }] }, usage: { input_tokens: 120, output_tokens: 20, input_tokens_details: { cached_tokens: 12 }, output_tokens_details: { reasoning_tokens: 5 } } },
  ];
}

describe("DashScope SSE 聚合", () => {
  it("跨字节分块拼正文，保留提前来源，累积usage不求和且不保存推理", async () => {
    const state = initial();
    await readDashScopeStream(sse(nativeFrames(), 1), state);
    expect(state).toMatchObject({ content: "太阳耀斑释放能量。", finishReason: "stop", requestId: "native-request", httpStatus: 200, usageReported: true });
    expect(state.sources).toHaveLength(1);
    expect(state.usage).toEqual({ inputTokens: 120, outputTokens: 20, cachedInputTokens: 12, reasoningTokens: 5, searchCalls: 1 });
    expect(JSON.stringify(state)).not.toContain("不应保存的推理");
  });

  it("无终态或length终态不把不完整检索当成功", async () => {
    await expect(readDashScopeStream(sse(nativeFrames().slice(0, 2)), initial())).rejects.toThrow("stream_interrupted");
    await expect(readDashScopeStream(sse([{ output: { choices: [{ message: { content: [{ text: "被截断的内容" }] }, finish_reason: "length" }] } }]), initial())).rejects.toThrow("stream_interrupted");
  });

  it("来源出现在多个帧时按URL保留而不丢弃早期来源", async () => {
    const frames = nativeFrames();
    frames.splice(1, 0, { output: { search_info: { search_results: [{ title: "官方资料更新", url: "https://www.noaa.gov/example" }, { title: "研究", url: "https://www.nasa.gov/example" }] } } } as any);
    const state = initial();
    await readDashScopeStream(sse(frames), state);
    expect(state.sources.map(source => source.title)).toEqual(["官方资料更新", "研究"]);
  });

  it("JSON错误保留code/status/requestId，不保存原始message", async () => {
    const state = initial();
    const response = Response.json({ code: "InvalidParameter", request_id: "request-400", message: "含私密配置的供应商原文" }, { status: 400 });
    await expect(readDashScopeStream(response, state)).rejects.toThrow("dashscope_request_failed");
    expect(state).toMatchObject({ providerCode: "InvalidParameter", requestId: "request-400", httpStatus: 400, usageReported: false });
    expect(JSON.stringify(state)).not.toContain("私密配置");
  });

  it("HTTP 200中的错误帧保留已产生usage", async () => {
    const state = initial();
    await expect(readDashScopeStream(sse([nativeFrames()[0], { code: "InternalError", request_id: "request-error", message: "原始错误" }]), state)).rejects.toThrow("dashscope_request_failed");
    expect(state.usage.inputTokens).toBe(120);
    expect(state.providerCode).toBe("InternalError");
  });
});

describe("原生检索与事实整理元数据", () => {
  beforeEach(() => {
    vi.stubEnv("MODEL_API_KEY", "unit-test-key");
    vi.stubEnv("MODEL_BASE_URL", "https://workspace.invalid/compatible-mode/v1");
    mock.completion.mockReset();
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
  const input = { content: "太阳耀斑是什么", route: { scientific: true, needsSearch: true, query: "太阳耀斑", impact: "ordinary" as const, reason: "科学解释", responseMode: "character" as const, depth: "light" as const, physicalSymptom: false } };
  const structured = () => ({ choices: [{ message: { content: JSON.stringify({ claims: [{ text: "太阳耀斑释放能量。", status: "supported", sourceIndices: [1] }], summary: "太阳耀斑释放能量。" }) }, finish_reason: "stop" }], usage: { prompt_tokens: 50, completion_tokens: 10 }, request_id: "structured-request" });

  it("科学max但普通科学不启用思考，保留两个阶段真实usage和费用", async () => {
    const fetchMock = vi.fn(async (url, init) => {
      expect(String(url)).toBe("https://workspace.invalid/api/v1/services/aigc/multimodal-generation/generation");
      expect(new Headers(init.headers).get("x-dashscope-sse")).toBe("enable");
      expect(JSON.parse(init.body).parameters).toMatchObject({ enable_search: true, incremental_output: true, enable_thinking: false, search_options: { search_strategy: "max", enable_source: true, forced_search: true } });
      return sse(nativeFrames());
    });
    vi.stubGlobal("fetch", fetchMock);
    mock.completion.mockResolvedValue(structured());
    const result = await new AliyunBailianGateway().buildFactBrief(input);
    expect(result.meta.usage).toMatchObject({ inputTokens: 170, outputTokens: 30, reasoningTokens: 5, searchCalls: 1 });
    expect(result.meta.usageReported).toBe(true);
    expect(result.meta.attempts?.map(attempt => attempt.transport)).toEqual(["dashscope-multimodal", "openai-chat-completions"]);
    expect(result.meta.estimatedCostCny).toBeCloseTo(result.meta.attempts!.reduce((sum, attempt) => sum + estimateModelCostCny({ model: attempt.model, usage: attempt.usage, searchStrategy: "max" }), 0), 8);
    expect(result.meta.sources).toHaveLength(1);
  });

  it("native成功但结构化两次失败时仍保留全部原生消耗", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sse(nativeFrames())));
    mock.completion.mockResolvedValue({ ...structured(), choices: [{ message: { content: "{}" }, finish_reason: "stop" }] });
    const error = await new AliyunBailianGateway().buildFactBrief(input).then(() => { throw new Error("expected fact brief failure"); }, error => error as Error & { modelMeta: ModelCallMeta });
    expect(error.modelMeta.attempts).toHaveLength(3);
    expect(error.modelMeta.usage).toMatchObject({ inputTokens: 220, outputTokens: 40, searchCalls: 1 });
    expect(error.modelMeta.sources).toHaveLength(1);
  });

  it("真实搜索结束后先关闭计时，再开始结构化事实整理", async () => {
    const phases: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async () => {
      expect(phases).toEqual(["started"]);
      return sse(nativeFrames());
    }));
    mock.completion.mockImplementation(async () => {
      expect(phases).toEqual(["started", "completed"]);
      return structured();
    });
    await new AliyunBailianGateway().buildFactBrief(input, {
      onSearch(event) {
        expect(Number.isNaN(Date.parse(event.startedAt))).toBe(false);
        phases.push(event.status);
      },
    });
    expect(phases).toEqual(["started", "completed"]);
  });

  it("搜索失败也关闭计时，不继续生成事实包", async () => {
    const phases: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ code: "ServiceUnavailable" }, { status: 503 })));
    await expect(new AliyunBailianGateway().buildFactBrief(input, {
      onSearch: (event) => { phases.push(event.status); },
    })).rejects.toThrow();
    expect(phases).toEqual(["started", "completed"]);
    expect(mock.completion).not.toHaveBeenCalled();
  });

  it("native失败也提供unknown usage和安全错误元数据", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ code: "InvalidParameter", request_id: "request-invalid", message: "unit-test-key 不应写入记录" }, { status: 400 })));
    const error = await new AliyunBailianGateway().buildFactBrief(input).then(() => { throw new Error("expected native failure"); }, error => error as Error & { modelMeta: ModelCallMeta });
    expect(mock.completion).not.toHaveBeenCalled();
    expect(error.modelMeta.usageReported).toBe(false);
    expect(error.modelMeta.attempts?.[0]).toMatchObject({ outcome: "failed", providerCode: "InvalidParameter", httpStatus: 400, requestId: "request-invalid", usageReported: false });
    expect(JSON.stringify(error.modelMeta)).not.toContain("unit-test-key");
  });

  it("高影响场景保持max和思考，其他时效事实使用turbo", async () => {
    const parameters: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => { parameters.push(JSON.parse(init.body).parameters); return sse(nativeFrames()); }));
    mock.completion.mockResolvedValue(structured());
    const gateway = new AliyunBailianGateway();
    await gateway.buildFactBrief({ ...input, route: { ...input.route, impact: "high" } });
    await gateway.buildFactBrief({ ...input, route: { ...input.route, scientific: false } });
    expect(parameters[0]).toMatchObject({ enable_thinking: true, search_options: { search_strategy: "max" } });
    expect(parameters[1]).toMatchObject({ enable_thinking: false, search_options: { search_strategy: "turbo" } });
  });
});
