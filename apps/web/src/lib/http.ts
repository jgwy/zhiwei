import { NextResponse } from "next/server";

export function jsonError(error: unknown, status = 500) {
  return NextResponse.json(
    { error: error instanceof Error ? error.message : String(error) },
    { status },
  );
}

export function isDeveloperMode() {
  return process.env.DEV_MODE === "true";
}

