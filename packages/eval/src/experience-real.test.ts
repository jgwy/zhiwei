import { afterEach, describe, expect, it, vi } from "vitest";
import {
  experienceScenarios, hasExpectedTextDelivery, mergeCookieJar, parseSseFrame, realExperienceBudget,
  redactExperienceReport, runExperienceReal,
} from "./run-experience-real";

describe("real Web acceptance runner helpers", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("refuses to start without explicit paid-test authorization", async () => {
    vi.stubEnv("ALLOW_PAID_MODEL_TESTS", "false");
    await expect(runExperienceReal()).rejects.toThrow("真实验收默认关闭");
  });

  it("caps the execution budget at five yuan and rejects invalid values", () => {
    expect(realExperienceBudget("5")).toBe(5);
    expect(realExperienceBudget("100")).toBe(5);
    expect(realExperienceBudget("0.8")).toBe(0.8);
    for (const value of ["0", "-1", "NaN", "Infinity"]) expect(() => realExperienceBudget(value)).toThrow();
  });

  it("contains ten bounded synthetic conversations including required operations", () => {
    expect(experienceScenarios).toHaveLength(10);
    expect(experienceScenarios.every((scenario) => scenario.messages.length >= 3 && scenario.messages.length <= 6)).toBe(true);
    expect(experienceScenarios.some((scenario) => scenario.stopAt === 0)).toBe(true);
    expect(experienceScenarios.some((scenario) => scenario.retryAt !== undefined)).toBe(true);
    expect(experienceScenarios.some((scenario) => scenario.emotionOff)).toBe(true);
  });

  it("updates session cookies without forwarding attributes or splitting signed values", () => {
    expect(mergeCookieJar("session=old.signature; other=present", ["session=new.value==; Path=/; HttpOnly; SameSite=Lax"]))
      .toBe("session=new.value==; other=present");
  });

  it("parses protocol data frames and ignores SSE comments", () => {
    expect(parseSseFrame(': heartbeat\r\ndata: {"type":"text.delta","delta":"你好"}')).toEqual({ type: "text.delta", delta: "你好" });
    expect(parseSseFrame(": heartbeat")).toBeNull();
  });

  it("allows a short real acknowledgement to flush once without weakening long-answer streaming", () => {
    const observed = { output: "好，我会按你刚才的说法整理，完成后会显示更新提示。", deltaCount: 1, firstDeltaMs: 5002, completedMs: 5032 };
    expect(hasExpectedTextDelivery(observed)).toBe(true);
    expect(hasExpectedTextDelivery({ ...observed, output: observed.output.repeat(3) })).toBe(false);
    expect(hasExpectedTextDelivery({ ...observed, output: observed.output.repeat(3), deltaCount: 3 })).toBe(true);
  });

  it("redacts tokens, credentials and identifying UUIDs while keeping relationships", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const report = redactExperienceReport({ cookie: "private-cookie", authorization: "Bearer token", apiKey: "private-key", reasoning_content: "not retained", turns: [{ id, output: "sk-test-token is removed" }], sourceId: id });
    expect(report).not.toHaveProperty("cookie");
    expect(report).not.toHaveProperty("authorization");
    expect(report).not.toHaveProperty("apiKey");
    expect(report).not.toHaveProperty("reasoning_content");
    expect(report.turns[0]!.id).toBe(report.sourceId);
    expect(report.sourceId).toBe("record-1");
    expect(report.turns[0]!.output).not.toContain("sk-test-token");
  });
});
