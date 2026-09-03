import { addActivity, callMemoryMcp } from "@zhiwei/core";
import { NextResponse } from "next/server";
import { z } from "zod";
import { jsonError } from "@/lib/http";
import { getSessionUserId } from "@/lib/session";

const InputSchema = z.object({
  versionId: z.string().uuid(),
  reason: z.string().trim().max(300).optional(),
});

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const userId = await getSessionUserId();
    const { id: memoryId } = await context.params;
    const input = InputSchema.parse(await request.json());
    const traceId = crypto.randomUUID();
    const result = await callMemoryMcp({
      tool: "memory_reject",
      userId,
      traceId,
      arguments: {
        memoryId,
        versionId: input.versionId,
        reason: input.reason,
        idempotencyKey: request.headers.get("idempotency-key") ?? `reject:${memoryId}:${input.versionId}`,
      },
    });
    await addActivity({ userId, type: "memory.rejected", payload: result as Record<string, unknown> });
    return NextResponse.json(result);
  } catch (error) {
    return jsonError(error, isMemoryConflict(error) ? 409 : 400);
  }
}

function isMemoryConflict(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message === "memory_version_conflict" || message === "memory_idempotency_conflict";
}
