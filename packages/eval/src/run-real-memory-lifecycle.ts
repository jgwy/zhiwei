import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  defaultPersonalSkill,
  normalizeMemoryValidity,
  type ChatMessage,
  type CompiledContext,
  type MemoryCategory,
  type MemoryMutation,
  type MemoryRecord,
  type ModelCallMeta,
  type PersonalSkill,
} from "@zhiwei/core";
import { AliyunBailianGateway, type DialogueResponsePlan } from "@zhiwei/model-gateway";

if (process.env.ALLOW_PAID_MODEL_TESTS !== "true") {
  throw new Error("真实模型回放默认关闭；请显式设置 ALLOW_PAID_MODEL_TESTS=true。");
}

const budgetCny = Math.min(5, Number(process.env.REAL_TEST_BUDGET_CNY ?? 5));
if (!Number.isFinite(budgetCny) || budgetCny <= 0) throw new Error("REAL_TEST_BUDGET_CNY 必须是 0 至 5 之间的正数。");

type TurnSpec = {
  user: string;
  kind?: "chat" | "onboarding";
  questionCategory?: MemoryCategory;
  conversation?: string;
  emotionEnabled?: boolean;
};

type ScenarioSpec = {
  id: string;
  scenario: string;
  focus: string[];
  turns: TurnSpec[];
};

const scenarios: ScenarioSpec[] = [
  {
    id: "qwen-real-01-onboarding",
    scenario: "初识三题形成低密度长期认识",
    focus: ["onboarding", "create", "long", "profile"],
    turns: [
      { kind: "onboarding", questionCategory: "basic", user: "我叫小满，现在是大四学生。" },
      { kind: "onboarding", questionCategory: "goal", user: "这学期最想稳稳完成毕业设计，同时决定要不要读研。" },
      { kind: "onboarding", questionCategory: "expression", user: "我难受的时候希望你先听懂我，别急着给一串建议。" },
    ],
  },
  {
    id: "qwen-real-02-short-expiry",
    scenario: "近期任务与有效期",
    focus: ["short", "validUntil", "zero-or-two-actions"],
    turns: [
      { user: "这周五之前我都在赶课程项目，回复时先别给我增加额外任务。" },
      { user: "今天只想把实验报告的结论写完，其他事情先放一放。" },
      { user: "等周五交完以后，我再重新安排下周的节奏。" },
    ],
  },
  {
    id: "qwen-real-03-cross-conversation",
    scenario: "近期认识跨会话参与回答",
    focus: ["short", "cross-conversation", "retrieval-context"],
    turns: [
      { conversation: "A", user: "我下周第一次做组会汇报，最担心老师突然追问。" },
      { conversation: "B", user: "我想练一下怎么回答老师的问题。" },
      { conversation: "B", user: "比起背答案，我更想先练习承认自己暂时不知道。" },
    ],
  },
  {
    id: "qwen-real-04-supersede",
    scenario: "明确纠正直接替代旧认识",
    focus: ["supersede", "cas", "correction"],
    turns: [
      { user: "我通常喜欢一个人先想清楚，再跟别人讨论。" },
      { user: "其实你刚才理解得不准确：遇到重要选择时，我更希望先找人聊，再自己消化。" },
      { user: "对，这不是偶尔一次，而是我现在更稳定的做法。" },
    ],
  },
  {
    id: "qwen-real-05-ambiguous-conflict",
    scenario: "例外情境不被草率写成长期变化",
    focus: ["conflict", "clarification", "no-write"],
    turns: [
      { user: "我做决定时一般喜欢先搜集足够信息。" },
      { user: "但今天这件事我只想凭直觉赶快定下来。" },
      { user: "这只是因为截止时间就在今晚，不代表我以后都想这么做。" },
    ],
  },
  {
    id: "qwen-real-06-withdraw-relearn",
    scenario: "聊天撤回后允许新证据重新学习",
    focus: ["withdraw", "stale-barrier", "relearn"],
    turns: [
      { user: "最近我在考虑去上海找工作。" },
      { user: "忘掉我刚才说的上海求职吧，之后也别再主动提。" },
      { user: "现在请重新记住：我又开始认真考虑去上海工作了。" },
      { user: "这次是因为拿到了一家公司的面试邀请。" },
    ],
  },
  {
    id: "qwen-real-07-emotion-authorization",
    scenario: "关闭情绪授权时过滤情绪写入",
    focus: ["emotion", "authorization", "deterministic-filter"],
    turns: [
      { emotionEnabled: false, user: "今天收到批评以后有点低落，但我不希望记录情绪趋势。" },
      { emotionEnabled: false, user: "我只想在这次对话里说说这种委屈。" },
      { emotionEnabled: true, user: "我现在愿意重新开启情绪趋势记录，今天的状态大概是负二分。" },
    ],
  },
  {
    id: "qwen-real-08-promote",
    scenario: "近期模式在稳定后具备升级条件",
    focus: ["short", "promote", "long"],
    turns: [
      { user: "这周我每天晚饭后都会散步半小时。" },
      { user: "这个习惯其实已经保持三个月了，散步会让我从工作状态里退出来。" },
      { user: "接下来几个月我也打算继续保持。" },
    ],
  },
  {
    id: "qwen-real-09-profile-summary",
    scenario: "长期原子认识生成有界人物综述",
    focus: ["long", "profile", "source-version-ids"],
    turns: [
      { user: "我是做交互设计的，最近在带一个刚起步的小团队。" },
      { user: "我很在意产品里的文字是否诚实，不喜欢为了转化夸大承诺。" },
      { user: "遇到分歧时，我希望别人直接指出问题，但别用居高临下的语气。" },
    ],
  },
  {
    id: "qwen-real-10-emotional-quality",
    scenario: "高情绪与身体不适回答质量防退化",
    focus: ["emotional-deep", "character-fallback", "quality-guard"],
    turns: [
      { user: "我最近感觉性压抑，也不知道该和谁说。" },
      { user: "我最近感觉一上课头就晕，我又害怕大学物理课跟不上。" },
      { user: "我现在不想要很多方法，只希望你先把我的害怕听明白。" },
    ],
  },
];

