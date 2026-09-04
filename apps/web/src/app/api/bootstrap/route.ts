import { createHash } from "node:crypto";
import {
  getOnboardingAnswers,
  getReturnNote,
  getUserState,
  callMemoryMcp,
  enqueueJob,
  ensureUser,
  getMessagePage,
  type MemoryRecord,
} from "@zhiwei/core";
import { getModelGateway } from "@zhiwei/model-gateway";
import { foundationSkills } from "@zhiwei/skills";
import { NextResponse } from "next/server";
import { isDeveloperMode, jsonError } from "@/lib/http";
import { getSessionUserId } from "@/lib/session";
import { getOrPlanOnboardingQuestion } from "@/lib/onboarding-planner";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const searchParams = new URL(request.url).searchParams;
    const userId = await getSessionUserId();
    // Bootstrap is the single explicit provisioning boundary. Internal MCP calls
    // never recreate a user after full deletion.
    await ensureUser(userId);
    const [
      state,
      memoryResult,
      profileResult,
      skillResult,
      answers,
      returnNote,
    ] = await Promise.all([
      getUserState(userId, searchParams.get("timeZone")),
      callMemoryMcp<{ memories: MemoryRecord[] }>({
        tool: "memory_list",
        userId,
        arguments: { statuses: ["active"], limit: 200 },
      }),
      callMemoryMcp<any>({
        tool: "profile_get_current",
        userId,
        arguments: { forDisplay: true },
      }),
      callMemoryMcp<any>({ tool: "personal_skill_get_active", userId }),
      getOnboardingAnswers(userId),
      getReturnNote(userId),
    ]);
    const memoryEnabled = state.user.settings?.memoryEnabled !== false;
    const longTermEnabled =
      state.user.settings?.longTermMemoryEnabled !== false;
    const profile = profileResult.profile;
    const profileNeedsSync =
      !profile ||
      profile.schemaVersion !== "long-profile-v2" ||
      profile.syncStatus !== "current";
    if (
      state.user.onboarding_complete &&
      memoryEnabled &&
      longTermEnabled &&
      profileNeedsSync &&
      memoryResult.memories.some((memory) => memory.tier === "long")
    ) {
      const sourceSignature = createHash("sha256")
        .update(
          JSON.stringify({
            versionIds: memoryResult.memories
              .filter((memory) => memory.tier === "long")
              .map((memory) => memory.versionId)
              .sort(),
            emotionTrackingEnabled:
              state.user.settings?.emotionTrackingEnabled !== false,
          }),
        )
        .digest("hex")
        .slice(0, 20);
      await enqueueJob({
        userId,
        type: "profile_synthesis",
        idempotencyKey: `profile_synthesis:sources:${sourceSignature}:long-profile-v2`,
        payload: {
          trigger: "legacy-bootstrap",
          sourceMessageId: null,
          conversationId: null,
          sourceSignature,
        },
      }).catch(() => undefined);
    }
    const gateway = getModelGateway();
    let question = null;
    if (!state.user.onboarding_complete) {
      question = await getOrPlanOnboardingQuestion({ userId, answers });
    }
    const requestedId = searchParams.get("conversationId");
    const activeConversationId =
      state.conversations.find((c) => c.id === requestedId)?.id ??
      state.conversations[0]?.id ??
      null;
    const messagePage = activeConversationId
      ? await getMessagePage(userId, activeConversationId)
      : { messages: [], hasMore: false, nextCursor: null };
    return NextResponse.json({
      ...state,
      profile,
      skill: skillResult.skill,
      activeConversationId,
      messagePage,
      memories: memoryResult.memories,
      onboarding: {
        complete: state.user.onboarding_complete,
        answeredCount: answers.length,
        canFinish: answers.length >= 3,
        question,
      },
      returnNote,
      developerModeAvailable: isDeveloperMode(),
      adapter: process.env.MODEL_PROVIDER ?? "scripted",
      modelModeLabel:
        (process.env.MODEL_PROVIDER ?? "scripted") === "scripted"
          ? "仿真模式"
          : "千问服务正常",
      modelCapabilities: gateway.capabilities,
      foundationSkills: isDeveloperMode()
        ? foundationSkills.map(({ content: _content, ...skill }) => skill)
        : undefined,
    });
  } catch (error) {
    return jsonError(error);
  }
}
