import { updateConversationTitle } from "@zhiwei/core";
import { NextResponse } from "next/server";
import { z } from "zod";
import { jsonError } from "@/lib/http";
import { getSessionUserId } from "@/lib/session";
import { isNoDbMode, updateNoDbConversationTitle } from "@/lib/no-db-store";

const InputSchema = z.object({ title: z.string().trim().min(1).max(36) });

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const input = InputSchema.parse(await request.json());
    if (isNoDbMode()) {
      updateNoDbConversationTitle(id, input.title);
      return NextResponse.json({ title: input.title, titleSource: "manual", titleLocked: true });
    }
    const userId = await getSessionUserId();
    await updateConversationTitle(userId, id, input.title, "manual");
    return NextResponse.json({ title: input.title, titleSource: "manual", titleLocked: true });
  } catch (error) {
    return jsonError(error, 400);
  }
}
