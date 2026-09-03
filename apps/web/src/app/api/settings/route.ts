import { isValidTimeZone, updateSettings, updateTimeZone } from "@zhiwei/core";
import { NextResponse } from "next/server";
import { z } from "zod";
import { jsonError } from "@/lib/http";
import { getSessionUserId } from "@/lib/session";

const SettingsSchema = z.object({
  memoryEnabled: z.boolean().optional(),
  emotionTrackingEnabled: z.boolean().optional(),
  skillEvolutionEnabled: z.boolean().optional(),
  returnNotesEnabled: z.boolean().optional(),
  timeZone: z.string().trim().min(1).max(100).refine(isValidTimeZone, "无效的 IANA 时区").optional(),
});

export async function PATCH(request: Request) {
  try {
    const userId = await getSessionUserId();
    const input = SettingsSchema.parse(await request.json());
    const { timeZone, ...settings } = input;
    await Promise.all([
      Object.keys(settings).length ? updateSettings(userId, settings) : Promise.resolve(),
      timeZone ? updateTimeZone(userId, timeZone) : Promise.resolve(),
    ]);
    return NextResponse.json({ settings, timeZone });
  } catch (error) {
    return jsonError(error, 400);
  }
}

