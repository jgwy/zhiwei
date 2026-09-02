import { getCompetitionData } from "@zhiwei/core";
import { NextResponse } from "next/server";
import { isDeveloperMode, jsonError } from "@/lib/http";
import { getSessionUserId } from "@/lib/session";

export async function GET() {
  if (!isDeveloperMode()) return jsonError(new Error("developer_mode_disabled"), 404);
  return NextResponse.json(await getCompetitionData(await getSessionUserId()));
}
