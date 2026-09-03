import { NextResponse } from "next/server";
import { competitionReplayDataset } from "@/lib/competition-replays";
import { isDeveloperMode, jsonError } from "@/lib/http";

export async function GET() {
  if (!isDeveloperMode()) return jsonError(new Error("developer_mode_disabled"), 404);
  return NextResponse.json(competitionReplayDataset, {
    headers: {
      "Cache-Control": "public, max-age=3600, immutable",
    },
  });
}
