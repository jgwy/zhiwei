import { describe, expect, it } from "vitest";
import { assistantStreamDisposition } from "./assistant-stream";

describe("assistant stream disposition", () => {
  it("does not persist or reflect a completed stream without a valid delta", () => {
    expect(assistantStreamDisposition(" \n ", "completed")).toEqual({ persistAssistant: false, enqueueReflection: false });
  });

  it("persists a useful partial reply without enqueueing reflection", () => {
    expect(assistantStreamDisposition("已经生成的有效内容", "interrupted")).toEqual({ persistAssistant: true, enqueueReflection: false });
  });

  it("persists and reflects a valid completed reply", () => {
    expect(assistantStreamDisposition("完整回复", "completed")).toEqual({ persistAssistant: true, enqueueReflection: true });
  });
});
