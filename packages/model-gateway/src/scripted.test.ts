import { describe, expect, it } from "vitest";
import { defaultPersonalSkill, type CompiledContext } from "@zhiwei/core";
import { ScriptedGateway } from "./index";

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

describe("ScriptedGateway migrated behavior", () => {
  it("streams a short, natural reply", async () => {
    const adapter = new ScriptedGateway();
    let result = "";
    for await (const chunk of adapter.streamDialogue({
      userId: crypto.randomUUID(),
      conversationId: crypto.randomUUID(),
      messageId: crypto.randomUUID(),
      content: "最近工作压力很大，我有点焦虑",
      context,
    })) {
      if (chunk.type === "text.delta") result += chunk.delta;
    }
    expect(result).toContain("不急着劝你振作");
    expect(result.length).toBeLessThan(240);
  });

  it("generates model-owned memory and mood output", async () => {
    const adapter = new ScriptedGateway();
    const messageId = crypto.randomUUID();
    const { data: reflection } = await adapter.reflect({
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
