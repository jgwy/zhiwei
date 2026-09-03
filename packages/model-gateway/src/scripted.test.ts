import { describe, expect, it } from "vitest";
import { defaultPersonalSkill, type CompiledContext } from "@zhiwei/core";
import { ScriptedAdapter } from "./index";

const context: CompiledContext = {
  foundationInstructions: "",
  personalSkill: defaultPersonalSkill,
  profileSummary: "",
  profileUpdatedAt: null,
  memories: [],
  sessionSummary: null,
  recentMessages: [],
  temporalContext: { currentTimeUtc: "2026-09-03T06:00:00.000Z", currentLocalTime: "2026-09-03 14:00:00 Asia/Shanghai", timeZone: "Asia/Shanghai" },
  estimatedTokens: 0,
  truncated: false,
};

describe("ScriptedAdapter", () => {
  it("streams a short, natural reply", async () => {
    const adapter = new ScriptedAdapter();
    let result = "";
    for await (const chunk of adapter.streamDialogue({
      userId: crypto.randomUUID(),
      conversationId: crypto.randomUUID(),
      messageId: crypto.randomUUID(),
      content: "最近工作压力很大，我有点焦虑",
      context,
    })) {
      result += chunk;
    }
    expect(result).toContain("不急着劝你振作");
    expect(result.length).toBeLessThan(240);
  });

  it("generates model-owned memory and mood output", async () => {
    const adapter = new ScriptedAdapter();
    const messageId = crypto.randomUUID();
    const reflection = await adapter.reflect({
      userId: crypto.randomUUID(),
      conversationId: crypto.randomUUID(),
      messageId,
      content: "最近工作压力很大，我有点焦虑，不知道怎么办",
      context,
      kind: "chat",
    });
    expect(reflection.memories.length).toBeGreaterThan(0);
    expect(reflection.memories.every((memory) => memory.evidenceMessageIds.includes(messageId))).toBe(true);
    expect(reflection.mood?.score).toBeLessThan(0);
  });
});

