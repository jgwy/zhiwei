import { getCompetitionData, getDeveloperData } from "@zhiwei/core";
import { foundationSkills } from "@zhiwei/skills";
import { NextResponse } from "next/server";
import { isDeveloperMode, jsonError } from "@/lib/http";
import { getSessionUserId } from "@/lib/session";
import { withCompetitionReplays } from "@/lib/competition-replays";

export async function GET(request: Request) {
  if (!isDeveloperMode())
    return jsonError(new Error("developer_mode_disabled"), 404);
  const userId = await getSessionUserId();
  const section = new URL(request.url).searchParams.get("section") ?? "trace";
  const developerData = ["trace", "memory", "skills"].includes(section)
    ? await getDeveloperData(userId, section as "trace" | "memory" | "skills")
    : {};
  const competition =
    section === "competition"
      ? withCompetitionReplays(await getCompetitionData(userId))
      : { runs: [], risks: [], withdrawals: [], conversations: [] };
  return NextResponse.json({
    ...developerData,
    competition,
    foundationSkills: section === "skills" ? foundationSkills : [],
  });
}
