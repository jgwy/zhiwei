import { createHash } from "node:crypto";
import {
  getOnboardingAnswers,
  getReturnNote,
  getUserState,
  callMemoryMcp,
  enqueueJob,
  ensureUser,
  type MemoryRecord,
} from "@zhiwei/core";
import { getModelGateway } from "@zhiwei/model-gateway";
import { foundationSkills } from "@zhiwei/skills";
import { NextResponse } from "next/server";
import { isDeveloperMode, jsonError } from "@/lib/http";
import { getSessionUserId } from "@/lib/session";
import { getOrPlanOnboardingQuestion } from "@/lib/onboarding-planner";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const userId = await getSessionUserId();
    // Bootstrap is the single explicit provisioning boundary. Internal MCP calls
    // never recreate a user after full deletion.
    await ensureUser(userId);
    const [state, memoryResult, answers, returnNote] = await Promise.all([
      getUserState(userId),
      callMemoryMcp<{ memories: MemoryRecord[] }>({ tool: "memory_list", userId, arguments: { statuses: ["active"], limit: 200 } }),
      getOnboardingAnswers(userId),
      getReturnNote(userId),
    ]);
    const memoryEnabled = state.user.settings?.memoryEnabled !== false;
    const longTermEnabled = state.user.settings?.longTermMemoryEnabled !== false;
    const profileNeedsSync = !state.profile || state.profile.schemaVersion !== "long-profile-v2" || state.profile.syncStatus !== "current";
    if (state.user.onboarding_complete && memoryEnabled && longTermEnabled && profileNeedsSync) {
      const sourceSignature = createHash("sha256")
        .update(JSON.stringify({
          versionIds: memoryResult.memories
            .filter((memory) => memory.tier === "long")
            .map((memory) => memory.versionId)
            .sort(),
          emotionTrackingEnabled: state.user.settings?.emotionTrackingEnabled !== false,
        }))
        .digest("hex")
        .slice(0, 20);
      await enqueueJob({
        userId,
        type: "profile_synthesis",
        idempotencyKey: `profile_synthesis:sources:${sourceSignature}:long-profile-v2`,
        payload: { trigger: "legacy-bootstrap", sourceMessageId: null, conversationId: null, sourceSignature },
      }).catch(() => undefined);
    }
    const gateway = getModelGateway();
    let question = null;
    if (!state.user.onboarding_complete) {
      question = await getOrPlanOnboardingQuestion({ userId, answers, profileSummary: state.profile?.summary });
    }
    return NextResponse.json({
      ...state,
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
      modelModeLabel: (process.env.MODEL_PROVIDER ?? "scripted") === "scripted" ? "仿真模式" : "千问模式",
      modelCapabilities: gateway.capabilities,
      foundationSkills: isDeveloperMode()
        ? foundationSkills.map(({ content: _content, ...skill }) => skill)
        : undefined,
    });
  } catch (error) {
    return jsonError(error);
  }
}
