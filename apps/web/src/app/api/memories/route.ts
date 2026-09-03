import { callMemoryMcp } from "@zhiwei/core";
import { NextResponse } from "next/server";
import { getSessionUserId } from "@/lib/session";
import { isNoDbMode, listNoDbMemories } from "@/lib/no-db-store";

export async function GET() {
  if (isNoDbMode()) return NextResponse.json({ memories: listNoDbMemories() });
  const userId = await getSessionUserId();
  return NextResponse.json(await callMemoryMcp({ tool: "memory_list", userId, arguments: {} }));
}
