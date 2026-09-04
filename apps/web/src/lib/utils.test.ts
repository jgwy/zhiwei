import { describe, expect, it, vi } from "vitest";
import { readSseStream } from "./utils";

describe("conversation SSE reader", () => {
  it("decodes Chinese delta split between network chunks", async () => {
    const encoded = new TextEncoder().encode('data: {"type":"text.delta","delta":"知微"}\n\n');
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(encoded.slice(0, 38));
      controller.enqueue(encoded.slice(38));
      controller.close();
    } });
    const receive = vi.fn();
    await readSseStream(new Response(body), receive);
    expect(receive).toHaveBeenCalledExactlyOnceWith({ type: "text.delta", delta: "知微" });
    expect(body.locked).toBe(false);
  });
  it("cancels the reader when an error event terminates the consumer", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"type":"error","code":"interrupted","message":"回复中断"}\n\n'));
    }, cancel });
    await expect(readSseStream(new Response(body), (event) => { if (event.type === "error") throw new Error(event.message); })).rejects.toThrow("回复中断");
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
  });
});
