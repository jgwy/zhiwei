import {
  PersonalSkillSchema,
  ReflectionOutputSchema,
  defaultPersonalSkill,
  inferMemoryKind,
  normalizeDimensionWeights,
  type CompiledContext,
  type MemoryCategory,
  type MemoryMutation,
  type ModelCapabilities,
  type PersonalSkill,
  type ReflectionOutput,
  type RiskAssessment,
  type BenchmarkMode,
} from "@zhiwei/core";

export * from "./gateway";

export type DialogueInput = {
  userId: string;
  conversationId: string;
  messageId: string;
  content: string;
  context: CompiledContext;
  riskAssessment?: RiskAssessment;
  benchmarkMode?: BenchmarkMode;
};

export type ReflectionInput = DialogueInput & {
  kind: "chat" | "onboarding";
  questionId?: string;
  questionCategory?: MemoryCategory;
};

export type EvolutionInput = {
  currentSkill: PersonalSkill;
  evidenceIds: string[];
  feedback?: "understood" | "not-me";
  feedbackReason?: string;
  latestUserMessage?: string;
  profileSummary?: string;
};

export interface ModelAdapter {
  readonly id: string;
  readonly capabilities: ModelCapabilities;
  streamDialogue(input: DialogueInput): AsyncIterable<string>;
  reflect(input: ReflectionInput): Promise<ReflectionOutput>;
  evolvePersonalSkill(input: EvolutionInput): Promise<PersonalSkill>;
}

export class ScriptedAdapter implements ModelAdapter {
  readonly id = "zhiwei-scripted-v1";
  readonly capabilities: ModelCapabilities = {
    streaming: true,
    structuredOutput: true,
    toolCalls: true,
    nativeWebSearch: false,
    usage: true,
    maxContextTokens: 24_000,
  };

  async *streamDialogue(input: DialogueInput): AsyncIterable<string> {
    const reply = buildReply(input);
    for (const chunk of chunkText(reply, 4)) {
      await delay(22);
      yield chunk;
    }
  }

  async reflect(input: ReflectionInput): Promise<ReflectionOutput> {
    const memories = extractMemories(input);
    const mood = extractMood(input.content);
    const allMemoryTexts = [
      ...input.context.memories.map((memory) => memory.content),
      ...memories.map((memory) => memory.content),
    ];
    const dimensionWeights = buildDimensionWeights(
      allMemoryTexts,
      input.content,
    );
    const profileSummary = buildProfileSummary(allMemoryTexts, input.content);
    const now = new Date();
    const validAfter = new Date(now.getTime() + 6 * 60 * 60 * 1000);
    const expiresAt = new Date(now.getTime() + 72 * 60 * 60 * 1000);
    const shouldEvolveSkill = shouldEvolve(input.content, memories.length);

    return ReflectionOutputSchema.parse({
      memories,
      profileSummary,
      dimensionWeights,
      mood,
      sessionSummary: summarizeSession(input),
      returnNote:
        input.kind === "chat" && /明天|下次|之后|再说|等我|决定|考虑/.test(input.content)
          ? {
              content: buildReturnNote(input.content),
              validAfter: validAfter.toISOString(),
              expiresAt: expiresAt.toISOString(),
            }
          : null,
      shouldEvolveSkill,
      evolutionReason: shouldEvolveSkill
        ? "这段交流出现了新的表达偏好、明确纠正或值得持续关注的互动信号。"
        : null,
    });
  }

