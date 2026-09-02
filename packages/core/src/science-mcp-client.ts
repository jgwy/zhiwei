import { z } from "zod";

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

export async function callScienceMcp<T>(input: {
  tool: "science_source_assess" | "science_claim_audit";
  userId: string;
  arguments: Record<string, unknown>;
  traceId?: string;
}): Promise<T> {
  const url = process.env.SCIENCE_MCP_URL ?? "http://127.0.0.1:4200/mcp";
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${process.env.INTERNAL_MCP_TOKEN ?? "local-development-mcp-token"}`,
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": "tools/call",
      "mcp-name": input.tool,
      "x-zhiwei-user": input.userId,
      ...(input.traceId ? { traceparent: input.traceId } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "tools/call",
      params: {
        name: input.tool,
        arguments: input.arguments,
        _meta: {
          "io.modelcontextprotocol/clientInfo": {
            name: "zhiwei-runtime",
            version: "0.1.0",
          },
        },
      },
    }),
  });
  if (!response.ok) {
    throw new Error(`科学审计服务 ${input.tool} 请求失败：${response.status}`);
  }
  const payload = await response.json();
  if (payload.error) throw new Error(payload.error.message ?? "科学审计服务返回错误");
  return payload.result as T;
}
