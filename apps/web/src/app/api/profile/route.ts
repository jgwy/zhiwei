import { getLatestProfile } from "@zhiwei/core";
import { NextResponse } from "next/server";
import { getSessionUserId } from "@/lib/session";

export async function GET() {
  return NextResponse.json({ profile: await getLatestProfile(await getSessionUserId()) });
}