  async evolvePersonalSkill(input: EvolutionInput): Promise<PersonalSkill> {
    const current = structuredClone(input.currentSkill ?? defaultPersonalSkill);
    const negative = input.feedback === "not-me";
    const positive = input.feedback === "understood";
    const reason = input.feedbackReason ?? input.latestUserMessage ?? "近期互动方式发生变化";
    const mentionsDirect = /直接|别绕|结论|坦白/.test(reason);
    const mentionsListen = /听|别建议|陪我|别说教/.test(reason);
    const mentionsShort = /短|简洁|太长|啰嗦/.test(reason);
    const mentionsQuestion = /追问|问题太多|别问/.test(reason);

    const next: PersonalSkill = {
      expression: {
        ...current.expression,
        warmth: clamp10(current.expression.warmth + (positive ? 1 : 0)),
        directness: clamp10(
          current.expression.directness + (mentionsDirect ? 2 : negative ? -1 : 0),
        ),
        brevity: clamp10(current.expression.brevity + (mentionsShort ? 2 : 0)),
      },
      attention: {
        ...current.attention,
        priorityTopics: unique([
          ...extractTopics(input.latestUserMessage ?? ""),
          ...current.attention.priorityTopics,
        ]).slice(0, 12),
        longTermConcerns: unique([
          ...current.attention.longTermConcerns,
          ...(input.profileSummary ? [input.profileSummary.slice(0, 110)] : []),
        ]).slice(-12),
      },
      rhythm: {
        ...current.rhythm,
        questionFrequency: clamp10(
          current.rhythm.questionFrequency + (mentionsQuestion ? -2 : mentionsListen ? -1 : 0),
        ),
        adviceTiming: mentionsListen ? "listen-first" : mentionsDirect ? "direct" : "balanced",
        challengeLevel: clamp10(current.rhythm.challengeLevel + (positive ? 1 : 0)),
      },
      evolution: {
        triggerEvidenceIds: input.evidenceIds.slice(-20),
        reason: `知微从这次互动中重新理解了相处方式：${reason.slice(0, 360)}`,
        expectedEffect: negative
          ? "减少让用户感到不贴合的表达，在下一轮更准确地承接需求。"
          : "延续被用户认可的交流方式，同时更自然地关注长期主题。",
      },
    };
    return PersonalSkillSchema.parse(next);
  }
}

export class ReplayAdapter implements ModelAdapter {
  readonly id = "zhiwei-replay-v1";
  readonly capabilities = new ScriptedAdapter().capabilities;

  constructor(
    private readonly fixture: {
      chunks: string[];
      reflection: ReflectionOutput;
      skill?: PersonalSkill;
    },
  ) {}

  async *streamDialogue(): AsyncIterable<string> {
    for (const chunk of this.fixture.chunks) yield chunk;
  }

  async reflect(): Promise<ReflectionOutput> {
    return ReflectionOutputSchema.parse(this.fixture.reflection);
  }

  async evolvePersonalSkill(input: EvolutionInput): Promise<PersonalSkill> {
    return PersonalSkillSchema.parse(this.fixture.skill ?? input.currentSkill);
  }
}

export class FaultAdapter implements ModelAdapter {
  readonly id = "zhiwei-fault-v1";
  readonly capabilities = new ScriptedAdapter().capabilities;

  constructor(
    private readonly fault: "timeout" | "stream-interrupt" | "invalid-structure" | "rate-limit",
  ) {}

  async *streamDialogue(): AsyncIterable<string> {
    if (this.fault === "timeout") {
      await delay(20_000);
      return;
    }
    if (this.fault === "rate-limit") throw new Error("rate_limit");
    yield "我先接住这句话。";
    if (this.fault === "stream-interrupt") throw new Error("stream_interrupted");
  }

  async reflect(): Promise<ReflectionOutput> {
    if (this.fault === "invalid-structure") {
      return ReflectionOutputSchema.parse({ memories: "invalid" });
    }
    throw new Error(this.fault);
  }

  async evolvePersonalSkill(): Promise<PersonalSkill> {
    throw new Error(this.fault);
  }
}

export function getModelAdapter(): ModelAdapter {
  const provider = process.env.MODEL_PROVIDER ?? "scripted";
  if (provider === "scripted") return new ScriptedAdapter();
  if (provider === "fault") {
    return new FaultAdapter(
      (process.env.MODEL_FAULT as ConstructorParameters<typeof FaultAdapter>[0]) ??
        "stream-interrupt",
    );
  }
  throw new Error(
    `模型供应商 ${provider} 尚未接入。请保持 MODEL_PROVIDER=scripted，或在拿到 API 后添加对应适配器。`,
  );
}

