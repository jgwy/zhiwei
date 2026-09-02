import { callMemoryMcp } from "@zhiwei/core";
import { NextResponse } from "next/server";
import { getSessionUserId } from "@/lib/session";

export async function GET() {
  const userId = await getSessionUserId();
  return NextResponse.json(await callMemoryMcp({ tool: "memory_search", userId, arguments: { query: "当前活动认识", limit: 20 } }));
}
