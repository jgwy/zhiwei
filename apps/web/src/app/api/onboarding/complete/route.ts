import { createConversation, setOnboardingComplete } from "@zhiwei/core";
import { NextResponse } from "next/server";
import { jsonError } from "@/lib/http";
import { getSessionUserId } from "@/lib/session";

export async function POST() {
  try {
    const userId = await getSessionUserId();
    await setOnboardingComplete(userId, true);
    const conversation = await createConversation(userId, "chat", "第一次聊天");
    return NextResponse.json({ complete: true, conversationId: conversation.id });
  } catch (error) {
    return jsonError(error);
  }
}

