import {
  addActivity,
  callMemoryMcp,
  createTemporalContext,
  getUserTimeZone,
  normalizeDimensionWeights,
  recordModelCallMeta,
  recordTrace,
  type MemoryRecord,
  type ProfileSnapshot,
} from "@zhiwei/core";
import { getModelGateway } from "@zhiwei/model-gateway";
import { NextResponse } from "next/server";
import { z } from "zod";
import { jsonError } from "@/lib/http";
import { getSessionUserId } from "@/lib/session";

const InputSchema = z.object({ reason: z.string().max(300).optional() });

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const userId = await getSessionUserId();
    const { id } = await context.params;
    const input = InputSchema.parse(await request.json().catch(() => ({})));
    const traceId = crypto.randomUUID();
    const withdrawal = await callMemoryMcp<any>({ tool: "memory_withdraw", userId, traceId, arguments: { memoryId: id, reason: input.reason } });
    try {
      const [memoryResult, profileResult, timeZone] = await Promise.all([
        callMemoryMcp<{ memories: MemoryRecord[] }>({ tool: "memory_search", userId, traceId, arguments: { query: "当前活动画像与长期关注", limit: 20 } }),
        callMemoryMcp<{ profile: ProfileSnapshot | null }>({ tool: "profile_get_current", userId, traceId }),
        getUserTimeZone(userId),
      ]);
      const gateway = getModelGateway();
      const profile = await gateway.synthesizeProfile({
        memories: memoryResult.memories,
        currentSummary: profileResult.profile?.summary,
        latestMessage: "用户主动撤回了一条认识。",
        temporalContext: createTemporalContext(timeZone),
      });
      await callMemoryMcp({ tool: "profile_commit_snapshot", userId, traceId, arguments: { summary: profile.data.summary, dimensionWeights: normalizeDimensionWeights(profile.data.dimensionWeights) } });
      await recordModelCallMeta({ userId, traceId, adapterId: gateway.id, meta: profile.meta });
    } catch (error) {
      await recordTrace({ userId, traceId, stage: "profile.rebuild_deferred", payload: { message: "记忆已撤回，画像重建将在后续交流中完成。", code: error instanceof Error ? error.message : "rebuild_failed" } });
    }
    await addActivity({ userId, type: "memory.withdrawn", payload: withdrawal });
    return NextResponse.json({ withdrawn: true, ...withdrawal });
  } catch (error) {
    return jsonError(error, 400);
  }
}
