import { addActivity, callMemoryMcp, enqueueJob } from "@zhiwei/core";
import { NextResponse } from "next/server";
import { z } from "zod";
import { isDeveloperMode, jsonError } from "@/lib/http";
import { getSessionUserId } from "@/lib/session";

const InputSchema = z.object({
  versionId: z.string().uuid(),
  expectedActiveVersionId: z.string().uuid().nullable(),
});

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    if (!isDeveloperMode()) return jsonError(new Error("developer_mode_disabled"), 404);
    const userId = await getSessionUserId();
    const { id: memoryId } = await context.params;
    const input = InputSchema.parse(await request.json());
    const traceId = crypto.randomUUID();
    const result = await callMemoryMcp<any>({
      tool: "memory_restore_version",
      userId,
      traceId,
      role: "developer",
      arguments: {
        memoryId,
        versionId: input.versionId,
        expectedActiveVersionId: input.expectedActiveVersionId,
        idempotencyKey: request.headers.get("idempotency-key") ?? `dev-restore:${memoryId}:${input.versionId}:${input.expectedActiveVersionId ?? "null"}`,
      },
    });
    if (result.memory?.tier === "long") {
      await enqueueJob({
        userId,
        type: "profile_synthesis",
        idempotencyKey: `profile_synthesis:developer-restore:${memoryId}:${result.memory.versionId}:long-profile-v2`,
        payload: { trigger: "developer-restore", sourceMessageId: null, conversationId: null, traceId },
      });
    }
    await addActivity({ userId, type: "memory.restored", payload: { memoryId, versionId: result.memory.versionId, restoredFromVersionId: input.versionId } });
    return NextResponse.json(result);
  } catch (error) {
    const conflict = error instanceof Error && /memory_(version|idempotency)_conflict/.test(error.message);
    return jsonError(error, conflict ? 409 : 400);
  }
}
