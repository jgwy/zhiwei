import { createConversation, ensureUser, submitTurn, type ModelSource } from "@zhiwei/core";
import { NextResponse } from "next/server";
import { z } from "zod";
import { streamAcceptedTurn, dialogueErrorCode, dialogueErrorMessage } from "@/lib/dialogue-service";
import { getOrCreateSessionUserId } from "@/lib/session";
import { jsonError } from "@/lib/http";
import { readSseStream } from "@/lib/utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 180;

const InputSchema = z.object({
  message: z.string().trim().min(1).max(8_000),
  conversationId: z.string().uuid().optional(),
  clientRequestId: z.string().uuid().optional(),
}).strict();

export async function GET() {
  return NextResponse.json({
    name: "知微对话测试 API",
    method: "POST",
    path: "/api/test/chat",
    contentType: "application/json",
    example: { message: "我第一次做课程汇报，有点担心讲错。" },
    fields: {
      message: "必填，1–8000 字符。",
      conversationId: "选填，使用上次返回的编号继续该会话；不传则新建会话。",
      clientRequestId: "选填，UUID；用于避免同一请求重复写入用户消息。",
    },
    session: "首次 POST 自动返回签名 HttpOnly Cookie；请保存并在后续请求中携带。仅有 conversationId 不能访问他人会话。无需提供模型 API Key。",
    persistence: "聊天和模型生成的记忆按当前身份的授权设置保存。记忆、画像和相处方式在后台整理，不保证随本次回复同时完成。",
    billing: "POST 使用服务端配置的真实模型并产生相应调用费用；GET 仅返回接口说明，不调用模型。",
  });
}

export async function POST(request: Request) {
  try {
    const input = InputSchema.parse(await request.json());
    const userId = await getOrCreateSessionUserId(request);
    await ensureUser(userId);
    const conversationId = input.conversationId ?? (await createConversation(userId)).id;
    const turn = await submitTurn({
      userId, conversationId, content: input.message, clientRequestId: input.clientRequestId,
    });
    const stream = streamAcceptedTurn(request, userId, conversationId, turn);
    let reply = "";
    let completed = false;
    let sources: ModelSource[] = [];
    let errorCode: string | null = null;
    try {
      await readSseStream(stream, (event) => {
        if (event.type === "text.delta") reply += event.delta;
        if (event.type === "message.completed") {
          completed = event.status !== "stopped";
          sources = event.sources ?? [];
        }
        if (event.type === "error") errorCode = dialogueErrorCode(new Error(event.code));
      });
    } catch (error) {
      errorCode = dialogueErrorCode(error);
    }
    const result = {
      conversationId,
      messageId: turn.assistant!.id,
      userMessageId: turn.userMessage.id,
      traceId: turn.traceId,
      reply,
      sources,
      memoryUpdateQueued: Boolean(turn.jobId),
    };
    if (errorCode || !completed || !reply.trim()) {
      const code = errorCode ?? "stream_interrupted";
      return NextResponse.json({ ...result, status: "interrupted", code, error: dialogueErrorMessage(new Error(code)) }, { status: 502 });
    }
    return NextResponse.json({ ...result, status: "completed" });
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError)
      return NextResponse.json({ code: "invalid_input", error: "请提交 JSON：message 需为 1–8000 字符；可选的 conversationId 和 clientRequestId 需为 UUID。" }, { status: 400 });
    const code = error instanceof Error ? error.message : "";
    if (code === "conversation_not_found")
      return NextResponse.json({ code, error: "对话不存在或不属于当前身份。请携带原 Cookie，或不传 conversationId 开始新对话。" }, { status: 404 });
    if (code === "message_already_submitted")
      return NextResponse.json({ code, error: "这条请求已经提交过，请读取原会话，不要重复发送同一个 clientRequestId。" }, { status: 409 });
    if (code.startsWith("anonymous_session_"))
      return NextResponse.json({ code: "invalid_session", error: "访问凭证无效，请使用原 Cookie；开始独立测试时可以不携带 Cookie。" }, { status: 401 });
    return jsonError(error);
  }
}