const gateway = new AliyunBailianGateway();
let estimatedCostCny = 0;
let personalSkill: PersonalSkill = structuredClone(defaultPersonalSkill);

function account(meta: ModelCallMeta) {
  estimatedCostCny += meta.estimatedCostCny;
  if (estimatedCostCny > budgetCny) {
    throw new Error(`真实模型测试估算费用已达到 ¥${estimatedCostCny.toFixed(4)}，超过本轮 ¥${budgetCny.toFixed(2)} 上限。`);
  }
}

const fixtures = [];
for (const [scenarioIndex, scenario] of scenarios.entries()) {
  let memories: MemoryRecord[] = [];
  let history: ChatMessage[] = [];
  let activeConversation = scenario.turns[0]?.conversation ?? "main";
  const turns = [];
  let profileSummary = "";
  let shouldEvolve = false;
  const evolutionEvidenceIds: string[] = [];

  for (const [turnIndex, turn] of scenario.turns.entries()) {
    const conversation = turn.conversation ?? "main";
    if (conversation !== activeConversation) {
      activeConversation = conversation;
      history = [];
    }
    const userMessageId = crypto.randomUUID();
    const context = buildContext({ memories, history, profileSummary, personalSkill });
    const route = await gateway.routeFacts(turn.user);
    account(route.meta);
    const response = await generateDialogue(turn.user, context, route.data);
    account(response.meta);
    const reflection = await gateway.reflect({
      userId: crypto.randomUUID(),
      conversationId: crypto.randomUUID(),
      messageId: userMessageId,
      content: turn.user,
      context,
      kind: turn.kind ?? "chat",
      questionCategory: turn.questionCategory,
    }, { deep: turnIndex > 0 && /纠正|不是|忘掉|重新记住/u.test(turn.user) });
    account(reflection.meta);

    const validityAdjustments: string[] = [];
    const acceptedActions: MemoryMutation[] = reflection.data.memories
      .filter((action) => turn.emotionEnabled !== false || !("category" in action && action.category === "emotion"))
      .map((action) => {
        if (!("tier" in action)) return action;
        const validity = normalizeMemoryValidity(action.tier, action.validUntil);
        if (validity.reason) validityAdjustments.push(validity.reason);
        return { ...action, validUntil: validity.validUntil };
      });
    memories = applyActions(memories, acceptedActions);
    history.push(
      { id: userMessageId, role: "user", content: turn.user, createdAt: new Date().toISOString() },
      { id: crypto.randomUUID(), role: "assistant", content: response.content, createdAt: new Date().toISOString() },
    );
    history = history.slice(-12);
    shouldEvolve ||= reflection.data.shouldEvolveSkill;
    if (reflection.data.shouldEvolveSkill) evolutionEvidenceIds.push(userMessageId);

    turns.push({
      turn: turnIndex + 1,
      conversation,
      user: turn.user,
      assistant: response.content,
      route: route.data,
      model: response.meta.model,
      transport: response.meta.transport,
      fallbackFrom: response.meta.fallbackFrom ?? null,
      attempts: response.meta.attempts ?? [],
      modelMemoryActions: reflection.data.memories,
      acceptedMemoryActions: acceptedActions,
      authorizationFilteredCount: reflection.data.memories.length - acceptedActions.length,
      validityAdjustments,
      mood: turn.emotionEnabled === false ? null : reflection.data.mood,
      decisionReason: reflection.data.decisionReason,
    });
  }

  const profileInput = memories
    .filter((memory) => memory.tier === "long" && !["emotion", "boundary"].includes(memory.category))
    .map((memory) => ({
      memoryId: memory.id,
      versionId: memory.versionId,
      category: memory.category,
      content: memory.content,
      confidence: memory.confidence,
    }));
  let profile = null;
  if (profileInput.length) {
    const result = await gateway.synthesizeProfile({ memories: profileInput, currentSummary: profileSummary || undefined });
    account(result.meta);
    profileSummary = result.data.summary;
    profile = { ...result.data, meta: compactMeta(result.meta) };
  }

  const summary = await gateway.summarizeSession({
    messages: history.map(({ role, content }) => ({ role, content })),
  });
  account(summary.meta);

  let skillEvolution = null;
  if (shouldEvolve && evolutionEvidenceIds.length) {
    const evolved = await gateway.evolvePersonalSkill({
      currentSkill: personalSkill,
      evidenceIds: evolutionEvidenceIds,
      latestUserMessage: scenario.turns.at(-1)?.user,
      feedbackReason: "真实回放中出现了明确的交流偏好。",
      profileSummary,
    }, { deep: true });
    account(evolved.meta);
    personalSkill = evolved.data;
    skillEvolution = { content: evolved.data, meta: compactMeta(evolved.meta) };
  }

  fixtures.push({
    id: scenario.id,
    scenario: scenario.scenario,
    focus: scenario.focus,
    turns,
    finalActiveMemories: memories,
    profile,
    sessionSummary: summary.data.summary,
    skillEvolution,
  });
  process.stdout.write(`[${scenarioIndex + 1}/10] ${scenario.scenario} · 累计估算 ¥${estimatedCostCny.toFixed(4)}\n`);
}

