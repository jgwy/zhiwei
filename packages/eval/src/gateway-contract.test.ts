import { describe, expect, it } from "vitest";
import { defaultPersonalSkill, type CompiledContext } from "@zhiwei/core";
import { ScriptedGateway } from "@zhiwei/model-gateway";

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

describe("offline harness production gateway contract", () => {
  it("reads structured reflection data through ModelGateway", async () => {
    const gateway = new ScriptedGateway();
    const result = await gateway.reflect({
      userId: crypto.randomUUID(),
      conversationId: crypto.randomUUID(),
      messageId: crypto.randomUUID(),
      content: "我更希望你先听我说。",
      context,
      kind: "chat",
    });

    expect(result.meta.provider).toBe("scripted");
    expect(result.meta.transport).toBe("scripted");
    expect(result.data.memories[0]).toMatchObject({
      operation: "create",
      category: "expression",
    });
  });

  it("collects text deltas and requires a completed stream event", async () => {
    const gateway = new ScriptedGateway();
    let content = "";
    let completed = false;

    for await (const event of gateway.streamDialogue({
      userId: crypto.randomUUID(),
      conversationId: crypto.randomUUID(),
      messageId: crypto.randomUUID(),
      content: "我今天有些焦虑。",
      context,
    })) {
      if (event.type === "text.delta") content += event.delta;
      if (event.type === "completed") {
        completed = true;
        expect(event.meta.provider).toBe("scripted");
      }
    }

    expect(content.length).toBeGreaterThan(20);
    expect(completed).toBe(true);
  });
});
