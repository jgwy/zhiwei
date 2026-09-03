import { createConversation, enqueueJob, setOnboardingComplete } from "@zhiwei/core";
import { NextResponse } from "next/server";
import { jsonError } from "@/lib/http";
import { getSessionUserId } from "@/lib/session";

export async function POST() {
  try {
    const userId = await getSessionUserId();
    await setOnboardingComplete(userId, true);
    const conversation = await createConversation(userId, "chat", "第一次聊天");
    await enqueueJob({
      userId,
      type: "profile_synthesis",
      idempotencyKey: `profile_synthesis:onboarding:${userId}:long-profile-v2`,
      payload: { trigger: "onboarding-complete", sourceMessageId: null, conversationId: conversation.id },
    }).catch(() => undefined);
    return NextResponse.json({ complete: true, conversationId: conversation.id });
  } catch (error) {
    return jsonError(error);
  }
}
