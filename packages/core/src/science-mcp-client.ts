import { z } from "zod";
import { callInternalMcp, type InternalMcpCall } from "./mcp-transport";

export const ScienceSourceSchema = z.object({
  title: z.string().min(1).max(500),
  url: z.string().url().max(2_000),
  publisher: z.string().min(1).max(200).optional(),
  excerpt: z.string().max(2_000).optional(),
  kind: z.enum(["official", "research", "secondary", "community", "unknown"]).default("unknown"),
});

export const ScienceImpactSchema = z.enum(["low", "medium", "high"]);

export const ScienceAuditClaimSchema = z.object({
  text: z.string().min(1).max(2_000),
  status: z.enum(["supported", "uncertain", "human_review"]),
  sourceIndices: z
    .array(z.number().int())
    .max(24)
    .default([])
    .describe("sources 数组中从 0 开始的索引；越界索引由审计工具返回并移除"),
  note: z.string().max(1_000).optional(),
});

export const ScienceSourceAssessmentSchema = z.object({
  sourceIndex: z.number().int().nonnegative(),
  authorityLevel: z.enum([
    "authoritative_primary",
    "primary_research",
    "reputable_secondary",
    "unknown",
    "low_quality",
  ]),
  authorityScore: z.number().int().min(0).max(4),
  reason: z.string().min(1).max(500),
  hostname: z.string().min(1).max(253),
});

export const AuditedScienceClaimSchema = ScienceAuditClaimSchema.extend({
  sourceIndices: z.array(z.number().int().nonnegative()).max(24),
  invalidSourceIndices: z.array(z.number().int()).max(24),
  auditReason: z.string().min(1).max(1_000),
});

export type ScienceSource = z.infer<typeof ScienceSourceSchema>;
export type ScienceImpact = z.infer<typeof ScienceImpactSchema>;
export type ScienceAuditClaim = z.infer<typeof ScienceAuditClaimSchema>;
export type ScienceSourceAssessment = z.infer<typeof ScienceSourceAssessmentSchema>;
export type AuditedScienceClaim = z.infer<typeof AuditedScienceClaimSchema>;

export async function callScienceMcp<T>(input: Omit<InternalMcpCall, "tool" | "arguments"> & {
  tool: "science_source_assess" | "science_claim_audit";
  arguments: Record<string, unknown>;
}): Promise<T> {
  return callInternalMcp<T>(
    process.env.SCIENCE_MCP_URL ?? "http://127.0.0.1:4200/mcp",
    "科学审计服务",
    input,
  );
}
