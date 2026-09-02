import { describe, expect, it } from "vitest";
import { distanceFromBottom, isNearChatBottom } from "./chat-scroll";

describe("chat scroll following", () => {
  it("follows updates while the reader remains close to the latest message", () => {
    expect(isNearChatBottom({ scrollHeight: 1_200, scrollTop: 520, clientHeight: 600 })).toBe(true);
  });

  it("stops following after the reader moves up to review earlier messages", () => {
    expect(isNearChatBottom({ scrollHeight: 1_200, scrollTop: 300, clientHeight: 600 })).toBe(false);
  });

  it("never reports a negative distance during layout changes", () => {
    expect(distanceFromBottom({ scrollHeight: 500, scrollTop: 0, clientHeight: 600 })).toBe(0);
  });
});
