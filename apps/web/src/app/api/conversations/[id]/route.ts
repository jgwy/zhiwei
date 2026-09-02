import { updateConversationTitle } from "@zhiwei/core";
import { NextResponse } from "next/server";
import { z } from "zod";
import { jsonError } from "@/lib/http";
import { getSessionUserId } from "@/lib/session";

const InputSchema = z.object({ title: z.string().trim().min(1).max(36) });

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const userId = await getSessionUserId();
    const { id } = await context.params;
    const input = InputSchema.parse(await request.json());
    await updateConversationTitle(userId, id, input.title, "manual");
    return NextResponse.json({ title: input.title, titleSource: "manual", titleLocked: true });
  } catch (error) {
    return jsonError(error, 400);
  }
}
