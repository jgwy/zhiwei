import { getPreparedQuestion } from "@zhiwei/core";

export function getOrPlanOnboardingQuestion(input: {
  userId: string;
  answers: Array<{ content: string; metadata?: Record<string, any> }>;
  profileSummary?: string;
}) {
  return getPreparedQuestion(input.userId, input.answers.length);
}
