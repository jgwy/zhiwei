import { getCompetitionData } from "@zhiwei/core";
import { NextResponse } from "next/server";
import { getSessionUserId } from "@/lib/session";

export async function GET() {
  const data = await getCompetitionData(await getSessionUserId());
  return NextResponse.json({ withdrawals: data.withdrawals });
}
