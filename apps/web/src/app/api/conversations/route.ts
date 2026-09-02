import { createConversation, listConversations } from "@zhiwei/core";
import { NextResponse } from "next/server";
import { jsonError } from "@/lib/http";
import { getSessionUserId } from "@/lib/session";

export async function GET() {
  try {
    return NextResponse.json({ conversations: await listConversations(await getSessionUserId()) });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST() {
  try {
    const conversation = await createConversation(await getSessionUserId(), "chat", "新的对话");
    return NextResponse.json({ conversation });
  } catch (error) {
    return jsonError(error);
  }
}

