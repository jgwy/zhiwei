import {
  addMessage,
  addUserMessage,
  assessRisk,
  callMemoryMcp,
  callScienceMcp,
  compileContext,
  enqueueJob,
  getConversationSummary,
  getUserTimeZone,
  listConversations,
  listMessages,
  recordModelCallMeta,
  recordRiskEvent,
  recordTrace,
  saveMessageSources,
  updateMessage,
  type ChatMessage,
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
import { getSessionUserId } from "@/lib/session";

const InputSchema = z.object({
  content: z.string().trim().min(1).max(8_000),
  existingMessageId: z.string().uuid().optional(),
  expectedRevision: z.number().int().positive().optional(),
  rewriteDeletedMessageIds: z.array(z.string().uuid()).max(200).optional(),
});
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
  let userMessage: ChatMessage;
  let historyRevision: number;
  if (input.existingMessageId) {
    if (conversation.historyRevision !== input.expectedRevision) throw new Error("对话已经发生变化，请刷新后重试");
    const latest = conversation.messages.at(-1);
    if (!latest || latest.id !== input.existingMessageId || latest.role !== "user" || latest.content !== input.content) {
      throw new Error("编辑后的消息状态已经变化，请刷新后重试");
    }
    userMessage = latest;
    historyRevision = conversation.historyRevision;
  } else {
    const added = await addUserMessage({ conversationId, userId, content: input.content, metadata: { traceId } });
    userMessage = added.message;
    historyRevision = added.historyRevision;
  }
  const riskAssessment = assessRisk(input.content);
  const riskEventId = await recordRiskEvent({ userId, conversationId, messageId: userMessage.id, assessment: riskAssessment });
  if (conversation.messages.length === 0 || (input.existingMessageId && userMessage.sequence === 1 && !conversation.titleLocked)) {
    await enqueueJob({
      userId,
      type: "conversation_title",
      idempotencyKey: `conversation_title:${conversationId}:r${historyRevision}`,
      payload: { conversationId, content: input.content, traceId, historyRevision },
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

  const [messages, profileResult, memoryResult, summary, skillResult, timeZone] = await Promise.all([
    listMessages(userId, conversationId, 24),
    callMemoryMcp<{ profile: ProfileSnapshot | null }>({ tool: "profile_get_current", userId, traceId }),
    callMemoryMcp<{ memories: MemoryRecord[] }>({ tool: "memory_search", userId, traceId, arguments: { query: input.content, limit: 8, ...(queryEmbedding ? { queryEmbedding } : {}) } }),
    getConversationSummary(userId, conversationId),
    callMemoryMcp<any>({ tool: "personal_skill_get_active", userId, traceId }),
    getUserTimeZone(userId),
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
    timeZone,
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
      await recordTrace({ userId, traceId, stage: "fact.verification_unavailable", payload: { code: publicErrorCode(error) } });
    }
  }

  await recordTrace({
    userId,
    traceId,
    stage: "dialogue.context_compiled",
    payload: { gateway: gateway.id, skillVersion: activeSkill?.version, memoryIds: memories.map((memory) => memory.id), riskAssessment, responsePlan, factBrief, compiled },
  });

  const assistantMessage = await addMessage({
    conversationId,
    userId,
    role: "assistant",
    content: "",
    metadata: { traceId, gateway: gateway.id, status: "streaming" },
  });
  const assistantMessageId = assistantMessage.id;
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: StreamEvent) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      let output = "";
      let sources: Array<{ title: string; url: string; siteName?: string }> = [...verifiedSources];
      let completedMeta: any = null;
      try {
        if (input.existingMessageId) {
          send({
            type: "conversation.rewritten",
            message: userMessage,
            deletedMessageIds: input.rewriteDeletedMessageIds ?? [],
            historyRevision,
          });
        }
        send({
          type: "message.started",
          messageId: assistantMessageId,
          traceId,
          createdAt: assistantMessage.createdAt,
          sequence: assistantMessage.sequence,
          historyRevision,
          userMessage,
        });
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
        const status = request.signal.aborted ? "stopped" : "completed";
        await updateMessage({ id: assistantMessageId, userId, content: output, metadata: { traceId, gateway: gateway.id, status, sources } });
        if (sources.length) await saveMessageSources({ userId, messageId: assistantMessageId, sources });
        if (completedMeta) await recordModelCallMeta({ userId, traceId, conversationId, adapterId: gateway.id, meta: completedMeta });
        const jobId = riskAssessment.level === "ordinary"
          ? await enqueueJob({
              userId,
              type: "reflection",
              idempotencyKey: `reflection:${userMessage.id}:r${historyRevision}:e${userMessage.editCount ?? 0}`,
              payload: {
                conversationId,
                messageId: userMessage.id,
                content: input.content,
                kind: "chat",
                traceId,
                historyRevision,
                editCount: userMessage.editCount ?? 0,
              },
            })
          : riskEventId;
        await recordTrace({ userId, traceId, stage: "dialogue.completed", durationMs: completedMeta?.durationMs, payload: { messageId: assistantMessageId, output, jobId, sources, meta: completedMeta, status } });
        send({ type: "message.completed", messageId: assistantMessageId, jobId, sources });
      } catch (error) {
        await updateMessage({ id: assistantMessageId, userId, content: output, metadata: { traceId, gateway: gateway.id, status: request.signal.aborted ? "stopped" : "interrupted", sources } });
        send({ type: "error", code: publicErrorCode(error), message: publicErrorMessage(error) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" } });
}

function uniqueSources<T extends { url: string }>(sources: T[]) { return [...new Map(sources.map((source) => [source.url, source])).values()]; }
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
