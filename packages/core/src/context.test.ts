import { describe, expect, it } from "vitest";
import { defaultPersonalSkill } from "./personal-skill";
import { compileContext } from "./context";

describe("compiled temporal context", () => {
  it("carries current time, profile age, summary coverage, and message order", () => {
    const compiled = compileContext({
      foundationInstructions: "foundation",
      personalSkill: defaultPersonalSkill,
      profile: {
        id: crypto.randomUUID(),
        summary: "正在准备考试。",
        dimensionWeights: {},
        understanding: { coverage: 0, validation: 0, personalization: 0, temporal: 0 },
        score: 0,
        createdAt: "2026-08-01T00:00:00.000Z",
      },
      memories: [],
      sessionSummary: {
        summary: "上次聊到复习安排。",
        createdAt: "2026-09-01T00:00:00.000Z",
        coveredThroughAt: "2026-09-01T00:00:00.000Z",
        sourceMessageId: crypto.randomUUID(),
      },
      messages: [{
        id: crypto.randomUUID(),
        role: "user",
        content: "今天继续聊",
        createdAt: "2026-09-03T05:59:00.000Z",
        sequence: 7,
      }],
      maxInputTokens: 10_000,
      timeZone: "Asia/Shanghai",
      now: new Date("2026-09-03T06:00:00.000Z"),
    });

    expect(compiled.temporalContext).toEqual({
      currentTimeUtc: "2026-09-03T06:00:00.000Z",
      currentLocalTime: "2026-09-03 14:00:00 Asia/Shanghai",
      timeZone: "Asia/Shanghai",
    });
    expect(compiled.profileUpdatedAt).toBe("2026-08-01T00:00:00.000Z");
    expect(compiled.sessionSummary?.coveredThroughAt).toBe("2026-09-01T00:00:00.000Z");
    expect(compiled.recentMessages[0]?.sequence).toBe(7);
  });
});
