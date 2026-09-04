import {
  estimateContextTokens,
  fitContextBudget,
  type CompiledContext,
  type FactBriefOutput,
  type ModelCallMeta,
} from "@zhiwei/core";
import type { DialogueInput } from "./index";

export type DialogueMessage = { role: "system" | "user" | "assistant"; content: string };
export type FactVerification = "not-requested" | "available" | "unavailable";
export type ModelRequestSnapshot = {
  task: "dialogue";
  model: string;
  transport: ModelCallMeta["transport"];
  attempt: number;
  messages: DialogueMessage[];
  memoryVersionIds: string[];
  skillVersions: Array<{ name: string; version: string }>;
  estimatedTokens: number;
  contextBudget: number;
  truncated: boolean;
};

export function prepareDialogueRequest(input: DialogueInput & {
  factBrief?: FactBriefOutput | null;
  factVerification?: FactVerification;
}, options: {
  instructions: string[];
  retryHint?: string;
  maxInputTokens: number;
}): { messages: DialogueMessage[]; memoryVersionIds: string[]; estimatedTokens: number; truncated: boolean } {
  const render = (context: CompiledContext): DialogueMessage[] => {
    const messages: DialogueMessage[] = [
      { role: "system", content: buildDialogueSystem(context, input.factBrief, input.factVerification, options.instructions, options.retryHint) },
      ...context.recentMessages.slice(-12).map(({ role, content }) => ({ role, content })),
    ];
    const last = messages.at(-1);
    if (last?.role !== "user" || last.content !== input.content) {
      messages.push({ role: "user", content: input.content });
    }
    return messages;
  };
  const context = fitContextBudget(input.context, options.maxInputTokens, (value) => estimateContextTokens(render(value)));
  return {
    messages: render(context),
    memoryVersionIds: context.memories.map((memory) => memory.versionId),
    estimatedTokens: context.estimatedTokens,
    truncated: context.truncated,
  };
}

function buildDialogueSystem(
  context: CompiledContext,
  factBrief: FactBriefOutput | null | undefined,
  verification: FactVerification = factBrief ? "available" : "not-requested",
  instructions: string[],
  retryHint?: string,
): string {
  const factInstruction = verification === "available"
    ? "事实核验结果如下。只有 status=supported 且 sourceIndices 非空的主张可表述为已核实；其余主张保留原有不确定性。来源编号用于对应证据，不代表来源本身证明了所有说法。"
    : verification === "unavailable"
      ? "本轮外部事实核验未能完成。可以明确区分并补充未实时核实的通用原理或非时效常识，但人物具体履历、作品发行时间、最新信息及高影响结论不作猜测。不要把记忆中的知识或上一轮回答说成这次已查到的资料。"
      : "本轮没有进行外部事实核验。先回应用户实际需要；纯情绪陪伴不必额外介绍人物经历、作品背景等具体外部事实。";
  return [
    `个人相处方式（这是长期偏好，不是本轮任务；当前明确请求优先）：${JSON.stringify(context.personalSkill)}`,
    `人物综述：${context.profileSummary || "暂无"}`,
    `相关认识：${JSON.stringify(context.memories)}`,
    `会话摘要：${context.sessionSummary || "暂无"}`,
    factBrief ? `已通过核验且可引用的主张：${JSON.stringify(factBrief.claims.filter((claim) => claim.status === "supported" && claim.sourceIndices.length > 0))}` : "",
    factBrief?.claims.some((claim) => claim.status !== "supported" || claim.sourceIndices.length === 0)
      ? "其余主张尚未通过核验，未作为事实传入。需要这些具体信息时说明缺口，不从上一轮回答补回它们。" : "",
    context.foundationInstructions,
    factInstruction,
    ...instructions,
    retryHint,
  ].filter(Boolean).join("\n\n");
}

export function requestSnapshot(input: Omit<ModelRequestSnapshot, "skillVersions">): ModelRequestSnapshot {
  const secrets = [process.env.MODEL_API_KEY, process.env.INTERNAL_MCP_TOKEN, process.env.ANON_COOKIE_SECRET]
    .filter((value): value is string => Boolean(value));
  const redact = (text: string) => {
    for (const secret of secrets) text = text.replaceAll(secret, "[已隐藏密钥]");
    return text
      .replace(/\bBearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [已隐藏密钥]")
      .replace(/\bsk-[A-Za-z0-9._~-]{12,}/g, "[已隐藏密钥]");
  };
  return {
    ...input,
    messages: input.messages.map((message) => ({ ...message, content: redact(message.content) })),
    skillVersions: [...input.messages[0]!.content.matchAll(/<skill name="([^"]+)" version="([^"]+)">/g)]
      .map((match) => ({ name: match[1]!, version: match[2]! })),
  };
}
