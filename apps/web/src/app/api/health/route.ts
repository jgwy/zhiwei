import { getPool } from "@zhiwei/core";
import { NextResponse } from "next/server";
import { isNoDbMode } from "@/lib/no-db-store";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    if (isNoDbMode()) return NextResponse.json({ ok: true, service: "zhiwei-web", mode: "no-db" });
    await getPool().query("SELECT 1");
    return NextResponse.json({ ok: true, service: "zhiwei-web" });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 503 },
    );
  }
}
