import {
  addMessage,
  compileContext,
  enqueueJob,
  getActiveSkill,
  getConversationSummary,
  getProfileForContext,
  listConversations,
  listMessages,
  recordTrace,
  recordModelRun,
  recordRiskEvent,
  searchMemories,
  assessRisk,
  updateConversationTitle,
  type PersonalSkill,
  type StreamEvent,
} from "@zhiwei/core";
import { getModelAdapter } from "@zhiwei/model-gateway";
import { composeFoundationInstructions } from "@zhiwei/skills";
import { z } from "zod";
import { getSessionUserId } from "@/lib/session";

const InputSchema = z.object({ content: z.string().trim().min(1).max(8_000) });
const encoder = new TextEncoder();

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const userId = await getSessionUserId();
  const { id: conversationId } = await context.params;
  const input = InputSchema.parse(await request.json());
  const conversations = await listConversations(userId);
  const conversation = conversations.find((item) => item.id === conversationId);
  if (!conversation) return new Response("conversation_not_found", { status: 404 });

  const traceId = crypto.randomUUID();
  const userMessage = await addMessage({
    conversationId,
    userId,
    role: "user",
    content: input.content,
    metadata: { traceId },
  });
  const riskAssessment = assessRisk(input.content);
  const riskEventId = await recordRiskEvent({
    userId,
    conversationId,
    messageId: userMessage.id,
    assessment: riskAssessment,
  });
  if (conversation.messages.length === 0) {
    await updateConversationTitle(userId, conversationId, createTitle(input.content));
  }

  const adapter = getModelAdapter();
  const [messages, profile, memories, summary, activeSkill] = await Promise.all([
    listMessages(userId, conversationId, 24),
    getProfileForContext(userId),
    searchMemories(userId, input.content, 8),
    getConversationSummary(userId, conversationId),
    getActiveSkill(userId),
  ]);
  const compiled = compileContext({
    foundationInstructions: composeFoundationInstructions([
      "zhiwei-persona",
      "dialogue-orchestrator",
      "fact-and-tool-use",
      "risk-and-boundary",
      "privacy-and-withdrawal",
    ]),
    personalSkill: activeSkill?.content as PersonalSkill,
    profile,
    memories,
    sessionSummary: summary,
    messages,
    maxInputTokens: Math.min(18_000, adapter.capabilities.maxContextTokens - 2_000),
  });
  await recordTrace({
    userId,
    traceId,
    stage: "dialogue.context_compiled",
    payload: {
      adapter: adapter.id,
      skillVersion: activeSkill?.version,
      memoryIds: memories.map((memory) => memory.id),
      riskAssessment,
      compiled,
    },
  });

  const assistantMessageId = crypto.randomUUID();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: StreamEvent) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      let output = "";
      const started = Date.now();
      try {
        send({ type: "message.started", messageId: assistantMessageId, traceId });
        if (memories.length) {
          send({ type: "tool.started", name: "memory_search" });
          send({ type: "tool.completed", name: "memory_search" });
        }
        for await (const delta of adapter.streamDialogue({
          userId,
          conversationId,
          messageId: userMessage.id,
          content: input.content,
          context: compiled,
          riskAssessment,
        })) {
          if (request.signal.aborted) break;
          output += delta;
          send({ type: "text.delta", delta });
        }
        await addMessage({
          id: assistantMessageId,
          conversationId,
          userId,
          role: "assistant",
          content: output,
          metadata: { traceId, adapter: adapter.id },
        });
        const jobId =
          riskAssessment.level === "ordinary"
            ? await enqueueJob({
                userId,
                type: "reflection",
                payload: {
                  conversationId,
                  messageId: userMessage.id,
                  content: input.content,
                  kind: "chat",
                  traceId,
                },
              })
            : riskEventId;
        await recordTrace({
          userId,
          traceId,
          stage: "dialogue.completed",
          durationMs: Date.now() - started,
          payload: {
            messageId: assistantMessageId,
            output,
            jobId,
            estimatedInputTokens: compiled.estimatedTokens,
            estimatedOutputTokens: Math.ceil(output.length / 2.4),
          },
        });
        await recordModelRun({
          userId,
          traceId,
          role: "dialogue",
          adapterId: adapter.id,
          inputTokens: compiled.estimatedTokens,
          outputTokens: Math.ceil(output.length / 2.4),
          durationMs: Date.now() - started,
          finishReason: request.signal.aborted ? "cancelled" : "completed",
        });
        send({ type: "message.completed", messageId: assistantMessageId, jobId });
      } catch (error) {
        send({
          type: "error",
          code: "generation_failed",
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}

function createTitle(content: string) {
  return content.replace(/\s+/g, " ").slice(0, 18) || "新的对话";
}
