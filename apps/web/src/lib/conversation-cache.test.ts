import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@zhiwei/core/client";
import { cacheConversation, mergeInflightTurn, prependMessagePage } from "./conversation-cache";
import type { MessagePage } from "./client-types";

const message = (id: string, role: ChatMessage["role"] = "user", content = id): ChatMessage => ({ id, role, content, createdAt: "2026-09-04T00:00:00.000Z" });
const page = (messages: ChatMessage[] = []): MessagePage => ({ messages, hasMore: false, nextCursor: null });

describe("conversation pages", () => {
  it("keeps three recent conversations without evicting the selected page", () => {
    let cache = new Map<string, MessagePage>();
    for (const id of ["one", "two", "three", "four"]) cache = cacheConversation(cache, id, page(), "one");
    expect([...cache.keys()]).toEqual(["one", "three", "four"]);
    cache = cacheConversation(cache, "three", cache.get("three")!, "three");
    expect([...cache.keys()]).toEqual(["one", "four", "three"]);
  });
  it("preserves a whole in-flight turn when the server has only the user message", () => {
    const user = message("user");
    const assistant = message("assistant", "assistant", "已收到的流式内容");
    const merged = mergeInflightTurn(page([message("old"), user]), { conversationId: "one", user, assistant });
    expect(merged.messages.map((item) => item.id)).toEqual(["old", "user", "assistant"]);
    expect(merged.messages.at(-1)?.content).toBe("已收到的流式内容");
  });
  it("keeps the generating conversation when the user switches and prefetch runs", () => {
    let cache = new Map<string, MessagePage>();
    for (const id of ["generating", "active", "prefetch-one", "prefetch-two"]) cache = cacheConversation(cache, id, page(), "active", "generating");
    expect([...cache.keys()]).toEqual(["generating", "active", "prefetch-two"]);
  });
  it("replaces only the retried attempt, keeping its user evidence once", () => {
    const user = message("user");
    const old = message("old-assistant", "assistant");
    const next = message("next-assistant", "assistant");
    const merged = mergeInflightTurn(page([user, old]), { conversationId: "one", user, assistant: next, retryOf: old.id });
    expect(merged.messages.map((item) => item.id)).toEqual(["user", "next-assistant"]);
  });
  it("prepends older history without duplicate overlap or overwriting current streaming text", () => {
    const older = { ...page([message("one"), message("two")]), hasMore: true, nextCursor: "older" };
    const merged = prependMessagePage(page([message("two", "user", "current"), message("three")]), older);
    expect(merged.messages.map((item) => item.id)).toEqual(["one", "two", "three"]);
    expect(merged.messages[1]?.content).toBe("current");
    expect(merged.nextCursor).toBe("older");
  });
});
