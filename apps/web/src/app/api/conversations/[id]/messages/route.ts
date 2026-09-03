import {
  addMessage,
  assessRisk,
  callMemoryMcp,
  callScienceMcp,
  compileContext,
  enqueueJob,
  getConversationSummary,
  listConversations,
  listMessages,
  recordModelCallMeta,
  recordRiskEvent,
  recordTrace,
  saveMessageSources,
  type MemoryRecord,
  type FactBriefOutput,
  type FactRoutingOutput,
  type PersonalSkill,
  type ProfileSnapshot,
  type StreamEvent,
} from "@zhiwei/core";
import { getModelGateway } from "@zhiwei/model-gateway";
import { composeFoundationInstructions } from "@zhiwei/skills";
import { z } from "zod";
import { assistantStreamDisposition } from "@/lib/assistant-stream";
import { getSessionUserId } from "@/lib/session";

const InputSchema = z.object({ content: z.string().trim().min(1).max(8_000) });
const encoder = new TextEncoder();

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    return await handlePost(request, context);
  } catch (error) {
    return Response.json({ code: publicErrorCode(error), error: publicErrorMessage(error) }, { status: 400 });
  }
}

async function handlePost(request: Request, context: { params: Promise<{ id: string }> }) {
  const userId = await getSessionUserId();
  const { id: conversationId } = await context.params;
  const input = InputSchema.parse(await request.json());
  const conversations = await listConversations(userId);
  const conversation = conversations.find((item) => item.id === conversationId);
  if (!conversation) return new Response("这段对话已经不可用，请新建一段对话。", { status: 404 });

  const traceId = crypto.randomUUID();
  const userMessage = await addMessage({ conversationId, userId, role: "user", content: input.content, metadata: { traceId } });
  const riskAssessment = assessRisk(input.content);
  const riskEventId = await recordRiskEvent({ userId, conversationId, messageId: userMessage.id, assessment: riskAssessment });
  if (conversation.messages.length === 0) {
    await enqueueJob({
      userId,
      type: "conversation_title",
      idempotencyKey: `conversation_title:${conversationId}:v1`,
      payload: { conversationId, content: input.content, traceId },
    });
  }

  const gateway = getModelGateway();
  let queryEmbedding: number[] | undefined;
  try {
    const embedded = await gateway.embed([input.content], { signal: request.signal });
    queryEmbedding = embedded.data[0];
    await recordModelCallMeta({ userId, traceId, conversationId, adapterId: gateway.id, meta: embedded.meta });
  } catch {
    await recordTrace({ userId, traceId, stage: "retrieval.degraded", payload: { message: "向量服务不可用，已降级为关键词检索。" } });
  }

  const [messages, profileResult, memoryResult, summary, skillResult] = await Promise.all([
    listMessages(userId, conversationId, 24),
    callMemoryMcp<{ profile: ProfileSnapshot | null }>({ tool: "profile_get_current", userId, traceId }),
    callMemoryMcp<{ memories: MemoryRecord[] }>({ tool: "memory_search", userId, traceId, arguments: { query: input.content, limit: 8, ...(queryEmbedding ? { queryEmbedding } : {}) } }),
    getConversationSummary(userId, conversationId),
    callMemoryMcp<any>({ tool: "personal_skill_get_active", userId, traceId }),
  ]);
  const memories = memoryResult.memories;
  const activeSkill = skillResult.skill;
  const compiled = compileContext({
    foundationInstructions: composeFoundationInstructions(["zhiwei-persona", "dialogue-orchestrator", "fact-and-tool-use", "scientific-answering", "risk-and-boundary", "privacy-and-withdrawal"]),
    personalSkill: activeSkill?.content as PersonalSkill,
    profile: profileResult.profile,
    memories,
    sessionSummary: summary,
    messages,
    maxInputTokens: Math.min(18_000, gateway.capabilities.maxContextTokens - 2_000),
  });

  let factBrief: FactBriefOutput | null = null;
  let scienceMode = false;
  let responsePlan: Pick<FactRoutingOutput, "responseMode" | "depth" | "physicalSymptom" | "reason"> | undefined;
  let verifiedSources: Array<{ title: string; url: string; siteName?: string }> = [];
  if (riskAssessment.level === "ordinary") {
    try {
      const route = await gateway.routeFacts(input.content, { signal: request.signal });
      scienceMode = route.data.scientific;
      responsePlan = {
        responseMode: route.data.responseMode,
        depth: route.data.depth,
        physicalSymptom: route.data.physicalSymptom,
        reason: route.data.reason,
      };
      await recordModelCallMeta({ userId, traceId, conversationId, adapterId: gateway.id, meta: route.meta });
      if (route.data.needsSearch || route.data.scientific) {
        const brief = await gateway.buildFactBrief({ content: input.content, route: route.data }, { signal: request.signal });
        factBrief = brief.data;
        verifiedSources = brief.meta.sources;
        await recordModelCallMeta({ userId, traceId, conversationId, adapterId: gateway.id, meta: brief.meta });
        if (route.data.scientific && factBrief.claims.length) {
          try {
            const audit = await callScienceMcp<any>({
              tool: "science_claim_audit",
              userId,
              traceId,
              arguments: {
                impact: route.data.impact === "high" ? "high" : "medium",
                sources: verifiedSources.map((source) => ({ title: source.title, url: source.url, publisher: source.siteName, kind: "unknown" })),
                claims: factBrief.claims.map((claim) => ({ ...claim, sourceIndices: claim.sourceIndices.map((index) => index - 1) })),
              },
            });
            factBrief = {
              ...factBrief,
              claims: audit.auditedClaims.map((claim: any) => ({
                text: claim.text,
                status: claim.status,
                sourceIndices: claim.sourceIndices.map((index: number) => index + 1),
                note: claim.auditReason ?? claim.note,
              })),
            };
            await recordTrace({ userId, traceId, stage: "science.claims_audited", payload: audit });
          } catch (error) {
            factBrief = { ...factBrief, claims: factBrief.claims.map((claim) => ({ ...claim, status: claim.status === "supported" ? "human_review" as const : claim.status, note: "科学审计工具暂时不可用，未将该主张视为已核实。" })) };
            await recordTrace({ userId, traceId, stage: "science.audit_unavailable", payload: { code: publicErrorCode(error) } });
          }
        }
      }
    } catch (error) {
      responsePlan = conservativeResponsePlan(input.content);
      await recordTrace({ userId, traceId, stage: "fact.verification_unavailable", payload: { code: publicErrorCode(error) } });
    }
  }

  await recordTrace({
    userId,
    traceId,
    stage: "dialogue.context_compiled",
    payload: { gateway: gateway.id, skillVersion: activeSkill?.version, memoryIds: memories.map((memory) => memory.id), riskAssessment, responsePlan, factBrief, compiled },
  });

  const assistantMessageId = crypto.randomUUID();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: StreamEvent) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      let output = "";
      let sources: Array<{ title: string; url: string; siteName?: string }> = [...verifiedSources];
      let completedMeta: any = null;
      let assistantPersisted = false;
      try {
        send({ type: "message.started", messageId: assistantMessageId, traceId });
        if (memories.length) {
          send({ type: "tool.started", name: "memory_search" });
          send({ type: "tool.completed", name: "memory_search" });
        }
        for await (const event of gateway.streamDialogue({
          userId,
          conversationId,
          messageId: userMessage.id,
          content: input.content,
          context: compiled,
          riskAssessment,
          factBrief,
          scienceMode,
          responsePlan,
        }, { signal: request.signal })) {
          if (event.type === "text.delta") {
            output += event.delta;
            send({ type: "text.delta", delta: event.delta });
          }
          if (event.type === "source") sources = uniqueSources([...sources, event.source]);
          if (event.type === "completed") {
            completedMeta = event.meta;
            sources = uniqueSources([...sources, ...event.meta.sources]);
          }
        }
        if (!completedMeta) throw new Error("invalid_response");
        await recordModelCallMeta({ userId, traceId, conversationId, adapterId: gateway.id, meta: completedMeta }).catch(() => undefined);
        const completedDisposition = assistantStreamDisposition(output, "completed");
        if (!completedDisposition.persistAssistant) throw new Error("invalid_response");
        const status = request.signal.aborted ? "stopped" : "completed";
        await addMessage({ id: assistantMessageId, conversationId, userId, role: "assistant", content: output, metadata: { traceId, gateway: gateway.id, status, sources } });
        assistantPersisted = true;
        if (sources.length) await saveMessageSources({ userId, messageId: assistantMessageId, sources }).catch(() => undefined);
        let jobId: string = riskEventId;
        if (completedDisposition.enqueueReflection && status === "completed" && riskAssessment.level === "ordinary") {
          try {
            jobId = await enqueueJob({ userId, type: "reflection", idempotencyKey: `reflection:${userMessage.id}:v1`, payload: { conversationId, messageId: userMessage.id, content: input.content, kind: "chat", traceId } });
          } catch (error) {
            await recordTrace({ userId, traceId, stage: "reflection.enqueue_deferred", payload: { code: publicErrorCode(error), sourceMessageId: userMessage.id } }).catch(() => undefined);
          }
        }
        await recordTrace({ userId, traceId, stage: "dialogue.completed", durationMs: completedMeta?.durationMs, payload: { messageId: assistantMessageId, output, jobId, sources, meta: completedMeta, status } }).catch(() => undefined);
        send({ type: "message.completed", messageId: assistantMessageId, jobId, sources });
        const usedVersionIds = [...new Set(compiled.memories.map((memory) => memory.versionId))].slice(0, 8);
        if (usedVersionIds.length) {
          try {
            await callMemoryMcp({
              tool: "memory_record_usage",
              userId,
              traceId,
              arguments: {
                versionIds: usedVersionIds,
                conversationId,
                idempotencyKey: `memory-usage:${assistantMessageId}`,
              },
            });
          } catch (error) {
            await recordTrace({ userId, traceId, stage: "memory.usage_record_failed", payload: { versionIds: usedVersionIds, code: publicErrorCode(error) } }).catch(() => undefined);
          }
        }
      } catch (error) {
        if (!assistantPersisted && assistantStreamDisposition(output, "interrupted").persistAssistant) {
          await addMessage({ id: assistantMessageId, conversationId, userId, role: "assistant", content: output, metadata: { traceId, gateway: gateway.id, status: request.signal.aborted ? "stopped" : "interrupted", sources } }).catch(() => undefined);
        }
        try {
          send({ type: "error", code: publicErrorCode(error), message: publicErrorMessage(error) });
        } catch {
          // The client may already have closed the stream; persistence is complete.
        }
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" } });
}

