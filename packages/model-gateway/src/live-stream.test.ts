import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultPersonalSkill } from "@zhiwei/core";
import { AliyunBailianGateway } from "./gateway";
import { StreamTextBuffer } from "./response-quality";

const mocks = vi.hoisted(() => ({ chat: vi.fn(), responses: vi.fn() }));
vi.mock("openai", () => ({ default: class {
  chat = { completions: { create: mocks.chat } };
  responses = { create: mocks.responses };
} }));

function input() {
  return {
    userId: crypto.randomUUID(), conversationId: crypto.randomUUID(), messageId: crypto.randomUUID(),
    content: "我最近感觉一上课头就晕，我又害怕大学物理课跟不上",
    context: { foundationInstructions: "", personalSkill: defaultPersonalSkill, profileSummary: "", memories: [], sessionSummary: "", recentMessages: [], estimatedTokens: 0, truncated: false },
    responsePlan: { responseMode: "emotional-deep" as const, depth: "high" as const, physicalSymptom: true, reason: "具体处境" },
  };
}

describe("live stream protocol", () => {
  beforeEach(() => {
    vi.stubEnv("MODEL_API_KEY", "local-unit-test");
    vi.stubEnv("MODEL_BASE_URL", "https://unit-test.invalid/compatible-mode/v1");
    mocks.chat.mockReset(); mocks.responses.mockReset();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("releases a verified prefix before upstream completion and never rewrites style", async () => {
    const text = "上课头晕和担心物理课跟不上，这两件事叠在一起确实不好受，我会认真听。现在呢？后来呢？";
    let upstreamFinished = false;
    mocks.chat.mockResolvedValue({ async *[Symbol.asyncIterator]() {
      for (const delta of [...text].reduce<string[]>((parts, char, index) => {
        if (index % 7 === 0) parts.push("");
        parts[parts.length - 1] += char; return parts;
      }, [])) yield { choices: [{ delta: { content: delta } }] };
      upstreamFinished = true;
      yield { choices: [{ finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 20 } };
    } });
    const iterator = new AliyunBailianGateway().streamDialogue(input())[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.value).toMatchObject({ type: "text.delta" });
    expect(upstreamFinished).toBe(false);
    let content = first.value?.type === "text.delta" ? first.value.delta : "";
    let completed: any;
    for await (const event of { [Symbol.asyncIterator]: () => iterator }) {
      if (event.type === "text.delta") content += event.delta;
      if (event.type === "completed") completed = event.meta;
    }
    expect(content).toBe(text);
    expect(completed.firstTokenMs).toBeLessThanOrEqual(completed.firstDeltaMs);
    expect(completed.attempts[0].errorCode).toContain("diagnostic:");
    expect(mocks.chat).toHaveBeenCalledTimes(1);
  });

  it("keeps published text and known usage on later failure without retry or fallback", async () => {
    const prefix = "你的身体不适和学业担心都值得认真对待，不需要先证明自己已经撑不住了才可以把这些困难说出来。";
    mocks.chat.mockResolvedValue({ async *[Symbol.asyncIterator]() {
      yield { choices: [{ delta: { content: prefix } }], usage: { prompt_tokens: 60, completion_tokens: 10 } };
      throw new Error("connection closed");
    } });
    let output = "";
    let failure: any;
    try {
      for await (const event of new AliyunBailianGateway().streamDialogue(input())) {
        if (event.type === "text.delta") output += event.delta;
      }
    } catch (error) { failure = error; }
    expect(output).toBe([...prefix].slice(0, -8).join(""));
    expect(failure.modelMeta).toMatchObject({ usageReported: true, finishReason: "interrupted", usage: { inputTokens: 60 }, attempts: [expect.objectContaining({ outcome: "failed" })] });
    expect(mocks.chat).toHaveBeenCalledTimes(1);
    expect(mocks.responses).not.toHaveBeenCalled();
  });

  it("marks missing usage as unknown on cancellation", async () => {
    const controller = new AbortController();
    mocks.chat.mockResolvedValue({ async *[Symbol.asyncIterator]() {
      yield { choices: [{ delta: { content: "这些具体的感受我听到了，你可以先从其中最难的一点说起，我们不需要马上给出所有问题的答案。" } }] };
      controller.abort();
      throw new DOMException("Stopped", "AbortError");
    } });
    let failure: any;
    try { for await (const _event of new AliyunBailianGateway().streamDialogue(input(), { signal: controller.signal })) {} }
    catch (error) { failure = error; }
    expect(failure.message).toBe("request_cancelled");
    expect(failure.modelMeta).toMatchObject({ usageReported: false, finishReason: "cancelled" });
    expect(mocks.chat).toHaveBeenCalledTimes(1);
  });

  it("never forwards provider reasoning fields while preserving normal parentheses in the answer", async () => {
    const visible = "这里的关键是把两件事分开：身体不适需要认真观察，学习压力（尤其是担心漏掉推导）也值得被听见。";
    mocks.chat.mockResolvedValue({ async *[Symbol.asyncIterator]() {
      yield { choices: [{ delta: { reasoning_content: "（我应该先分析，再决定怎么安慰用户。）" } }] };
      yield { choices: [{ delta: { content: visible } }] };
      yield { choices: [{ finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 30 } };
    } });
    const events: unknown[] = [];
    let output = "";
    for await (const event of new AliyunBailianGateway().streamDialogue(input())) {
      events.push(event);
      if (event.type === "text.delta") output += event.delta;
    }
    expect(output).toBe(visible);
    expect(output).toContain("（尤其是担心漏掉推导）");
    expect(JSON.stringify(events)).not.toContain("我应该先分析");
    expect(JSON.stringify(events)).not.toContain("reasoning_content");
  });

  it("retries an internal preface before any text is visible, but keeps a normal term in parentheses", async () => {
    const texts = ["（我需要分析用户现在的状态，然后选择一个合适的安慰方式。）你现在还好吗？", "（认知重评）是对解释角度的调整，不过你现在想先被听见，我们就先从这份难过说起。"];
    mocks.chat.mockImplementation(async () => ({ async *[Symbol.asyncIterator]() {
      yield { choices: [{ delta: { content: texts.shift() } }] };
      yield { choices: [{ finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 30 } };
    } }));
    let output = "";
    for await (const event of new AliyunBailianGateway().streamDialogue(input())) {
      if (event.type === "text.delta") output += event.delta;
    }
    expect(output).toContain("（认知重评）");
    expect(output).not.toContain("我需要分析");
    expect(mocks.chat).toHaveBeenCalledTimes(2);
  });

  it("stops on corruption across chunks and does not publish the held tail", () => {
    const buffer = new StreamTextBuffer();
    const prefix = "这是一段正常中文内容，足够达到首段验证所需的长度，可以先向用户逐步展示已经生成的部分。";
    expect(buffer.push(prefix).length).toBeGreaterThan(0);
    expect(buffer.push("ÀÁÂ")).toBe([...prefix].slice(-8, -5).join(""));
    expect(() => buffer.push("ÃÄÅ")).toThrow("mojibake-run");
  });

  it("releases a normal short answer at completion and preserves code punctuation", () => {
    const short = new StreamTextBuffer();
    expect(short.push("好，我在。")).toBe("");
    expect(short.finish()).toBe("好，我在。");
    const code = new StreamTextBuffer();
    const text = "下面是你要的简短示例：\n```ts\nconst rows = [{}];\n```";
    expect(code.push(text) + code.finish()).toBe(text);
  });
});
