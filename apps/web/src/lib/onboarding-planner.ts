import {
  getOnboardingQuestionPlan,
  pickNextQuestion,
  recordModelCallMeta,
  recordTrace,
  saveOnboardingQuestionPlan,
  type QuestionDefinition,
} from "@zhiwei/core";
import { getModelGateway } from "@zhiwei/model-gateway";

export async function getOrPlanOnboardingQuestion(input: {
  userId: string;
  answers: Array<{ content: string; metadata?: Record<string, any> }>;
  profileSummary?: string;
}): Promise<QuestionDefinition | null> {
  const step = input.answers.length;
  const cached = await getOnboardingQuestionPlan(input.userId, step);
  if (cached) return cached as QuestionDefinition;
  const provider = process.env.MODEL_PROVIDER ?? "scripted";
  if (provider === "scripted") {
    return pickNextQuestion({
      answeredQuestionIds: input.answers.map((answer) => answer.metadata?.questionId).filter(Boolean),
      lastAnswer: input.answers.at(-1)?.content,
      seed: input.userId,
    });
  }
  const gateway = getModelGateway();
  const traceId = crypto.randomUUID();
  let planned;
  try {
    planned = await gateway.planQuestions({
      answered: input.answers.map((answer) => ({ questionId: answer.metadata?.questionId, content: answer.content })),
      profileSummary: input.profileSummary,
    });
  } catch (error) {
    await recordTrace({
      userId: input.userId,
      traceId,
      stage: "onboarding.question_plan_failed",
      payload: { code: error instanceof Error ? error.message : "question_plan_failed", step },
    }).catch(() => undefined);
    return pickNextQuestion({
      answeredQuestionIds: input.answers.map((answer) => answer.metadata?.questionId).filter(Boolean),
      lastAnswer: input.answers.at(-1)?.content,
      seed: input.userId,
    });
  }
  const exploreAdjacent = stableBucket(`${input.userId}:${step}`) < 2;
  const candidates = exploreAdjacent ? planned.data.adjacentCandidates : planned.data.gapCandidates;
  const selected = candidates[stableBucket(`${step}:${input.userId}`) % candidates.length]!;
  const normalizedOptions = [...new Set(selected.options.filter((option) => option !== "其他"))].slice(0, 4);
  const question: QuestionDefinition = {
    id: `model-${step}-${selected.category}`,
    category: selected.category,
    text: /[？?]$/u.test(selected.text) ? selected.text : `${selected.text}？`,
    options: normalizedOptions.length >= 2 ? normalizedOptions : selected.options.slice(0, 2),
    priority: exploreAdjacent ? 20 : 80,
  };
  await saveOnboardingQuestionPlan({ userId: input.userId, step, question, modelName: planned.meta.model });
  await recordModelCallMeta({ userId: input.userId, traceId, adapterId: gateway.id, meta: planned.meta });
  await recordTrace({ userId: input.userId, traceId, stage: "onboarding.question_planned", payload: { step, exploreAdjacent, selected, meta: planned.meta } });
  return question;
}

function stableBucket(value: string) {
  return [...value].reduce((sum, character) => sum + character.codePointAt(0)!, 0) % 10;
}
