import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  calculateUnderstandingScore,
  compileContext,
  defaultPersonalSkill,
  rankMemories,
  type CompiledContext,
  type MemoryCategory,
  type MemoryRecord,
} from "@zhiwei/core";
import { ScriptedAdapter } from "@zhiwei/model-gateway";

const adapter = new ScriptedAdapter();
const cases: Array<{ input: string; expected: MemoryCategory[] }> = [
  { input: "我叫小满，以后叫我小满就好", expected: ["basic"] },
  { input: "我很喜欢看科幻小说。", expected: ["interest"] },
  { input: "我想在两个月内换一份工作。", expected: ["goal"] },
  { input: "最近工作压力很大，我很焦虑，不知道怎么办。", expected: ["emotion", "challenge"] },
  { input: "你别太说教，我更喜欢你先听我说。", expected: ["expression"] },
  { input: "其实我更希望你先听我说，不要马上给建议。", expected: ["expression"] },
  { input: "小时候那次转学一直影响我。", expected: ["experience"] },
  { input: "别再提我上次说的那个人。", expected: ["boundary"] },
  { input: "今天挺开心的，项目终于完成了。", expected: ["emotion"] },
  { input: "我目前正在纠结要不要辞职。", expected: ["challenge"] },
  { input: "普通的一句话，没有需要长期记住的事情。", expected: [] },
];

const context: CompiledContext = {
  foundationInstructions: "",
  personalSkill: defaultPersonalSkill,
  profileSummary: "",
  memories: [],
  sessionSummary: "",
  recentMessages: [],
  estimatedTokens: 0,
  truncated: false,
};

let truePositive = 0;
let falsePositive = 0;
let falseNegative = 0;
const outputs: string[] = [];

for (const fixture of cases) {
  const reflection = await adapter.reflect({
    userId: crypto.randomUUID(),
    conversationId: crypto.randomUUID(),
    messageId: crypto.randomUUID(),
    content: fixture.input,
    context,
    kind: "chat",
  });
  const actual = new Set(reflection.memories.map((memory) => memory.category));
  const expected = new Set(fixture.expected);
  for (const category of actual) {
    if (expected.has(category)) truePositive += 1;
    else falsePositive += 1;
  }
  for (const category of expected) {
    if (!actual.has(category)) falseNegative += 1;
  }
  let reply = "";
  for await (const chunk of adapter.streamDialogue({
    userId: crypto.randomUUID(),
    conversationId: crypto.randomUUID(),
    messageId: crypto.randomUUID(),
    content: fixture.input,
    context,
  })) reply += chunk;
  outputs.push(reply);
}

const precision = ratio(truePositive, truePositive + falsePositive);
const recall = ratio(truePositive, truePositive + falseNegative);
const beta = 0.5;
const f05 =
  precision + recall > 0
    ? ((1 + beta ** 2) * precision * recall) /
      (beta ** 2 * precision + recall)
    : 0;

const memories = makeRetrievalFixtures();
const retrievalCases = [
  ["工作选择", "m-goal"],
  ["我喜欢什么书", "m-interest"],
  ["回复别太长", "m-expression"],
] as const;
const recallAt8 =
  retrievalCases.filter(([query, expected]) =>
    rankMemories(memories, query, 8).some((memory) => memory.id === expected),
  ).length / retrievalCases.length;

const compiled = compileContext({
  foundationInstructions: "x".repeat(2_000),
  personalSkill: defaultPersonalSkill,
  profile: null,
  memories: makeRetrievalFixtures(30),
  sessionSummary: "s".repeat(2_000),
  messages: Array.from({ length: 40 }, (_, index) => ({
    id: crypto.randomUUID(),
    role: index % 2 ? "assistant" as const : "user" as const,
    content: `message-${index}-${"x".repeat(160)}`,
    createdAt: new Date().toISOString(),
  })),
  maxInputTokens: 3_000,
});

const openingCounts = new Map<string, number>();
for (const output of outputs) {
  const opening = output.slice(0, 12);
  openingCounts.set(opening, (openingCounts.get(opening) ?? 0) + 1);
}
const maxOpeningRepeat = Math.max(...openingCounts.values()) / outputs.length;
const averageReplyLength = outputs.reduce((sum, output) => sum + output.length, 0) / outputs.length;

const scoreChecks = {
  blank: calculateUnderstandingScore({ coverage: 0, validation: 1, personalization: 1, temporal: 1 }),
  mature: calculateUnderstandingScore({ coverage: 1, validation: 1, personalization: 1, temporal: 1 }),
  lowerAfterNegative: calculateUnderstandingScore({ coverage: 0.7, validation: 0.5, personalization: 0.2, temporal: 0.7 }),
};

const report = {
  generatedAt: new Date().toISOString(),
  adapter: adapter.id,
  diagnosticsOnly: true,
  metrics: {
    memoryPrecision: round(precision),
    memoryRecall: round(recall),
    memoryF05: round(f05),
    retrievalRecallAt8: round(recallAt8),
    contextOverflowCount: compiled.estimatedTokens > 3_000 ? 1 : 0,
    maxOpeningRepeatRate: round(maxOpeningRepeat),
    averageReplyLength: round(averageReplyLength),
    understandingScoreChecks: scoreChecks,
  },
  targets: {
    memoryF05: 0.9,
    retrievalRecallAt8: 0.9,
    contextOverflowCount: 0,
  },
  notes: [
    "此报告不阻止 Personal Skill 发布，也不触发自动回退。",
    "仿真模式只能验证 Harness 行为；真实模型的有人味最终由现场自由聊天判断。",
  ],
};

const outputDir = resolve(process.cwd(), "../../reports");
await mkdir(outputDir, { recursive: true });
await writeFile(join(outputDir, "eval-report.json"), `${JSON.stringify(report, null, 2)}\n`);
await writeFile(join(outputDir, "eval-report.html"), renderHtml(report));
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

function ratio(numerator: number, denominator: number) {
  return denominator ? numerator / denominator : 1;
}

function round(value: number) {
  return Math.round(value * 1_000) / 1_000;
}

function join(...parts: string[]) {
  return parts.join("/");
}

function makeRetrievalFixtures(count = 3): MemoryRecord[] {
  const base: MemoryRecord[] = [
    memory("m-goal", "goal", "当前希望找到更适合自己的工作方向"),
    memory("m-interest", "interest", "喜欢阅读科幻小说"),
    memory("m-expression", "expression", "希望回复短一些，不要太多标题"),
  ];
  return [
    ...base,
    ...Array.from({ length: Math.max(0, count - base.length) }, (_, index) =>
      memory(`distractor-${index}`, "basic", `无关干扰记忆 ${index}`),
    ),
  ];
}

function memory(id: string, category: MemoryCategory, content: string): MemoryRecord {
  return {
    id,
    versionId: crypto.randomUUID(),
    category,
    content,
    tier: "long",
    confidence: 0.9,
    validUntil: null,
    reason: "fixture",
    createdAt: new Date().toISOString(),
  };
}

function renderHtml(value: unknown) {
  const escaped = JSON.stringify(value, null, 2)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>知微离线评测</title><style>body{font:14px -apple-system,BlinkMacSystemFont,sans-serif;max-width:900px;margin:48px auto;padding:0 20px;color:#222}h1{font-size:28px}pre{background:#f6f6f6;border:1px solid #e8e8e8;border-radius:14px;padding:20px;overflow:auto;line-height:1.6}</style><h1>知微离线 Harness 评测</h1><p>该报告只用于诊断，不参与 Skill 发布。</p><pre>${escaped}</pre></html>`;
}
