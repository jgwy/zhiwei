import { callMemoryMcp } from "@zhiwei/core";
import { NextResponse } from "next/server";
import { getSessionUserId } from "@/lib/session";

export async function GET() {
  const userId = await getSessionUserId();
  return NextResponse.json(await callMemoryMcp({ tool: "profile_get_current", userId, arguments: { forDisplay: true } }));
}
