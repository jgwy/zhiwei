import { finishOnboarding } from "@zhiwei/core";
import { NextResponse } from "next/server";
import { jsonError } from "@/lib/http";
import { getSessionUserId } from "@/lib/session";

export async function POST() {
  try {
    const userId = await getSessionUserId();
    const conversationId = await finishOnboarding(userId);
    return NextResponse.json({ complete: true, conversationId });
  } catch (error) {
    return jsonError(error);
  }
}
