import { createConversation, listConversations } from "@zhiwei/core";
import { NextResponse } from "next/server";
import { jsonError } from "@/lib/http";
import { getSessionUserId } from "@/lib/session";
import { createNoDbConversation, isNoDbMode, listNoDbConversations } from "@/lib/no-db-store";

export async function GET() {
  try {
    if (isNoDbMode()) return NextResponse.json({ conversations: listNoDbConversations() });
    return NextResponse.json({ conversations: await listConversations(await getSessionUserId()) });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST() {
  try {
    if (isNoDbMode()) return NextResponse.json({ conversation: createNoDbConversation() });
    const conversation = await createConversation(await getSessionUserId(), "chat", "新的对话");
    return NextResponse.json({ conversation });
  } catch (error) {
    return jsonError(error);
  }
}