function uniqueSources<T extends { url: string }>(sources: T[]) { return [...new Map(sources.map((source) => [source.url, source])).values()]; }
function conservativeResponsePlan(content: string): Pick<FactRoutingOutput, "responseMode" | "depth" | "physicalSymptom" | "reason"> {
  const physicalSymptom = /头晕|眩晕|头痛|头疼|胃痛|胃疼|胸闷|心慌|失眠|睡不着|恶心|发抖|喘不过气/u.test(content);
  const highEmotion = /性压抑|压抑|懋闷|崩溃|撑不住|绝望|特别难过|非常焦虑|好痛苦|一直哭/u.test(content);
  const depth = highEmotion || physicalSymptom
    ? "high" as const
    : /压力|焦虑|难过|委屈|害怕|痛苦|不舒服/u.test(content)
      ? "moderate" as const
      : "light" as const;
  return {
    responseMode: highEmotion || physicalSymptom ? "emotional-deep" : "character",
    depth,
    physicalSymptom,
    reason: "事实路由暂时不可用，已使用本地保守陪伴深度判断。",
  };
}
function publicErrorCode(error: unknown) { const code = error instanceof Error ? error.message : String(error); return ["rate_limited", "provider_unavailable", "invalid_response", "request_cancelled", "provider_authentication_failed"].includes(code) ? code : "generation_failed"; }
function publicErrorMessage(error: unknown) {
  const messages: Record<string, string> = {
    rate_limited: "现在请求有点多，请稍后再试。",
    provider_unavailable: "知微暂时无法回复，请稍后再试。",
    invalid_response: "这次回复没有完整生成，可以重试。",
    request_cancelled: "回复已停止。",
    provider_authentication_failed: "模型服务暂时无法使用，请联系开发者检查配置。",
    generation_failed: "这次回复中断了，可以从这里重试。",
  };
  return messages[publicErrorCode(error)] ?? "回复中断了，可以从这里重试。";
}
