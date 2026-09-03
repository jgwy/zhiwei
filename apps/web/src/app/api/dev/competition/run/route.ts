import {
  callMemoryMcp,
  callScienceMcp,
  compileContext,
  createBenchmarkRun,
  defaultPersonalSkill,
  getUserTimeZone,
  recordModelCallMeta,
  type BenchmarkMode,
  type BenchmarkOutput,
  type FactBriefOutput,
  type MemoryRecord,
  type ProfileSnapshot,
} from "@zhiwei/core";
import { getModelGateway } from "@zhiwei/model-gateway";
import { composeFoundationInstructions } from "@zhiwei/skills";
import { NextResponse } from "next/server";
import { z } from "zod";
import { isDeveloperMode, jsonError } from "@/lib/http";
import { getSessionUserId } from "@/lib/session";

const InputSchema = z.object({
  prompt: z.string().trim().min(1).max(4_000),
  scenario: z.string().trim().min(1).max(100).default("太阳耀斑课程讲稿"),
});

export async function POST(request: Request) {
  try {
    if (!isDeveloperMode()) return jsonError(new Error("developer_mode_disabled"), 404);
    const userId = await getSessionUserId();
    const input = InputSchema.parse(await request.json());
    const gateway = getModelGateway();
    const traceId = crypto.randomUUID();
    const [profile, memories, activeSkill, timeZone] = await Promise.all([
      callMemoryMcp<{ profile: ProfileSnapshot | null }>({ tool: "profile_get_current", userId, traceId }).then((result) => result.profile),
      callMemoryMcp<{ memories: MemoryRecord[] }>({ tool: "memory_search", userId, traceId, arguments: { query: input.prompt, limit: 8 } }).then((result) => result.memories),
      callMemoryMcp<any>({ tool: "personal_skill_get_active", userId, traceId }).then((result) => result.skill),
      getUserTimeZone(userId),
    ]);
    let factBrief: FactBriefOutput | null = null;
    let factSources: any[] = [];
    const factRoute = await gateway.routeFacts(input.prompt);
    await recordModelCallMeta({ userId, traceId, adapterId: gateway.id, meta: factRoute.meta });
    if (factRoute.data.needsSearch) {
      const verified = await gateway.buildFactBrief({ content: input.prompt, route: factRoute.data });
      factBrief = verified.data;
      factSources = verified.meta.sources;
      await recordModelCallMeta({ userId, traceId, adapterId: gateway.id, meta: verified.meta });
      if (factRoute.data.scientific && factBrief.claims.length) {
        const audit = await callScienceMcp<any>({
          tool: "science_claim_audit",
          userId,
          traceId,
          arguments: {
            impact: factRoute.data.impact === "high" ? "high" : "medium",
            sources: factSources.map((source: any) => ({ title: source.title, url: source.url, publisher: source.siteName, kind: "unknown" })),
            claims: factBrief.claims.map((claim) => ({ ...claim, sourceIndices: claim.sourceIndices.map((index) => index - 1) })),
          },
        });
        factBrief = { ...factBrief, claims: audit.auditedClaims.map((claim: any) => ({ text: claim.text, status: claim.status, sourceIndices: claim.sourceIndices.map((index: number) => index + 1), note: claim.auditReason ?? claim.note })) };
      }
    }
    const foundation = composeFoundationInstructions([
      "zhiwei-persona",
      "dialogue-orchestrator",
      "fact-and-tool-use",
      "scientific-answering",
      "risk-and-boundary",
      "privacy-and-withdrawal",
    ]);
    const modes: BenchmarkMode[] = ["direct", "profile", "adaptive"];
    const outputs: BenchmarkOutput[] = [];
    let lastModel: string | undefined;
    let lastTransport: string | undefined;
    for (const mode of modes) {
      const context = compileContext({
        foundationInstructions: mode === "direct" ? "" : foundation,
        personalSkill:
          mode === "adaptive" ? activeSkill?.content ?? defaultPersonalSkill : defaultPersonalSkill,
        profile: mode === "direct" ? null : profile,
        memories: mode === "direct" ? [] : memories,
        sessionSummary: null,
        messages: [],
        maxInputTokens: 18_000,
        timeZone,
      });
      const started = Date.now();
      let content = "";
      let completedMeta: any = null;
      for await (const event of gateway.streamDialogue({
        userId,
        conversationId: crypto.randomUUID(),
        messageId: crypto.randomUUID(),
        content: input.prompt,
        context,
        benchmarkMode: mode,
        factBrief,
        scienceMode: factRoute.data.scientific,
        responsePlan: {
          responseMode: factRoute.data.responseMode,
          depth: factRoute.data.depth,
          physicalSymptom: factRoute.data.physicalSymptom,
          reason: factRoute.data.reason,
        },
      })) {
        if (event.type === "text.delta") content += event.delta;
        if (event.type === "completed") {
          completedMeta = event.meta;
          lastModel = event.meta.model;
          lastTransport = event.meta.transport;
        }
      }
      if (completedMeta) await recordModelCallMeta({ userId, traceId, adapterId: gateway.id, meta: completedMeta });
      outputs.push({
        mode,
        content,
        claims: (factBrief?.claims ?? []).map((claim) => {
          const source = factSources.find((_: any, index: number) => claim.sourceIndices.includes(index + 1));
          return { text: claim.text, status: claim.status, sourceTitle: source?.title, sourceUrl: source?.url, note: claim.note };
        }),
        latencyMs: Date.now() - started,
        estimatedTokens: Math.ceil((context.estimatedTokens + content.length) / 2.4),
      });
    }
    const run = await createBenchmarkRun({
      userId,
      prompt: input.prompt,
      scenario: input.scenario,
      adapterId: gateway.id,
      modelName: lastModel,
      transport: lastTransport,
      outputs,
    });
    return NextResponse.json(run);
  } catch (error) {
    return jsonError(error, 400);
  }
}