function buildReply(input: DialogueInput): string {
  const text = input.content.trim();
  const memory = input.context.memories.find((item) =>
    item.content.split(/[：，。]/).some((part) => part.length > 3 && text.includes(part)),
  ) ?? input.context.memories[0];
  const recalled = memory ? `我还记得你提过“${memory.content.slice(0, 40)}”。` : "";

  if (input.riskAssessment?.level === "immediate") {
    return "我先不把这当成普通的难过。如果你现在正准备伤害自己，或已经采取了行动，请立刻联系身边可信任的人，不要独处，并联系当地紧急服务；在中国大陆可拨打 110 或 120。先告诉我：你现在是否一个人，身边有没有可能伤害你的东西？";
  }
  if (input.riskAssessment?.level === "ambiguous") {
    return "我想认真确认一下：你刚才说的那句话，是在形容自己非常难受，还是你现在真的有伤害自己的想法、计划或眼前危险？";
  }

  if (/太阳耀斑|空间天气/.test(text)) {
    if (input.benchmarkMode === "direct") {
      return "太阳耀斑是太阳释放能量和电磁辐射的爆发现象，可能影响地球附近的空间环境。强耀斑会干扰无线电通信，并可能影响卫星运行。";
    }
    if (input.benchmarkMode === "profile") {
      return `如果把它写成课程讲稿，可以先抓住一个误区：太阳耀斑并不是“火焰烧到地球”，而是强烈电磁辐射抵达并改变电离层。${recalled} 强耀斑可能让向阳面的高频无线电通信变弱或中断；更慢抵达的日冕物质抛射则可能引发地磁扰动。`;
    }
    if (input.benchmarkMode === "adaptive") {
      return `先从一个学生容易记住的画面开始：太阳突然“闪”了一下，约 8 分钟后，这次爆发的电磁辐射已经抵达地球。${recalled} 它会改变向阳面电离层，让部分高频无线电通信衰减；若还伴随朝向地球的日冕物质抛射，之后可能出现更广泛的地磁扰动。这里要分清：耀斑、粒子事件和日冕物质抛射相关，但不是同一件事。`;
    }
  }

  if (/你好|嗨|在吗|hello|hi/i.test(text)) {
    return input.context.profileSummary
      ? `在。今天想从哪里聊起？${recalled ? ` ${recalled}` : ""}`
      : "在的。我们慢慢来，你现在最想说的是什么？";
  }
  if (/焦虑|难过|崩溃|压力|好累|疲惫|烦|委屈/.test(text)) {
    return `听起来这件事已经在你心里压了一会儿。${recalled} 我不急着劝你振作——你现在更想先把它说完整，还是希望我陪你一起找一个能动起来的小口子？`;
  }
  if (/先听我说|不要马上给建议|别急着建议|我更希望你/.test(text)) {
    return `好，那我先不分析，也不急着把它变成一个要解决的问题。${recalled} 你继续说，我会跟着你真正想表达的地方走。`;
  }
  if (/辞职|分手|选择|要不要|该不该|决定/.test(text)) {
    return `这不是一个只看“对不对”就能决定的问题。${recalled} 我会先看它对你真正重要的东西、现实代价和最坏结果；如果你愿意，把你最舍不得和最担心的各说一件，我再给你一个明确判断。`;
  }
  if (/别再提|不要提|忘掉|记错|不是我|你理解错/.test(text)) {
    return "好，我不和你争这件事。你想替换成怎样的说法，可以直接告诉我；我会把新的理解放在前面，以后按它来。";
  }
  if (/怎么办|怎么做|建议|帮我/.test(text)) {
    return `可以。${recalled} 先别一下子把问题做大：告诉我你已经试过什么、现在卡在哪一步，我会给你一个尽量具体、也不敷衍的下一步。`;
  }
  if (/开心|顺利|完成|做到了|好消息|太好了/.test(text)) {
    return `这件事值得你好好高兴一下。${recalled} 我更好奇的是：你觉得这次真正做对了什么？那可能比结果本身更值得留下来。`;
  }
  return `${recalled ? `${recalled} ` : ""}我听到的重点不是表面这句话，而是它对你意味着什么。你愿意再往前说一点吗——这件事最让你在意的部分是什么？`;
}

