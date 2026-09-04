import type { MemoryCategory, QuestionDefinition, QuestionPlannerOutput } from "./types";

export function selectPlannedQuestions(plan:QuestionPlannerOutput,userId:string,answerCount:number):QuestionDefinition[] {
  const selected:QuestionDefinition[]=[];
  for(let offset=0;offset<2;offset++) {
    const bucket=[...`${userId}:${answerCount}:${offset}`].reduce((sum,c)=>sum+c.codePointAt(0)!,0)%10;
    const preferred=bucket<2?plan.adjacentCandidates:plan.gapCandidates;
    const others=bucket<2?plan.gapCandidates:plan.adjacentCandidates;
    const candidate=[...preferred,...others].find(item=>!selected.some(question=>question.text.trim()===item.text.trim()));
    if(!candidate)break;
    selected.push({id:`model-${crypto.randomUUID()}`,category:candidate.category,text:candidate.text,options:candidate.options.filter(option=>option!=="其他").slice(0,4),priority:bucket<2?20:80});
  }
  return selected;
}

export const questionBank: QuestionDefinition[] = [
  {
    id: "current-stage",
    category: "basic",
    text: "如果用一句话介绍此刻的你，你会怎么说？",
    options: ["我正在上学", "刚参加工作", "处在人生的转折期", "生活早出晚归、粗茶淡饭"],
    priority: 100,
  },
  {
    id: "current-focus",
    category: "challenge",
    text: "最近最占你心里位置的一件事，是什么？",
    options: ["学习或工作", "一段情感关系", "对未来的选择", "身体和心理上的疲惫"],
    priority: 95,
  },
  {
    id: "conversation-style",
    category: "expression",
    text: "你更希望我怎么陪你聊？",
    options: ["你先听我说", "帮我一起捋", "直接给判断", "都可以"],
    priority: 90,
  },
  {
    id: "near-goal",
    category: "goal",
    text: "接下来一两个月，你最想看到什么变化？",
    options: ["更有行动力", "情绪更稳定", "做出一个决定", "还没想清楚"],
    priority: 72,
    keywords: ["工作", "学习", "未来", "选择"],
  },
  {
    id: "interest-energy",
    category: "interest",
    text: "什么事情会让你不知不觉投入很久？",
    options: ["阅读和学习", "运动或户外", "创作表达", "和喜欢的人相处"],
    priority: 60,
  },
  {
    id: "emotion-pattern",
    category: "emotion",
    text: "状态不太好时，你通常更需要空间，还是更需要有人靠近一点？",
    options: ["让我安静一下", "陪我说说话", "帮我解决问题", "每次都不一样"],
    priority: 66,
    keywords: ["累", "焦虑", "难过", "压力"],
  },
  {
    id: "important-experience",
    category: "experience",
    text: "有没有一段经历，至今还影响着你看事情的方式？",
    options: ["有，愿意聊聊", "有，但以后再说", "暂时想不到"],
    priority: 45,
  },
  {
    id: "conversation-boundary",
    category: "boundary",
    text: "有没有什么话题或表达方式，是你希望我更有分寸的？",
    options: ["别太说教", "别反复追问", "别过度安慰", "目前没有"],
    priority: 55,
  },
];

export function pickNextQuestion(input: {
  answeredQuestionIds: string[];
  lastAnswer?: string;
  seed: string;
}): QuestionDefinition | null {
  const candidates = questionBank.filter(
    (question) => !input.answeredQuestionIds.includes(question.id),
  );
  if (!candidates.length) return null;

  const firstThree = ["current-stage", "current-focus", "conversation-style"];
  const missingCore = firstThree.find(
    (id) => !input.answeredQuestionIds.includes(id),
  );
  if (missingCore && input.answeredQuestionIds.length < 3) {
    return questionBank.find((question) => question.id === missingCore) ?? null;
  }

  const last = input.lastAnswer ?? "";
  const scored = candidates
    .map((question) => ({
      question,
      score:
        question.priority +
        (question.keywords?.some((keyword) => last.includes(keyword)) ? 35 : 0),
    }))
    .sort((a, b) => b.score - a.score);

  const random = seededRandom(`${input.seed}:${input.answeredQuestionIds.length}`);
  if (random < 0.2 && scored.length > 1) {
    return scored[1 + Math.floor(seededRandom(`${input.seed}:explore`) * (scored.length - 1))]
      ?.question ?? scored[0]!.question;
  }
  return scored[0]!.question;
}

export function categoryLabel(category: MemoryCategory): string {
  const labels: Record<MemoryCategory, string> = {
    basic: "此刻的你",
    goal: "阶段目标",
    interest: "兴趣偏好",
    expression: "交流方式",
    emotion: "情绪与状态",
    experience: "重要经历",
    challenge: "正在面对",
    boundary: "相处分寸",
  };
  return labels[category];
}

function seededRandom(seed: string): number {
  let hash = 2166136261;
  for (const char of seed) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4_294_967_295;
}
