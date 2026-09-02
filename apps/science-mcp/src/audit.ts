import type {
  AuditedScienceClaim,
  ScienceAuditClaim,
  ScienceImpact,
  ScienceSource,
  ScienceSourceAssessment,
} from "@zhiwei/core";

const PUBLIC_AUTHORITY_HOSTS = new Set([
  "who.int",
  "un.org",
  "europa.eu",
  "esa.int",
  "worldbank.org",
  "oecd.org",
]);

const PRIMARY_RESEARCH_HOSTS = new Set([
  "doi.org",
  "pubmed.ncbi.nlm.nih.gov",
  "ncbi.nlm.nih.gov",
  "clinicaltrials.gov",
  "arxiv.org",
  "openreview.net",
]);

const REPUTABLE_SECONDARY_HOSTS = new Set([
  "reuters.com",
  "apnews.com",
  "bbc.com",
  "nature.com",
  "science.org",
  "scientificamerican.com",
]);

const COMMUNITY_HOSTS = new Set([
  "reddit.com",
  "quora.com",
  "zhihu.com",
  "weibo.com",
  "bilibili.com",
  "douyin.com",
]);

function hostMatches(hostname: string, candidate: string): boolean {
  return hostname === candidate || hostname.endsWith(`.${candidate}`);
}

function isPublicAuthority(hostname: string): boolean {
  return (
    hostname.endsWith(".gov") ||
    hostname.endsWith(".gov.cn") ||
    hostname.endsWith(".gov.uk") ||
    hostname.endsWith(".go.jp") ||
    [...PUBLIC_AUTHORITY_HOSTS].some((host) => hostMatches(hostname, host))
  );
}

function matchesAny(hostname: string, hosts: Set<string>): boolean {
  return [...hosts].some((host) => hostMatches(hostname, host));
}

export function assessScienceSources(sources: ScienceSource[]): ScienceSourceAssessment[] {
  return sources.map((source, sourceIndex) => {
    const hostname = new URL(source.url).hostname.toLowerCase().replace(/^www\./, "");
    if (isPublicAuthority(hostname)) {
      return {
        sourceIndex,
        authorityLevel: "authoritative_primary",
        authorityScore: 4,
        hostname,
        reason: "来源属于可识别的政府机构或国际公共机构域名，可作为该机构职责范围内的一手资料。",
      };
    }
    if (matchesAny(hostname, PRIMARY_RESEARCH_HOSTS) && source.kind === "research") {
      return {
        sourceIndex,
        authorityLevel: "primary_research",
        authorityScore: 4,
        hostname,
        reason: "来源位于可识别的研究论文或研究登记平台，且被声明为原始研究；仍需核对论文内容是否直接支持主张。",
      };
    }
    if (matchesAny(hostname, REPUTABLE_SECONDARY_HOSTS)) {
      return {
        sourceIndex,
        authorityLevel: "reputable_secondary",
        authorityScore: 3,
        hostname,
        reason: "来源属于具有编辑审核机制的媒体或科学出版机构，但当前链接不能自动证明是一手证据。",
      };
    }
    if (matchesAny(hostname, COMMUNITY_HOSTS) || source.kind === "community") {
      return {
        sourceIndex,
        authorityLevel: "low_quality",
        authorityScore: 1,
        hostname,
        reason: "来源主要是社区或用户生成内容，不能单独承担科学事实的权威支撑。",
      };
    }
    return {
      sourceIndex,
      authorityLevel: "unknown",
      authorityScore: 2,
      hostname,
      reason: "无法仅根据域名和来源类型确认权威性，需要人工核对发布主体、原文和证据链。",
    };
  });
}

export function auditScienceClaims(input: {
  claims: ScienceAuditClaim[];
  sources: ScienceSource[];
  impact: ScienceImpact;
}): { sourceAssessments: ScienceSourceAssessment[]; auditedClaims: AuditedScienceClaim[] } {
  const sourceAssessments = assessScienceSources(input.sources);
  const auditedClaims = input.claims.map((claim) => {
    const sourceIndices = [...new Set(claim.sourceIndices)].filter(
      (index) => index >= 0 && index < input.sources.length,
    );
    const invalidSourceIndices = [...new Set(claim.sourceIndices)].filter(
      (index) => index < 0 || index >= input.sources.length,
    );
    const assessments = sourceIndices.flatMap((index) => {
      const assessment = sourceAssessments[index];
      return assessment ? [assessment] : [];
    });
    const hasPrimaryAuthority = assessments.some(
      (item) =>
        item.authorityLevel === "authoritative_primary" || item.authorityLevel === "primary_research",
    );
    const hasUsableSupport = assessments.some((item) => item.authorityScore >= 3);

    let status = claim.status;
    let auditReason = "原状态保留；审计未发现需要自动降级的证据问题。";
    if (claim.status === "supported" && sourceIndices.length === 0) {
      status = "human_review";
      auditReason = "主张被标记为已支持，但没有有效的来源索引，已转为人工复核。";
    } else if (claim.status === "supported" && input.impact === "high" && !hasPrimaryAuthority) {
      status = "human_review";
      auditReason = "高影响主张缺少可识别的权威一手来源或原始研究支撑，已转为人工复核。";
    } else if (claim.status === "supported" && !hasUsableSupport) {
      status = "human_review";
      auditReason = "现有来源均无法确认具备足够的科学事实支撑质量，已转为人工复核。";
    } else if (invalidSourceIndices.length > 0) {
      auditReason = "已移除越界或无效的来源索引，其余有效证据仍满足当前审计要求。";
    }

    return {
      ...claim,
      status,
      sourceIndices,
      invalidSourceIndices,
      auditReason,
    };
  });
  return { sourceAssessments, auditedClaims };
}
