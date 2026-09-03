import {
  addActivity,
  callMemoryMcp,
  recordTrace,
} from "@zhiwei/core";
import { NextResponse } from "next/server";
import { z } from "zod";
import { jsonError } from "@/lib/http";
import { rebuildProfileAfterMemoryChange } from "@/lib/rebuild-profile";
import { getSessionUserId } from "@/lib/session";

const InputSchema = z.object({
  versionId: z.string().uuid(),
  reason: z.string().max(300).optional(),
});

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const userId = await getSessionUserId();
    const { id } = await context.params;
    const input = InputSchema.parse(await request.json().catch(() => ({})));
    const traceId = crypto.randomUUID();
    const withdrawal = await callMemoryMcp<any>({
      tool: "memory_withdraw",
      userId,
      traceId,
      arguments: {
        memoryId: id,
        versionId: input.versionId,
        reason: input.reason,
        idempotencyKey: request.headers.get("idempotency-key") ?? `withdraw:${id}:${input.versionId}`,
      },
    });
    try {
      if (withdrawal.tier === "long") await rebuildProfileAfterMemoryChange({
        userId,
        traceId,
        triggerKey: `withdraw:${id}:${input.versionId}`,
        latestMessage: "用户主动撤回了一条认识。",
      });
    } catch (error) {
      await recordTrace({ userId, traceId, stage: "profile.rebuild_deferred", payload: { message: "记忆已撤回，画像重建将在后续交流中完成。", code: error instanceof Error ? error.message : "rebuild_failed" } });
    }
    await addActivity({ userId, type: "memory.withdrawn", payload: withdrawal });
    return NextResponse.json({ withdrawn: true, ...withdrawal });
  } catch (error) {
    return jsonError(error, isMemoryConflict(error) ? 409 : 400);
  }
}

function isMemoryConflict(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message === "memory_version_conflict" || message === "memory_idempotency_conflict";
}
