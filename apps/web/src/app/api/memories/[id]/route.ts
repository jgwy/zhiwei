import { callMemoryMcp, MemoryCategorySchema } from "@zhiwei/core";
import { NextResponse } from "next/server";
import { z } from "zod";
import { jsonError } from "@/lib/http";
import { getSessionUserId } from "@/lib/session";
import { isNoDbMode, updateNoDbMemory } from "@/lib/no-db-store";

const InputSchema = z.object({
  content: z.string().trim().min(1).max(600),
  category: MemoryCategorySchema.optional(),
  tier: z.enum(["short", "long"]).optional(),
  validUntil: z.string().datetime().nullable().optional(),
  reason: z.string().trim().max(500).optional(),
});

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const input = InputSchema.parse(await request.json());
    if (isNoDbMode()) return NextResponse.json({ memory: updateNoDbMemory({ memoryId: id, ...input }) });
    const userId = await getSessionUserId();
    const memory = await callMemoryMcp({
      tool: "memory_update",
      userId,
      arguments: { memoryId: id, ...input },
    });
    return NextResponse.json({ memory });
  } catch (error) {
    return jsonError(error, 400);
  }
}