const dataset = {
  schemaVersion: "zhiwei.memory-lifecycle-replays/v1",
  datasetVersion: `1.0.0-qwen-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}`,
  releasedAt: new Date().toISOString(),
  provenance: {
    kind: "aliyun-bailian-real-replay",
    gateway: gateway.id,
    provider: "aliyun-bailian",
    synthetic: true,
    liveModel: true,
    billable: true,
    description: "由十组脱敏合成人物轨迹真实调用千问生成；只读展示，不写入任何用户画像。",
    estimatedCostCny: Number(estimatedCostCny.toFixed(6)),
    budgetCny,
  },
  fixtures,
};

const outputPath = fileURLToPath(new URL("../../../apps/web/src/data/memory-lifecycle-replays.qwen.v1.json", import.meta.url));
await writeFile(outputPath, `${JSON.stringify(dataset, null, 2)}\n`, "utf8");
process.stdout.write(`真实回放已写入 ${outputPath}\n总估算费用：¥${estimatedCostCny.toFixed(4)} / ¥${budgetCny.toFixed(2)}\n`);

function buildContext(input: {
  memories: MemoryRecord[];
  history: ChatMessage[];
  profileSummary: string;
  personalSkill: PersonalSkill;
}): CompiledContext {
  return {
    foundationInstructions: "知微固定基底技能已加载：成熟平等、先具体承接、尊重授权、事实保持可核验、记忆只来自用户证据。",
    personalSkill: input.personalSkill,
    profileSummary: input.profileSummary,
    memories: input.memories.slice(-8),
    sessionSummary: "",
    recentMessages: input.history.slice(-12),
    estimatedTokens: 0,
    truncated: false,
  };
}

