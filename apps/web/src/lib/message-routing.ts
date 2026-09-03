import type { MemoryRecord } from "@zhiwei/core/client";

export type MemoryQueryResolution = {
  answer: string;
  memoryIds: string[];
  state: "active" | "pending" | "empty";
};

type MemoryQuery =
  | { kind: "identity" }
  | { kind: "summary" }
  | { kind: "named-person"; subject: string };

export function isPotentialMemoryQuery(content: string): boolean {
  return classifyMemoryQuery(content) !== null;
}

export function isPersonalDisclosure(content: string): boolean {
  const text = content.trim();
  if (!text || /[？?]/u.test(text) || /(?:为什么|怎么|如何|是不是|能不能|可以吗|谁|什么|哪里|哪儿)/u.test(text)) return false;
  return /^(?:(?:请|帮我)?记住|以后记得|请保存|别忘了|不要忘记|我(?:是|叫|来自|在|喜欢|不喜欢|希望|习惯|正在|已经)|我的[^，。！？]{0,16}(?:是|叫))/u.test(text);
}

export function resolveMemoryQuery(
  content: string,
  memories: MemoryRecord[],
): MemoryQueryResolution | null {
  const query = classifyMemoryQuery(content);
  if (!query) return null;

  const relevant = query.kind === "named-person"
    ? memories.filter((memory) => memory.content.includes(query.subject))
    : query.kind === "identity"
      ? memories.filter((memory) => memory.category === "basic" || /(?:用户|我)(?:是|叫|来自)/u.test(memory.content))
      : memories;
  if (query.kind === "named-person" && !relevant.length) return null;

  const active = relevant.filter((memory) => (memory.status ?? "active") === "active");
  const pending = relevant.filter((memory) => memory.status === "pending");
  if (active.length) {
    const selected = query.kind === "summary" ? active.slice(0, 8) : active.slice(0, 3);
    const statements = selected.map((memory) => toSecondPerson(memory.content));
    return {
      answer: query.kind === "summary"
        ? `我目前记得这些：\n${statements.map((statement) => `- ${statement}`).join("\n")}`
        : `我记得，${statements.join("；")}。`,
      memoryIds: selected.map((memory) => memory.id),
      state: "active",
    };
  }
  if (pending.length) {
    const candidate = toSecondPerson(pending[0]!.content);
    return {
      answer: `我找到一条还没确认的认识：“${candidate}”。你确认后，我才能在其他对话里把它当作长期记忆使用。`,
      memoryIds: [pending[0]!.id],
      state: "pending",
    };
  }
  return {
    answer: "我现在还没有可跨对话使用的已确认记忆。你可以明确说“请记住……”，或在“关于你”里确认待确认内容。",
    memoryIds: [],
    state: "empty",
  };
}

function classifyMemoryQuery(content: string): MemoryQuery | null {
  const text = content.trim().replace(/\s+/gu, "");
  if (/^(?:我(?:是|试试?)谁|你知道我是谁(?:吗)?|你还记得我是谁(?:吗)?)[？?。]*$/u.test(text)) {
    return { kind: "identity" };
  }
  if (/(?:你|还)?(?:记得|知道|了解)(?:关于)?我(?:的)?(?:什么|哪些|多少)|关于我你(?:记得|知道|了解)(?:什么|哪些)/u.test(text)) {
    return { kind: "summary" };
  }
  const namedPerson = text.match(/^([^，,。！？?]{2,20})是谁[？?。]*$/u)?.[1];
  return namedPerson ? { kind: "named-person", subject: namedPerson } : null;
}

function toSecondPerson(content: string) {
  return content.trim()
    .replace(/^用户(?:目前|现在)?/u, "你")
    .replace(/[。；;]+$/u, "");
}
