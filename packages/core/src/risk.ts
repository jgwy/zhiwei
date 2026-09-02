import type { RiskAssessment } from "./types";

const immediatePatterns = [
  /我(?:现在|马上|已经|准备|打算).{0,12}(?:自杀|跳楼|吞药|割腕|伤害自己|结束生命)/,
  /(?:药已经吃了|已经割了|站在楼顶|正在准备遗书)/,
];

const ambiguousPatterns = [
  /(?:不想活|活不下去|想死|结束这一切|伤害自己|消失算了)/,
  /(?:活着没意思|不如死了)/,
];

const contextualExclusions = [
  /(?:小说|电影|课程|新闻|报道|论文|台词|角色|朋友|同学|他说|她说).{0,18}(?:自杀|想死|不想活)/,
  /(?:我没有|我不会|我不打算|并不是真的|不是说我).{0,12}(?:自杀|想死|伤害自己)/,
];

export function assessRisk(text: string): RiskAssessment {
  const normalized = text.replace(/\s+/g, "");
  if (contextualExclusions.some((pattern) => pattern.test(normalized))) {
    return {
      level: "ordinary",
      evidence: [],
      reason: "高风险词出现在否定、引用或创作语境中。",
      responsePath: "normal-dialogue",
    };
  }
  const immediate = immediatePatterns.find((pattern) => pattern.test(normalized));
  if (immediate) {
    return {
      level: "immediate",
      evidence: [immediate.source],
      reason: "检测到当前或已经发生的人身危险表达。",
      responsePath: "urgent-real-world-support",
    };
  }
  const ambiguous = ambiguousPatterns.find((pattern) => pattern.test(normalized));
  if (ambiguous) {
    return {
      level: "ambiguous",
      evidence: [ambiguous.source],
      reason: "检测到需要澄清是否存在眼前危险的表达。",
      responsePath: "clarify-current-danger",
    };
  }
  return {
    level: "ordinary",
    evidence: [],
    reason: "未检测到需要进入风险分级流程的明确信号。",
    responsePath: "normal-dialogue",
  };
}
