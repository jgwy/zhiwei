import {
  addActivity,
  callMemoryMcp,
  getUserSettings,
  normalizeDimensionWeights,
  recordModelCallMeta,
  recordTrace,
  type MemoryRecord,
  type ProfileSnapshot,
} from "@zhiwei/core";
import { getModelGateway } from "@zhiwei/model-gateway";

export async function rebuildProfileAfterMemoryChange(input: {
  userId: string;
  traceId: string;
  triggerKey: string;
  latestMessage: string;
}) {
  const settings = await getUserSettings(input.userId);
  if (settings.memoryEnabled === false || settings.longTermMemoryEnabled === false) return null;

  const [memoryResult, profileResult] = await Promise.all([
    callMemoryMcp<{ memories: MemoryRecord[] }>({
      tool: "memory_list",
      userId: input.userId,
      traceId: input.traceId,
      arguments: {},
    }),
    callMemoryMcp<{ profile: ProfileSnapshot | null }>({
      tool: "profile_get_current",
      userId: input.userId,
      traceId: input.traceId,
    }),
  ]);
  const activeLongMemories = memoryResult.memories.filter((memory) => (
    memory.status === "active"
    && memory.tier === "long"
    && memory.scope === "user"
  ));
  const gateway = getModelGateway();
  const synthesized = await gateway.synthesizeProfile({
    memories: activeLongMemories.map((memory) => memory.content),
    currentSummary: profileResult.profile?.summary,
    latestMessage: input.latestMessage,
  });
  const committed = await callMemoryMcp<{ profile: ProfileSnapshot }>({
    tool: "profile_commit_snapshot",
    userId: input.userId,
    traceId: input.traceId,
    arguments: {
      summary: synthesized.data.summary,
      dimensionWeights: normalizeDimensionWeights(synthesized.data.dimensionWeights),
      idempotencyKey: `profile:${input.triggerKey}`,
    },
  });
  await recordModelCallMeta({
    userId: input.userId,
    traceId: input.traceId,
    adapterId: gateway.id,
    meta: synthesized.meta,
  });
  await recordTrace({
    userId: input.userId,
    traceId: input.traceId,
    stage: "profile.rebuilt_after_memory_change",
    payload: {
      triggerKey: input.triggerKey,
      memoryVersionIds: activeLongMemories.map((memory) => memory.versionId),
      profileId: committed.profile.id,
      score: committed.profile.score,
    },
  });
  await addActivity({
    userId: input.userId,
    type: "profile.updated",
    payload: { profile: committed.profile, triggerKey: input.triggerKey },
  });
  return committed.profile;
}
