import { describe, expect, it } from "vitest";
import { compileContext } from "./context";
import { defaultPersonalSkill } from "./personal-skill";

describe("compileContext", () => {
  it("keeps the latest 32 messages when the token budget allows it", () => {
    const messages = Array.from({ length: 40 }, (_, index) => ({
      id: String(index),
      role: index % 2 ? "assistant" as const : "user" as const,
      content: `message-${index}`,
      createdAt: new Date().toISOString(),
    }));
    const result = compileContext({
      foundationInstructions: "foundation",
      personalSkill: defaultPersonalSkill,
      profile: null,
      memories: [],
      sessionSummary: null,
      messages,
      maxInputTokens: 36_000,
    });
    expect(result.recentMessages).toHaveLength(32);
    expect(result.recentMessages[0]?.content).toBe("message-8");
  });
});
