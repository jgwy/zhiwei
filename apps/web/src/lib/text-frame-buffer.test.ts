import { afterEach, describe, expect, it, vi } from "vitest";
import { createTextFrameBuffer } from "./text-frame-buffer";

afterEach(() => vi.useRealTimers());

describe("text animation-frame buffer", () => {
  it("combines all received deltas in one frame without a typing backlog", () => {
    let render: FrameRequestCallback = () => {};
    const deliver = vi.fn();
    const schedule = vi.fn((callback: FrameRequestCallback) => { render = callback; return 1; });
    const buffer = createTextFrameBuffer(deliver, schedule, vi.fn());
    buffer.push("我"); buffer.push("听到了。");
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(deliver).not.toHaveBeenCalled();
    render(16);
    expect(deliver).toHaveBeenCalledExactlyOnceWith("我听到了。");
    buffer.dispose();
  });
  it("flushes before 200ms when animation frames are paused", () => {
    vi.useFakeTimers();
    const deliver = vi.fn();
    const buffer = createTextFrameBuffer(deliver, () => 1, vi.fn());
    buffer.push("后台标签页收到的内容");
    vi.advanceTimersByTime(160);
    expect(deliver).toHaveBeenCalledExactlyOnceWith("后台标签页收到的内容");
    buffer.dispose();
  });
  it("flushes all text before the completion state and cancels stale callbacks", () => {
    const deliver = vi.fn();
    const cancel = vi.fn();
    const buffer = createTextFrameBuffer(deliver, () => 7, cancel);
    buffer.push("最后一段"); buffer.flush(); buffer.dispose();
    expect(deliver).toHaveBeenCalledExactlyOnceWith("最后一段");
    expect(cancel).toHaveBeenCalledWith(7);
  });
});
