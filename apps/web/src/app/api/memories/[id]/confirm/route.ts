import { callMemoryMcp } from "@zhiwei/core";
import { NextResponse } from "next/server";
import { jsonError } from "@/lib/http";
import { getSessionUserId } from "@/lib/session";
import { isNoDbMode, confirmNoDbMemory } from "@/lib/no-db-store";

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    if (isNoDbMode()) return NextResponse.json({ memory: confirmNoDbMemory(id) });
    const userId = await getSessionUserId();
    const memory = await callMemoryMcp({ tool: "memory_confirm", userId, arguments: { memoryId: id } });
    return NextResponse.json({ memory });
  } catch (error) {
    return jsonError(error, 400);
  }
}
