const SEPARATOR = /[\s，。！？、,.!?：:；;“”"'（）()《》<>~～·…—\-_/\\|]+/u;
const SCRIPT_RUNS = /[\u3400-\u9fff]+|[A-Za-z0-9]+/gu;
const CJK = /^[\u3400-\u9fff]+$/u;

/**
 * 把查询拆成可用于子串匹配的检索词。
 * 中文没有空格分词：短词（≤4 字）整词保留，长句按二字滑窗切分，
 * 这样 "喜欢周末跑步" 这类连续句也能与记忆文本做词级命中。
 * 中英混排 token（如 "引力波LIGO探测"）先按文字系统切分再分别处理。
 */
export function extractQueryTerms(query: string, maxTerms = 12): string[] {
  const tokens = query.split(SEPARATOR).filter(Boolean);
  const terms = new Set<string>();
  for (const token of tokens) {
    for (const run of token.match(SCRIPT_RUNS) ?? []) {
      if (CJK.test(run)) {
        if (run.length <= 4) {
          terms.add(run);
          continue;
        }
        for (let index = 0; index + 2 <= run.length; index += 1) {
          terms.add(run.slice(index, index + 2));
        }
        continue;
      }
      const latin = run.toLowerCase();
      if (latin.length >= 2) terms.add(latin);
    }
  }
  return [...terms].slice(0, maxTerms);
}
