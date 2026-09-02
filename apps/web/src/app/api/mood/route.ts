import { getMoodSeries } from "@zhiwei/core";
import { NextResponse } from "next/server";
import { getSessionUserId } from "@/lib/session";

export async function GET() {
  return NextResponse.json({ mood: await getMoodSeries(await getSessionUserId()) });
}

