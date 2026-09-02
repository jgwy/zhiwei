import {
  addMessage,
  createConversation,
  enqueueJob,
  getOnboardingQuestionPlan,
  getOnboardingAnswers,
  questionBank,
  recordTrace,
} from "@zhiwei/core";
import { NextResponse } from "next/server";
import { z } from "zod";
import { jsonError } from "@/lib/http";
import { getSessionUserId } from "@/lib/session";
import { getOrPlanOnboardingQuestion } from "@/lib/onboarding-planner";

const InputSchema = z.object({
  questionId: z.string(),
  answer: z.string().trim().min(1).max(2_000),
});

export async function POST(request: Request) {
  try {
    const userId = await getSessionUserId();
    const input = InputSchema.parse(await request.json());
    const modelQuestion = await getOnboardingQuestionPlan(userId, (await getOnboardingAnswers(userId)).length);
    const question = questionBank.find((item) => item.id === input.questionId)
      ?? (modelQuestion?.id === input.questionId ? modelQuestion : null);
    if (!question) return jsonError(new Error("问题不存在"), 400);
    const existing = await getOnboardingAnswers(userId);
    if (existing.some((answer) => answer.metadata?.questionId === question.id)) {
      return jsonError(new Error("这个问题已经回答过了"), 409);
    }
    const conversation = await createConversation(userId, "onboarding", "初次认识");
    const traceId = crypto.randomUUID();
    const message = await addMessage({
      conversationId: conversation.id,
      userId,
      role: "user",
      content: input.answer,
      metadata: {
        kind: "onboarding-answer",
        questionId: question.id,
        questionCategory: question.category,
      },
    });
    const jobId = await enqueueJob({
      userId,
      type: "reflection",
      idempotencyKey: `reflection:${message.id}:v1`,
      payload: {
        conversationId: conversation.id,
        messageId: message.id,
        content: input.answer,
        kind: "onboarding",
        questionId: question.id,
        questionCategory: question.category,
        traceId,
      },
    });
    await recordTrace({
      userId,
      traceId,
      stage: "onboarding.answer_received",
      payload: { question, answer: input.answer, jobId },
    });
    const answers = [...existing, { content: input.answer, metadata: { questionId: question.id } }];
    const nextQuestion = await getOrPlanOnboardingQuestion({ userId, answers });
    return NextResponse.json({
      accepted: true,
      jobId,
      answeredCount: answers.length,
      canFinish: answers.length >= 3,
      question: nextQuestion,
    });
  } catch (error) {
    return jsonError(error, 400);
  }
}