function extractMemories(input: ReflectionInput): MemoryMutation[] {
  const text = input.content.trim();
  if (!text) return [];
  if (input.kind === "onboarding" && input.questionCategory) {
    return [
      {
        operation: "create",
        category: input.questionCategory,
        content: onboardingMemoryText(input.questionCategory, text),
        tier: input.questionCategory === "emotion" ? "short" : "long",
        confidence: 0.88,
        validUntil:
          input.questionCategory === "emotion"
            ? new Date(Date.now() + 30 * 86_400_000).toISOString()
            : null,
        reason: `来自初次认识问题 ${input.questionId ?? "dynamic"} 的回答。`,
        evidenceMessageIds: [input.messageId],
        sourceType: "explicit",
        scope: "user",
        sensitivity: "normal",
        importance: 0.8,
        evidenceQuote: text.slice(0, 200),
        kind: "profile",
      },
    ];
  }

  const results: MemoryMutation[] = [];
  const add = (
    category: MemoryCategory,
    content: string,
    tier: "short" | "long",
    confidence = 0.78,
  ) => {
    const existing = input.context.memories.find(
      (memory) => memory.category === category && /其实|不是|改成|记错/.test(text),
    );
    results.push({
      operation: existing ? "supersede" : "create",
      memoryId: existing?.id,
      category,
      content,
      tier,
      confidence,
      validUntil:
        tier === "short" ? new Date(Date.now() + 30 * 86_400_000).toISOString() : null,
      reason: existing
        ? "用户在对话中给出了新的、更高优先级的表述。"
        : "用户在自然对话中提供了对以后交流有价值的信息。",
      evidenceMessageIds: [input.messageId],
      sourceType: /记住|以后记得|请保存|别忘了|不要忘记/.test(text) ? "explicit" : existing ? "confirmed" : "inferred",
      scope: "user",
      sensitivity: "normal",
      importance: existing ? 0.8 : 0.5,
      evidenceQuote: text.slice(0, 200),
      kind: inferMemoryKind(text),
    });
  };

  const name = text.match(/(?:我叫|叫我)([\u4e00-\u9fa5A-Za-z0-9_-]{1,16})/);
  if (name?.[1]) add("basic", `希望被称呼为${name[1]}`, "long", 0.95);
  const like = text.match(/我(?:很)?喜欢(.{2,40}?)(?:[，。！]|$)/);
  if (like?.[1]) add("interest", `喜欢${like[1].trim()}`, "long");
  const expressionSignal = /别太|不要总|不要马上|我更喜欢|我更希望你|回复短|直接一点|先听/.test(text);
  const goal = text.match(/(?:我想|希望|目标是|打算)(.{2,60}?)(?:[，。！]|$)/);
  if (goal?.[1] && !expressionSignal) add("goal", `当前希望${goal[1].trim()}`, "long", 0.84);
  if (expressionSignal) {
    add("expression", `交流偏好：${text.slice(0, 100)}`, "long", 0.86);
  }
  if (/焦虑|难过|压力|好累|疲惫|烦|委屈|开心|兴奋|轻松/.test(text)) {
    add("emotion", `近期状态：${text.slice(0, 100)}`, "short", 0.72);
  }
  if (/最近|正在|目前|这周/.test(text) && /怎么办|纠结|卡住|困难|问题|压力/.test(text)) {
    add("challenge", `正在面对：${text.slice(0, 120)}`, "short", 0.8);
  }
  if (/以前|小时候|曾经|那一年|经历过/.test(text)) {
    add("experience", `重要经历：${text.slice(0, 140)}`, "long", 0.74);
  }
  if (/别再提|不要提|忘掉/.test(text)) {
    add("boundary", `以后不要主动提及：${text.slice(0, 100)}`, "long", 0.94);
  }
  return uniqueMemories(results).slice(0, 5);
}

function onboardingMemoryText(category: MemoryCategory, answer: string): string {
  const prefixes: Record<MemoryCategory, string> = {
    basic: "此刻的自我描述：",
    goal: "近期希望发生的变化：",
    interest: "容易投入的事情：",
    expression: "希望知微的交流方式：",
    emotion: "状态不好时更需要：",
    experience: "仍影响自己的经历：",
    challenge: "最近最占心里的事情：",
    boundary: "希望被尊重的交流分寸：",
  };
  return `${prefixes[category]}${answer.slice(0, 180)}`;
}

