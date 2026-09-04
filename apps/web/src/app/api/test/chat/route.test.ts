import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureUser: vi.fn(), createConversation: vi.fn(), submitTurn: vi.fn(),
  session: vi.fn(), stream: vi.fn(),
}));
vi.mock("@zhiwei/core", async (original) => ({
  ...await original<typeof import("@zhiwei/core")>(),
  ensureUser: mocks.ensureUser, createConversation: mocks.createConversation, submitTurn: mocks.submitTurn,
}));
vi.mock("@/lib/session", () => ({ getOrCreateSessionUserId: mocks.session }));
vi.mock("@/lib/dialogue-service", async () => ({
  ...await import("../../../../lib/dialogue-service"), streamAcceptedTurn: mocks.stream,
}));
vi.mock("@/lib/http", async () => import("../../../../lib/http"));
vi.mock("@/lib/utils", async () => import("../../../../lib/utils"));

import { GET, POST } from "./route";

const conversationId = "a02a9fe4-9c55-46ba-a4fd-d6151567ca02";
const clientRequestId = "b02a9fe4-9c55-46ba-a4fd-d6151567ca02";
const accepted = { assistant: { id: "assistant-message" }, userMessage: { id: "user-message" }, traceId: "trace", jobId: "job" };
const sources = [{ title: "资料来源", url: "https://example.org/article" }];
const encoder = new TextEncoder();

function request(body: unknown = { message: "你好" }) {
  return new Request("http://localhost/api/test/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}
function sse(events: unknown[]) {
  const bytes = encoder.encode(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      // Deliberately split UTF-8 bytes and SSE records, not just complete events.
      for (let index = 0; index < bytes.length; index += 7) controller.enqueue(bytes.slice(index, index + 7));
      controller.close();
    },
  }));
}

describe("test chat API", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.session.mockResolvedValue("owner");
    mocks.ensureUser.mockResolvedValue(undefined);
    mocks.createConversation.mockResolvedValue({ id: conversationId });
    mocks.submitTurn.mockResolvedValue(accepted);
    mocks.stream.mockImplementation(() => sse([
      { type: "text.delta", delta: "你好，" },
      { type: "text.delta", delta: "慢慢说。" },
      { type: "message.completed", status: "completed", sources },
    ]));
  });

  it("GET describes the endpoint without identity, writes or model calls", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ method: "POST", path: "/api/test/chat" });
    for (const mock of Object.values(mocks)) expect(mock).not.toHaveBeenCalled();
  });

  it("persists one turn and returns assembled text and sources through the shared stream", async () => {
    const input = request({ message: "  你好  ", clientRequestId });
    const response = await POST(input);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ conversationId, messageId: "assistant-message", userMessageId: "user-message", traceId: "trace", reply: "你好，慢慢说。", sources, memoryUpdateQueued: true, status: "completed" });
    expect(mocks.session).toHaveBeenCalledExactlyOnceWith(input);
    expect(mocks.ensureUser).toHaveBeenCalledExactlyOnceWith("owner");
    expect(mocks.createConversation).toHaveBeenCalledExactlyOnceWith("owner");
    expect(mocks.submitTurn).toHaveBeenCalledExactlyOnceWith({ userId: "owner", conversationId, content: "你好", clientRequestId });
    expect(mocks.stream).toHaveBeenCalledExactlyOnceWith(input, "owner", conversationId, accepted);
  });

  it("continues an existing conversation without creating another", async () => {
    const response = await POST(request({ message: "继续", conversationId }));
    expect(response.status).toBe(200);
    expect(mocks.createConversation).not.toHaveBeenCalled();
    expect(mocks.submitTurn).toHaveBeenCalledWith(expect.objectContaining({ userId: "owner", conversationId }));
  });

  it.each([
    { message: "你好", userId: "another-owner" },
    { message: "你好", user_id: "another-owner" },
    { message: " " },
    { message: "好".repeat(8001) },
    { message: "你好", conversationId: "not-a-uuid" },
    { message: "你好", clientRequestId: "not-a-uuid" },
  ])("rejects invalid input without identity or writes: %j", async (body) => {
    const response = await POST(request(body));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_input" });
    for (const mock of Object.values(mocks)) expect(mock).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON without writing", async () => {
    const response = await POST(new Request("http://localhost/api/test/chat", { method: "POST", body: "{" }));
    expect(response.status).toBe(400);
    expect(mocks.ensureUser).not.toHaveBeenCalled();
  });

  it("keeps another user's conversation inaccessible", async () => {
    mocks.submitTurn.mockRejectedValue(new Error("conversation_not_found"));
    const response = await POST(request({ message: "继续", conversationId }));
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "conversation_not_found" });
    expect(mocks.createConversation).not.toHaveBeenCalled();
    expect(mocks.stream).not.toHaveBeenCalled();
  });

  it("returns a conflict for a duplicate request without another stream", async () => {
    mocks.submitTurn.mockRejectedValue(new Error("message_already_submitted"));
    const response = await POST(request({ message: "继续", conversationId, clientRequestId }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "message_already_submitted" });
    expect(mocks.stream).not.toHaveBeenCalled();
  });

  it("rejects invalid sessions before persistence", async () => {
    mocks.session.mockRejectedValue(new Error("anonymous_session_invalid"));
    const response = await POST(request());
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "invalid_session" });
    expect(mocks.ensureUser).not.toHaveBeenCalled();
  });

  it.each([
    { ending: [{ type: "error", code: "timeout" }] },
    { ending: [{ type: "message.completed", status: "stopped" }] },
    { ending: [] },
  ])("preserves partial text when generation does not complete: %j", async ({ ending }) => {
    mocks.stream.mockReturnValue(sse([{ type: "text.delta", delta: "已经生成的部分。" }, ...ending]));
    const response = await POST(request());
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ status: "interrupted", reply: "已经生成的部分。", messageId: "assistant-message" });
  });

  it("preserves partial text when the underlying response reader disconnects", async () => {
    let sent = false;
    mocks.stream.mockReturnValue(new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) { sent = true; controller.enqueue(encoder.encode('data: {"type":"text.delta","delta":"已经收到。"}\n\n')); }
        else controller.error(new Error("socket disconnected upstream.internal"));
      },
    })));
    const response = await POST(request());
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body).toMatchObject({ status: "interrupted", reply: "已经收到。" });
    expect(JSON.stringify(body)).not.toContain("upstream.internal");
  });

  it("does not expose an upstream exception in public errors", async () => {
    mocks.stream.mockImplementation(() => { throw new Error("provider request failed at https://internal.invalid with Bearer secret-token"); });
    const response = await POST(request());
    expect(response.status).toBeGreaterThanOrEqual(500);
    const body = await response.text();
    expect(body).not.toMatch(/internal\.invalid|secret-token|Bearer|provider request failed/);
    expect(body).toMatch(/[\u3400-\u9fff]/u);
  });

  it("does not expose raw provider text from a stream error event", async () => {
    mocks.stream.mockReturnValue(sse([{ type: "error", code: "upstream request failed at internal.invalid Bearer secret-token" }]));
    const response = await POST(request());
    expect(response.status).toBe(502);
    expect(await response.text()).not.toMatch(/internal\.invalid|secret-token|Bearer|upstream request failed/);
  });
});
