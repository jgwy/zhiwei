import { BenchmarkModeSchema, recordBenchmarkPreference } from "@zhiwei/core";
import { NextResponse } from "next/server";
import { z } from "zod";
import { isDeveloperMode, jsonError } from "@/lib/http";
import { getSessionUserId } from "@/lib/session";

const InputSchema = z.object({
  runId: z.string().uuid(),
  preferredMode: BenchmarkModeSchema,
  reason: z.string().max(500).optional(),
});

export async function POST(request: Request) {
  try {
    if (!isDeveloperMode()) return jsonError(new Error("developer_mode_disabled"), 404);
    const input = InputSchema.parse(await request.json());
    await recordBenchmarkPreference({ userId: await getSessionUserId(), ...input });
    return NextResponse.json({ recorded: true });
  } catch (error) {
    return jsonError(error, 400);
  }
}
