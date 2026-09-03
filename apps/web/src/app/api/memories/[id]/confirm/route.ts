import { addActivity, callMemoryMcp, recordTrace } from "@zhiwei/core";
import { NextResponse } from "next/server";
import { z } from "zod";
import { jsonError } from "@/lib/http";
import { rebuildProfileAfterMemoryChange } from "@/lib/rebuild-profile";
import { getSessionUserId } from "@/lib/session";

const InputSchema = z.object({ versionId: z.string().uuid() });

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const userId = await getSessionUserId();
    const { id: memoryId } = await context.params;
    const { versionId } = InputSchema.parse(await request.json());
    const traceId = crypto.randomUUID();
    const result = await callMemoryMcp<any>({
      tool: "memory_confirm",
      userId,
      traceId,
      arguments: {
        memoryId,
        versionId,
        idempotencyKey: request.headers.get("idempotency-key") ?? `confirm:${memoryId}:${versionId}`,
      },
    });
    if (result.memory?.tier === "long") {
      try {
        await rebuildProfileAfterMemoryChange({
          userId,
          traceId,
          triggerKey: `confirm:${memoryId}:${versionId}`,
          latestMessage: "用户确认了一条新的认识。",
        });
      } catch (error) {
        await recordTrace({
          userId,
          traceId,
          stage: "profile.rebuild_deferred",
          payload: {
            message: "记忆已确认，画像重建将在后续交流中完成。",
            code: error instanceof Error ? error.message : "rebuild_failed",
          },
        });
      }
    }
    await addActivity({ userId, type: "memory.confirmed", payload: result });
    return NextResponse.json(result);
  } catch (error) {
    return jsonError(error, isMemoryConflict(error) ? 409 : 400);
  }
}

function isMemoryConflict(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message === "memory_version_conflict" || message === "memory_idempotency_conflict";
}
