import {
  getOnboardingAnswers,
  getReturnNote,
  getUserState,
  pickNextQuestion,
} from "@zhiwei/core";
import { foundationSkills } from "@zhiwei/skills";
import { NextResponse } from "next/server";
import { isDeveloperMode, jsonError } from "@/lib/http";
import { getSessionUserId } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const userId = await getSessionUserId();
    const [state, answers, returnNote] = await Promise.all([
      getUserState(userId),
      getOnboardingAnswers(userId),
      getReturnNote(userId),
    ]);
    const answeredQuestionIds = answers
      .map((answer) => answer.metadata?.questionId)
      .filter(Boolean) as string[];
    const question = pickNextQuestion({
      answeredQuestionIds,
      lastAnswer: answers.at(-1)?.content,
      seed: userId,
    });
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
      foundationSkills: isDeveloperMode()
        ? foundationSkills.map(({ content: _content, ...skill }) => skill)
        : undefined,
    });
  } catch (error) {
    return jsonError(error);
  }
}