async function generateDialogue(content: string, context: CompiledContext, responsePlan: DialogueResponsePlan) {
  let output = "";
  let meta: ModelCallMeta | null = null;
  for await (const event of gateway.streamDialogue({
    userId: crypto.randomUUID(),
    conversationId: crypto.randomUUID(),
    messageId: crypto.randomUUID(),
    content,
    context,
    responsePlan,
  })) {
    if (event.type === "text.delta") output += event.delta;
    if (event.type === "completed") meta = event.meta;
  }
  if (!meta || !output.trim()) throw new Error("真实回放中的对话没有完整结束。");
  return { content: output.trim(), meta };
}

function applyActions(current: MemoryRecord[], actions: MemoryMutation[]): MemoryRecord[] {
  const memories = current.map((memory) => ({ ...memory }));
  for (const action of actions) {
    if (action.operation === "withdraw") {
      const index = memories.findIndex((memory) => memory.id === action.memoryId && memory.versionId === action.expectedVersionId);
      if (index >= 0) memories.splice(index, 1);
      continue;
    }
    if (action.operation === "supersede" || action.operation === "promote") {
      const index = memories.findIndex((memory) => memory.id === action.memoryId && memory.versionId === action.expectedVersionId);
      if (index >= 0) {
        memories[index] = memoryFromAction(action, memories[index]!.id);
      }
      continue;
    }
    memories.push(memoryFromAction(action));
  }
  return memories;
}

function memoryFromAction(
  action: Exclude<MemoryMutation, { operation: "withdraw" }>,
  memoryId: string = crypto.randomUUID(),
): MemoryRecord {
  return {
    id: memoryId,
    versionId: crypto.randomUUID(),
    category: action.category,
    content: action.content,
    tier: action.tier,
    confidence: action.confidence,
    validUntil: action.tier === "short"
      ? action.validUntil ?? new Date(Date.now() + 7 * 86_400_000).toISOString()
      : null,
    reason: action.reason,
    status: "active",
    evidenceMessageIds: action.evidenceMessageIds,
    createdAt: new Date().toISOString(),
  };
}

function compactMeta(meta: ModelCallMeta) {
  return {
    task: meta.task,
    model: meta.model,
    transport: meta.transport,
    usage: meta.usage,
    estimatedCostCny: meta.estimatedCostCny,
    durationMs: meta.durationMs,
    retries: meta.retries,
    thinking: meta.thinking,
    attempts: meta.attempts ?? [],
  };
}
