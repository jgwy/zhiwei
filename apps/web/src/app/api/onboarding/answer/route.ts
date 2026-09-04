import {
  createConversation,
  enqueueQuestionPlanning,
  getOnboardingAnswers,
  getPreparedQuestion,
  submitTurn,
} from "@zhiwei/core";
import { NextResponse } from "next/server";
import { z } from "zod";
import { jsonError } from "@/lib/http";
import { getSessionUserId } from "@/lib/session";

const InputSchema = z.object({
  questionId: z.string(),
  answer: z.string().trim().min(1).max(2_000),
});
export async function POST(request: Request) {
  try {
    const userId = await getSessionUserId();
    const input = InputSchema.parse(await request.json());
    const existing = await getOnboardingAnswers(userId);
    const question = await getPreparedQuestion(userId, existing.length);
    if (!question || question.id !== input.questionId)
      return jsonError(new Error("这道题已经更新，请刷新后继续。"), 409);
    const conversation = await createConversation(
      userId,
      "onboarding",
      "初次认识",
    );
    const turn = await submitTurn({
      userId,
      conversationId: conversation.id,
      content: input.answer,
      kind: "onboarding",
      question,
    });
    await enqueueQuestionPlanning(userId).catch(() => undefined);
    const answeredCount = existing.length + 1;
    const next = await getPreparedQuestion(userId, answeredCount);
    return NextResponse.json({
      accepted: true,
      jobId: turn.jobId,
      answeredCount,
      canFinish: answeredCount >= 3,
      question: next,
    });
  } catch (error) {
    return jsonError(error, 400);
  }
}
