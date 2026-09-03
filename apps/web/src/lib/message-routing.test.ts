import { describe, expect, it } from "vitest";
import type { MemoryRecord } from "@zhiwei/core/client";
import { isPersonalDisclosure, isPotentialMemoryQuery, resolveMemoryQuery } from "./message-routing";

function memory(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: crypto.randomUUID(),
    versionId: crypto.randomUUID(),
    category: "basic",
    content: "用户是华中科技大学药学院刘一民。",
    tier: "long",
    confidence: 1,
    validUntil: null,
    reason: "用户确认",
    status: "active",
    sourceType: "confirmed",
    scope: "user",
    scopeKey: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("local message routing", () => {
  it("answers cross-conversation identity questions from active memory", () => {
    const result = resolveMemoryQuery("我是谁？", [memory()]);
    expect(result).toMatchObject({ state: "active" });
    expect(result?.answer).toContain("你是华中科技大学药学院刘一民");
  });

  it("answers a known-name query locally so fact routing can be skipped", () => {
    expect(isPotentialMemoryQuery("刘一民是谁？")).toBe(true);
    const result = resolveMemoryQuery("刘一民是谁？", [memory()]);
    expect(result?.state).toBe("active");
    expect(result?.memoryIds).toHaveLength(1);
  });

  it("does not use pending identity as an established fact", () => {
    const result = resolveMemoryQuery("我试试谁", [memory({ status: "pending", sourceType: "inferred" })]);
    expect(result).toMatchObject({ state: "pending" });
    expect(result?.answer).toContain("还没确认");
  });

  it("keeps unknown people on the external fact path", () => {
    expect(resolveMemoryQuery("马云是谁？", [memory()])).toBeNull();
  });

  it("recognizes plain self-disclosure without treating questions as disclosures", () => {
    expect(isPersonalDisclosure("我是华中科技大学药学院刘一民")).toBe(true);
    expect(isPersonalDisclosure("请记住我喜欢简洁的回答")).toBe(true);
    expect(isPersonalDisclosure("我是谁？")).toBe(false);
  });
});
