import type { FactBriefOutput, ModelSource } from "@zhiwei/core";

/** Preserve model-authored claims while validating their one-based source links. */
export function bindFactSources(brief: FactBriefOutput, inputSources: ModelSource[]) {
  const sources: ModelSource[] = [];
  const sourceIndex = new Map<string, number>();
  const remap = new Map<number, number>();
  inputSources.forEach((source, index) => {
    try {
      const url = new URL(source.url.trim());
      if (!["http:", "https:"].includes(url.protocol) || !source.title.trim()) return;
      let mapped = sourceIndex.get(url.href);
      if (mapped === undefined) {
        sources.push({ ...source, title: source.title.trim(), url: url.href });
        mapped = sources.length;
        sourceIndex.set(url.href, mapped);
      }
      remap.set(index + 1, mapped);
    } catch { /* A malformed source cannot support a claim or become a link. */ }
  });
  let downgradedClaims = 0;
  const claims = brief.claims.map((claim) => {
    const sourceIndices = [...new Set(claim.sourceIndices.flatMap((index) => {
      const mapped = remap.get(index);
      return mapped === undefined ? [] : [mapped];
    }))];
    if (claim.status === "supported" && !sourceIndices.length) {
      downgradedClaims += 1;
      return { ...claim, status: "uncertain" as const, sourceIndices, note: "这项主张没有有效的来源绑定，尚未核实。" };
    }
    return { ...claim, sourceIndices };
  });
  const usedIndices = new Set(claims.flatMap((claim) => claim.sourceIndices));
  const usedSources = sources.filter((_source, index) => usedIndices.has(index + 1));
  const compactIndices = new Map<number, number>();
  for (const index of [...usedIndices].sort((left, right) => left - right)) compactIndices.set(index, compactIndices.size + 1);
  return {
    brief: { ...brief, claims: claims.map((claim) => ({ ...claim, sourceIndices: claim.sourceIndices.map((index) => compactIndices.get(index)!) })) },
    sources: usedSources,
    downgradedClaims,
  };
}

/** The router still decides whether a follow-up is factual or emotional. */
export function factRoutingInput(content: string, recentMessages: Array<{ role: string; content: string }> = []) {
  const history = recentMessages.slice(-6).map((message) => ({ role: message.role, content: message.content.slice(0, 2000) }));
  const last = history.at(-1);
  if (last?.role === "user" && last.content === content) history.pop();
  return JSON.stringify({
    recentMessages: history,
    currentMessage: content,
    instructions: "判断回答需要使用什么外部事实，而不是按用户提到了什么名字决定联网。听歌伤感、恋爱倾诉可直接陪伴；介绍作品、作者、创作背景、发行时间、人物经历或解释外部知识时，优先查证。‘你确定吗、来源呢’若在核验事实，query须根据上一问题和上一回答还原具体待核实主张，上一回答只是待查材料，不是证据；若是在寻求情绪上的确认，就延续陪伴，不搜索。查询只包含必要的外部事实主题，不带用户的私人经历。不要把追问的深度当作高影响，impact=high只用于健康、法律、财产等高影响决策。",
  });
}
