import { getMoodSeries } from "@zhiwei/core";
import { NextResponse } from "next/server";
import { getSessionUserId } from "@/lib/session";

export async function GET(request: Request) {
  const timeZone = new URL(request.url).searchParams.get("timeZone");
  return NextResponse.json({ mood: await getMoodSeries(await getSessionUserId(), timeZone) });
}
