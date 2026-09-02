import { updateSettings } from "@zhiwei/core";
import { NextResponse } from "next/server";
import { z } from "zod";
import { jsonError } from "@/lib/http";
import { getSessionUserId } from "@/lib/session";
import { isNoDbMode, updateNoDbSettings } from "@/lib/no-db-store";

const SettingsSchema = z.object({
  memoryEnabled: z.boolean().optional(),
  emotionTrackingEnabled: z.boolean().optional(),
  skillEvolutionEnabled: z.boolean().optional(),
  returnNotesEnabled: z.boolean().optional(),
});

export async function PATCH(request: Request) {
  try {
    const settings = SettingsSchema.parse(await request.json());
    if (isNoDbMode()) return NextResponse.json({ settings: updateNoDbSettings(settings) });
    const userId = await getSessionUserId();
    await updateSettings(userId, settings);
    return NextResponse.json({ settings });
  } catch (error) {
    return jsonError(error, 400);
  }
}
