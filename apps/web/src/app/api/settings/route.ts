import { createHash } from "node:crypto";
import { callMemoryMcp, enqueueJob, getUserSettings, recordTrace, updateSettings, type MemoryRecord } from "@zhiwei/core";
import { NextResponse } from "next/server";
import { z } from "zod";
import { jsonError } from "@/lib/http";
import { getSessionUserId } from "@/lib/session";

const SettingsSchema = z.object({
  memoryEnabled: z.boolean().optional(),
  shortTermMemoryEnabled: z.boolean().optional(),
  longTermMemoryEnabled: z.boolean().optional(),
  emotionTrackingEnabled: z.boolean().optional(),
  skillEvolutionEnabled: z.boolean().optional(),
  returnNotesEnabled: z.boolean().optional(),
});

export async function PATCH(request: Request) {
  try {
    const userId = await getSessionUserId();
    const settings = SettingsSchema.parse(await request.json());
    await updateSettings(userId, settings);
    const current = await getUserSettings(userId);
    let warning: string | null = null;
    const affectsLongProfile = settings.memoryEnabled === true
      || settings.longTermMemoryEnabled === true
      || settings.emotionTrackingEnabled !== undefined;
    if (affectsLongProfile && current.memoryEnabled !== false && current.longTermMemoryEnabled !== false) {
      try {
        const result = await callMemoryMcp<{ memories: MemoryRecord[] }>({
          tool: "memory_list",
          userId,
          arguments: { tiers: ["long"], statuses: ["active"], limit: 1_000 },
        });
        const signature = createHash("sha256").update(JSON.stringify({
          versionIds: result.memories.map((memory) => memory.versionId).sort(),
          emotionTrackingEnabled: current.emotionTrackingEnabled !== false,
          schemaVersion: "long-profile-v2",
        })).digest("hex").slice(0, 24);
        await enqueueJob({
          userId,
          type: "profile_synthesis",
          idempotencyKey: `profile_synthesis:settings:${signature}:long-profile-v2`,
          payload: { trigger: "settings-updated", sourceMessageId: null, conversationId: null },
        });
      } catch (error) {
        warning = "设置已保存，长期认识会稍后同步。";
        await recordTrace({
          userId,
          traceId: crypto.randomUUID(),
          stage: "settings.profile_refresh_deferred",
          payload: { code: error instanceof Error ? error.message : "profile_refresh_failed" },
        }).catch(() => undefined);
      }
    }
    return NextResponse.json({ settings: current, warning });
  } catch (error) {
    return jsonError(error, 400);
  }
}
