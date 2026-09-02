import { getCompetitionData, getDeveloperData } from "@zhiwei/core";
import { foundationSkills } from "@zhiwei/skills";
import { NextResponse } from "next/server";
import { isDeveloperMode, jsonError } from "@/lib/http";
import { getSessionUserId } from "@/lib/session";

export async function GET() {
  if (!isDeveloperMode()) return jsonError(new Error("developer_mode_disabled"), 404);
  const userId = await getSessionUserId();
  const [developerData, competition] = await Promise.all([
    getDeveloperData(userId),
    getCompetitionData(userId),
  ]);
  return NextResponse.json({
    ...developerData,
    competition,
    foundationSkills,
  });
}
