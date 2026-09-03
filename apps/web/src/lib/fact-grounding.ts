import type { ChatMessage, FactBriefOutput } from "@zhiwei/core/client";

export type FactSource = { title: string; url: string; siteName?: string };

const verificationFollowUpPattern = /^(?:真(?:的)?吗|确定吗|你确定吗|靠谱吗|准确吗|有(?:可靠)?来源吗|来源呢|证据呢|你(?:刚才)?查(?:过|了)吗|核实(?:过|了)吗|能确认吗)[？?。！!\s]*$/u;
const personQuestionPattern = /(?:谁是[^？?]{1,40}|[^？?，,。！!]{2,40}(?:是谁|是什么人|什么来头|的(?:身份|职称|职位|院系|研究方向|履历|简历|导师|教授)))[？?。！!]*$/u;
const externallyVerifiablePattern = /(?:职称|职位|任职|院系|学校|单位|教授|导师|研究方向|履历|简历|毕业于|就职于|现任|官网|报道|论文|价格|新闻|政策|法规|版本|发布日期|天气|汇率).{0,12}[？?]/u;
const generalKnowledgePattern = /(?:是什么|什么意思|指什么|哪一年|何时|在哪里|位于哪里|有多少|原理|机制|历史|区别|资料|介绍一下|是否存在)[^。！!]{0,40}[？?。]*$/u;
const broaderKnowledgePattern = /(?:告诉我|讲讲|查一下|查查|最新|当前|目前|背景|发展|定义|含义|解释一下).{0,120}(?:[？?。！!]|$)/u;

export function isVerificationFollowUp(content: string) {
  return verificationFollowUpPattern.test(content.trim());
}

export function requiresVerifiedFacts(content: string, messages: ChatMessage[]) {
  const text = content.trim();
  if (/^(?:你|我)是谁[？?。]*$/u.test(text)) return false;
  if (isVerificationFollowUp(text) || personQuestionPattern.test(text) || externallyVerifiablePattern.test(text) || generalKnowledgePattern.test(text) || broaderKnowledgePattern.test(text)) return true;

  // A short name/affiliation clarification after “X 是谁” is still part of the
  // same identity lookup, even when the clarification itself has no question mark.
  const priorUserMessage = [...messages]
    .reverse()
    .find((message) => message.role === "user" && message.content.trim() !== text);
  return Boolean(
    priorUserMessage
      && personQuestionPattern.test(priorUserMessage.content.trim())
      && text.length <= 80
      && /(?:大学|学院|研究所|医院|公司|教授|老师|医生|院士|博士|主任|经理|创始人)/u.test(text),
  );
}

export function buildVerificationRequest(content: string, messages: ChatMessage[]) {
  if (!isVerificationFollowUp(content)) return content;
  const history = messages.filter((message) => message.content.trim() !== content.trim());
  const previousAssistant = [...history].reverse().find((message) => message.role === "assistant");
  const previousUser = previousAssistant
    ? [...history.slice(0, history.indexOf(previousAssistant))].reverse().find((message) => message.role === "user")
    : [...history].reverse().find((message) => message.role === "user");
  return [
    "用户要求重新核验上一轮回答，不得沿用上一轮未经来源支持的结论。",
    previousUser ? `上一问题：${previousUser.content}` : "",
    previousAssistant ? `待核验回答：${previousAssistant.content}` : "",
    `当前追问：${content}`,
  ].filter(Boolean).join("\n").slice(0, 2_000);
}

export function keepOnlyGroundedFacts(brief: FactBriefOutput, sources: FactSource[]) {
  const validSources = new Map<number, FactSource>();
  sources.forEach((source, index) => {
    if (isUsableSource(source)) validSources.set(index + 1, source);
  });

  const claimsWithOriginalIndices = brief.claims
    .filter((claim) => claim.status === "supported")
    .map((claim) => ({
      ...claim,
      sourceIndices: [...new Set(claim.sourceIndices.filter((index) => validSources.has(index)))],
    }))
    .filter((claim) => claim.sourceIndices.length > 0);
  if (!claimsWithOriginalIndices.length) return null;

  const usedOriginalIndices = [...new Set(claimsWithOriginalIndices.flatMap((claim) => claim.sourceIndices))];
  const remappedIndices = new Map(usedOriginalIndices.map((index, position) => [index, position + 1]));
  const groundedBrief: FactBriefOutput = {
    claims: claimsWithOriginalIndices.map((claim) => ({
      ...claim,
      sourceIndices: claim.sourceIndices.map((index) => remappedIndices.get(index)!),
    })),
    // Never pass through a model-authored summary: it may contain claims that
    // were not accepted above.
    summary: claimsWithOriginalIndices.map((claim) => claim.text).join("；").slice(0, 1_600),
  };
  return {
    brief: groundedBrief,
    sources: usedOriginalIndices.map((index) => validSources.get(index)!),
  };
}

export function verificationUnavailableReply(content: string) {
  if (personQuestionPattern.test(content.trim())) {
    return "我目前没能从可靠来源核实到这个人的身份，因此不能确认其院系、职称或研究方向。你如果提供学校官网或个人主页链接，我可以只依据该来源继续核对。";
  }
  return "我目前没能从可靠来源核实到这项信息，所以不能把它当作事实确认。你如果提供官方页面或可信来源，我可以只依据该来源继续核对。";
}

export function renderGroundedFactReply(brief: FactBriefOutput, sources: FactSource[]) {
  const lines = brief.claims.map((claim) => {
    const sourceNames = claim.sourceIndices
      .map((index) => sources[index - 1]?.title)
      .filter((title): title is string => Boolean(title));
    return `- ${claim.text}（来源：${sourceNames.join("、")}）`;
  });
  return `根据可用来源，目前能确认：\n${lines.join("\n")}`;
}

function isUsableSource(source: FactSource) {
  if (!source.title.trim()) return false;
  try {
    const url = new URL(source.url);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}
