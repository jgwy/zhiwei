import { getCompetitionData, getDeveloperData } from "@zhiwei/core";
import { foundationSkills } from "@zhiwei/skills";
import { NextResponse } from "next/server";
import { isDeveloperMode, jsonError } from "@/lib/http";
import { getSessionUserId } from "@/lib/session";
import { isNoDbMode, listNoDbConversations } from "@/lib/no-db-store";

export async function GET() {
  if (!isDeveloperMode()) return jsonError(new Error("developer_mode_disabled"), 404);
  if (isNoDbMode()) {
    return NextResponse.json({
      traces: [],
      memories: [],
      profiles: [],
      skills: [],
      mcpCalls: [],
      modelRuns: [],
      competition: { runs: [], risks: [], withdrawals: [], conversations: listNoDbConversations() },
      foundationSkills,
    });
  }
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
