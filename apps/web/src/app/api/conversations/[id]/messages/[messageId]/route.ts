import {
  ConversationRevisionConflictError,
  editMessageAndRollback,
  enqueueJob,
} from "@zhiwei/core";
import { z } from "zod";
import { getSessionUserId } from "@/lib/session";
import { POST as generateReply } from "../route";

const InputSchema = z.object({
  content: z.string().trim().min(1).max(8_000),
  expectedRevision: z.number().int().positive(),
});

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string; messageId: string }> },
) {
  try {
    const userId = await getSessionUserId();
    const { id: conversationId, messageId } = await context.params;
    const input = InputSchema.parse(await request.json());
    const rewritten = await editMessageAndRollback({
      userId,
      conversationId,
      messageId,
      content: input.content,
      expectedRevision: input.expectedRevision,
    });

    const refreshJobs: Promise<string>[] = [];
    if (rewritten.profileStale) {
      refreshJobs.push(enqueueJob({
        userId,
        type: "profile_synthesis",
        idempotencyKey: `profile_synthesis:${conversationId}:r${rewritten.historyRevision}`,
        payload: {
          conversationId,
          messageId,
          historyRevision: rewritten.historyRevision,
          sourceMessageSequence: rewritten.message.sequence,
          traceId: crypto.randomUUID(),
        },
      }));
    }
    if (rewritten.skillStale) {
      refreshJobs.push(enqueueJob({
        userId,
        type: "evolve_skill",
        idempotencyKey: `evolve_skill:rebuild:${conversationId}:r${rewritten.historyRevision}`,
        payload: {
          conversationId,
          messageId,
          historyRevision: rewritten.historyRevision,
          evidenceIds: [messageId],
          latestUserMessage: rewritten.message.content,
          rebuild: true,
          traceId: crypto.randomUUID(),
        },
      }));
    }
    await Promise.allSettled(refreshJobs);

    const internalRequest = new Request(request.url, {
      method: "POST",
      headers: request.headers,
      signal: request.signal,
      body: JSON.stringify({
        content: rewritten.message.content,
        existingMessageId: rewritten.message.id,
        expectedRevision: rewritten.historyRevision,
        rewriteDeletedMessageIds: rewritten.deletedMessageIds,
      }),
    });
    return generateReply(internalRequest, { params: Promise.resolve({ id: conversationId }) });
  } catch (error) {
    const status = error instanceof ConversationRevisionConflictError ? 409 : 400;
    const message = error instanceof Error ? error.message : "消息编辑失败，请重试";
    return Response.json({
      code: status === 409 ? "conversation_revision_conflict" : "message_edit_failed",
      error: message,
    }, { status });
  }
}
