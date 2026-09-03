export type CheckSource = {
  title: string;
  url: string;
  publisher?: string;
  kind?: "official" | "research" | "secondary" | "community" | "unknown";
};

export type CheckClaim = {
  text: string;
  status: "supported" | "uncertain" | "human_review";
  sourceIndices: number[];
  note?: string;
};

export type CheckedClaim = CheckClaim & {
  invalidSourceIndices: number[];
  checkReason: string;
};

const LOW_QUALITY_HOSTS = ["zhihu.com", "weibo.com", "reddit.com", "quora.com", "douyin.com", "bilibili.com"];
const REPUTABLE_HOSTS = ["reuters.com", "apnews.com", "bbc.com", "nature.com", "science.org", "who.int", "un.org"];

export function checkClaims(input: {
  query: string;
  impact: "ordinary" | "high";
  claims: CheckClaim[];
  sources: CheckSource[];
}): { checkedClaims: CheckedClaim[] } {
  const identitySubjects = extractIdentitySubjects(input.query);
  const identitySensitive = identitySubjects.length > 0 || /(?:身份|职称|职位|任职|院系|教授|导师|履历|简历)/u.test(input.query);

  return {
    checkedClaims: input.claims.map((claim) => {
      const uniqueIndices = [...new Set(claim.sourceIndices)];
      const sourceIndices = uniqueIndices.filter((index) => index >= 0 && index < input.sources.length && isUsableSource(input.sources[index]!));
      const invalidSourceIndices = uniqueIndices.filter((index) => !sourceIndices.includes(index));
      const boundSources = sourceIndices.map((index) => input.sources[index]!);
      let status = claim.status;
      let checkReason = "主张状态与来源绑定通过基础检查。";

      if (claim.status === "supported" && sourceIndices.length === 0) {
        status = "human_review";
        checkReason = "主张没有可用的 HTTP(S) 来源，不能视为已核实。";
      } else if (claim.status === "supported" && boundSources.every(isLowQualitySource)) {
        status = "human_review";
        checkReason = "主张只有社区或用户生成内容支撑，不能视为已核实。";
      } else if (claim.status === "supported" && identitySensitive && !identityEvidenceMatches(identitySubjects, claim.text, boundSources)) {
        status = "human_review";
        checkReason = "人物身份主张缺少同时匹配姓名的机构来源，不能视为已核实。";
      } else if (claim.status === "supported" && input.impact === "high" && !boundSources.some(isAuthoritativeSource)) {
        status = "human_review";
        checkReason = "高影响主张缺少可识别的权威来源，不能视为已核实。";
      } else if (invalidSourceIndices.length > 0) {
        checkReason = "已移除无效或越界的来源索引，其余来源绑定通过检查。";
      }

      return { ...claim, status, sourceIndices, invalidSourceIndices, checkReason };
    }),
  };
}

function extractIdentitySubjects(query: string) {
  const subjects = new Set<string>();
  for (const pattern of [
    /(?:^|[\n：:。！？?])([\p{Script=Han}·]{2,6})是谁/gu,
    /的([\p{Script=Han}·]{2,6})(?:教授|老师|医生|院士|博士|主任)/gu,
  ]) {
    for (const match of query.matchAll(pattern)) if (match[1]) subjects.add(match[1]);
  }
  return [...subjects];
}

function identityEvidenceMatches(subjects: string[], claim: string, sources: CheckSource[]) {
  if (!sources.some(isInstitutionalSource)) return false;
  if (!subjects.length) return true;
  return subjects.some((subject) => claim.includes(subject) && sources.some((source) => {
    const label = `${source.title} ${source.publisher ?? ""}`;
    return isInstitutionalSource(source) && label.includes(subject);
  }));
}

function isUsableSource(source: CheckSource) {
  if (!source.title.trim()) return false;
  try {
    const url = new URL(source.url);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function hostname(source: CheckSource) {
  try {
    return new URL(source.url).hostname.toLowerCase().replace(/^www\./u, "");
  } catch {
    return "";
  }
}

function hostMatches(host: string, candidate: string) {
  return host === candidate || host.endsWith(`.${candidate}`);
}

function isLowQualitySource(source: CheckSource) {
  const host = hostname(source);
  return source.kind === "community" || LOW_QUALITY_HOSTS.some((candidate) => hostMatches(host, candidate));
}

function isInstitutionalSource(source: CheckSource) {
  const host = hostname(source);
  return source.kind === "official"
    || /(?:\.gov(?:\.[a-z]{2})?|\.edu(?:\.[a-z]{2})?|\.ac\.[a-z]{2})$/u.test(host)
    || ["who.int", "un.org"].some((candidate) => hostMatches(host, candidate));
}

function isAuthoritativeSource(source: CheckSource) {
  const host = hostname(source);
  return isInstitutionalSource(source)
    || source.kind === "research"
    || REPUTABLE_HOSTS.some((candidate) => hostMatches(host, candidate));
}
