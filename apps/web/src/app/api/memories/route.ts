import { callMemoryMcp, type MemoryRecord } from "@zhiwei/core";
import { NextResponse } from "next/server";
import { jsonError } from "@/lib/http";
import { getSessionUserId } from "@/lib/session";

export async function GET() {
  try {
    const userId = await getSessionUserId();
    const result = await callMemoryMcp<{ memories: MemoryRecord[] }>({
      tool: "memory_list",
      userId,
      arguments: { statuses: ["active"], limit: 200 },
    });
    return NextResponse.json({ memories: result.memories });
  } catch (error) {
    return jsonError(error);
  }
}
