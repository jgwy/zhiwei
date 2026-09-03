import {
  getOnboardingAnswers,
  getReturnNote,
  getUserState,
} from "@zhiwei/core";
import { getModelGateway } from "@zhiwei/model-gateway";
import { foundationSkills } from "@zhiwei/skills";
import { NextResponse } from "next/server";
import { isDeveloperMode, jsonError } from "@/lib/http";
import { getSessionUserId } from "@/lib/session";
import { getOrPlanOnboardingQuestion } from "@/lib/onboarding-planner";
import { getNoDbSettings, isNoDbMode, listNoDbConversations, listNoDbMemories } from "@/lib/no-db-store";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    if (isNoDbMode()) {
      const gateway = getModelGateway();
      return NextResponse.json({
        user: { id: "local-user", onboarding_complete: true, settings: getNoDbSettings() },
        conversations: listNoDbConversations(),
        profile: null,
        memories: listNoDbMemories(),
        mood: [],
        skill: null,
        onboarding: { complete: true, answeredCount: 0, canFinish: true, question: null },
        returnNote: null,
        developerModeAvailable: isDeveloperMode(),
        adapter: process.env.MODEL_PROVIDER ?? "scripted",
        modelModeLabel: "千问模式（无数据库）",
        modelCapabilities: gateway.capabilities,
        foundationSkills: isDeveloperMode()
          ? foundationSkills.map(({ content: _content, ...skill }) => skill)
          : undefined,
      });
    }
    const userId = await getSessionUserId();
    const [state, answers, returnNote] = await Promise.all([
      getUserState(userId),
      getOnboardingAnswers(userId),
      getReturnNote(userId),
    ]);
    const gateway = getModelGateway();
    let question = null;
    if (!state.user.onboarding_complete) {
      question = await getOrPlanOnboardingQuestion({ userId, answers, profileSummary: state.profile?.summary });
    }
    return NextResponse.json({
      ...state,
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
    console.error("bootstrap failed", error);
    return jsonError(error);
  }
}
