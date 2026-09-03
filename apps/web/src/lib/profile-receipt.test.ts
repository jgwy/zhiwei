import { describe, expect, it } from "vitest";
import { resolveProfileReceiptMessageId } from "./profile-receipt";
import type { ConversationView } from "./client-types";

const conversation = {
  id: "conversation-1",
  title: "测试",
  titleSource: "default",
  titleLocked: false,
  messageCount: 5,
  createdAt: "2026-09-03T00:00:00.000Z",
  updatedAt: "2026-09-03T00:00:00.000Z",
  messages: [
    { id: "user-1", role: "user", content: "你好", createdAt: "2026-09-03T00:00:00.000Z", metadata: { traceId: "trace-1" } },
    { id: "assistant-1", role: "assistant", content: "你好", createdAt: "2026-09-03T00:00:01.000Z", metadata: { traceId: "trace-1" } },
    { id: "assistant-2", role: "assistant", content: "另一条", createdAt: "2026-09-03T00:00:02.000Z" },
  ],
} satisfies ConversationView;

describe("profile receipt target", () => {
  it("prefers an explicit assistant message id", () => {
    expect(resolveProfileReceiptMessageId([conversation], { assistantMessageId: "assistant-2", sourceMessageId: "user-1" })).toBe("assistant-2");
  });

  it("maps a source user message to its following assistant response", () => {
    expect(resolveProfileReceiptMessageId([conversation], { sourceMessageId: "user-1" })).toBe("assistant-1");
  });

  it("does not attach background profile work to an unrelated latest message", () => {
    expect(resolveProfileReceiptMessageId([conversation], { sourceMessageId: null })).toBeNull();
  });
});