function extractMood(text: string): ReflectionOutput["mood"] {
  const positive = countMatches(text, ["开心", "顺利", "轻松", "期待", "兴奋", "完成", "喜欢"]);
  const negative = countMatches(text, ["焦虑", "难过", "压力", "累", "烦", "委屈", "崩溃", "害怕"]);
  if (!positive && !negative) return null;
  const score = Math.max(-5, Math.min(5, positive * 2 - negative * 2));
  return {
    score,
    summary:
      score > 0
        ? `这段话里有比较明确的积极感受：${text.slice(0, 90)}`
        : `这段话里有比较明确的低落或压力：${text.slice(0, 90)}`,
    meaningful: true,
  };
}

function buildProfileSummary(memories: string[], latest: string): string {
  const selected = unique(memories.filter(Boolean)).slice(-6);
  if (!selected.length) return `我们还在初识阶段。最近聊到：${latest.slice(0, 120)}`;
  return `你正在经历一段有具体关注点、也愿意慢慢把自己说清楚的时期。我目前记住的是：${selected.join("；")}。这些理解会继续随你的新表达更新。`.slice(0, 1_500);
}

function buildDimensionWeights(memories: string[], latest: string): Record<string, number> {
  const joined = `${memories.join(" ")} ${latest}`;
  const raw: Record<string, number> = {
    basic: 0.1,
    goal: /目标|希望|想要|未来/.test(joined) ? 0.22 : 0.13,
    interest: /喜欢|兴趣|投入/.test(joined) ? 0.18 : 0.1,
    expression: /交流|说话|回复|建议/.test(joined) ? 0.2 : 0.13,
    emotion: /焦虑|难过|压力|开心|情绪|累/.test(joined) ? 0.2 : 0.12,
    experience: /经历|以前|曾经/.test(joined) ? 0.16 : 0.08,
    challenge: /问题|纠结|困难|正在面对/.test(joined) ? 0.22 : 0.16,
    boundary: /不要|别|分寸/.test(joined) ? 0.16 : 0.08,
  };
  return normalizeDimensionWeights(raw);
}

function summarizeSession(input: ReflectionInput): string {
  const history = input.context.recentMessages.slice(-5).map((message) => message.content);
  return `这段对话围绕“${[...history, input.content].join(" / ").slice(-850)}”展开。知微需要在后续保留语境，但不重复用户原话。`;
}

function buildReturnNote(content: string): string {
  if (/明天/.test(content)) return "你上次提到明天还要面对那件事。现在回头看，它有变得清楚一点吗？";
  if (/决定|考虑/.test(content)) return "上次那个还没完全落下的决定，我没有忘。你现在更靠近哪一边了？";
  return "上次的话题似乎还没有真正结束。你想从那里继续，还是今天有别的更重要？";
}

function shouldEvolve(text: string, memoryCount: number): boolean {
  return (
    memoryCount >= 2 ||
    /你理解错|不是我|别太|我更喜欢|直接一点|先听|不要总|以后记得/.test(text)
  );
}

function extractTopics(text: string): string[] {
  return ["工作", "学习", "关系", "家庭", "情绪", "未来", "创作", "健康"]
    .filter((topic) => text.includes(topic));
}

function countMatches(text: string, words: string[]): number {
  return words.reduce((sum, word) => sum + (text.includes(word) ? 1 : 0), 0);
}

function uniqueMemories(memories: MemoryMutation[]): MemoryMutation[] {
  const seen = new Set<string>();
  return memories.filter((memory) => {
    const key = `${memory.category}:${memory.content}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function clamp10(value: number): number {
  return Math.max(0, Math.min(10, Math.round(value)));
}

function chunkText(text: string, size: number): string[] {
  const chunks: string[] = [];
  let buffer = "";
  for (const char of text) {
    buffer += char;
    if (buffer.length >= size || /[，。！？；,.!?]/.test(char)) {
      chunks.push(buffer);
      buffer = "";
    }
  }
  if (buffer) chunks.push(buffer);
  return chunks;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
