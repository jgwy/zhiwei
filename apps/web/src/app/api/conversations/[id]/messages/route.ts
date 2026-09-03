import {
  addMessage,
  addUserMessageWithReflectionJob,
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
import { getSessionUserId } from "@/lib/session";
import { addNoDbMessage, commitNoDbMemories, isNoDbMode, listNoDbConversations, listNoDbMemories, recallNoDbMemories } from "@/lib/no-db-store";
import { isPersonalDisclosure, isPotentialMemoryQuery, resolveMemoryQuery } from "@/lib/message-routing";

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
  if (isNoDbMode()) return handleNoDbPost(request, context);
  const userId = await getSessionUserId();
  const { id: conversationId } = await context.params;
  const input = InputSchema.parse(await request.json());
  const conversations = await listConversations(userId);
  const conversation = conversations.find((item) => item.id === conversationId);
  if (!conversation) return new Response("这段对话已经不可用，请新建一段对话。", { status: 404 });

  const traceId = crypto.randomUUID();
  const riskAssessment = assessRisk(input.content);
  let reflectionJobId: string | null = null;
  let userMessage: Awaited<ReturnType<typeof addMessage>>;
  if (riskAssessment.level === "ordinary") {
    const persisted = await addUserMessageWithReflectionJob({ conversationId, userId, content: input.content, traceId });
    userMessage = persisted.message;
    reflectionJobId = persisted.jobId;
  } else {
    userMessage = await addMessage({ conversationId, userId, role: "user", content: input.content, metadata: { traceId } });
  }
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

  const potentialMemoryQuery = isPotentialMemoryQuery(input.content);
  const [messages, profileResult, memoryResult, summary, skillResult] = await Promise.all([
    listMessages(userId, conversationId, 24),
    callMemoryMcp<{ profile: ProfileSnapshot | null }>({ tool: "profile_get_current", userId, traceId }),
    callMemoryMcp<{ memories: MemoryRecord[] }>({
      tool: "memory_search",
      userId,
      traceId,
      arguments: {
        query: input.content,
        limit: 8,
        conversationId,
        recordUsage: true,
        includePending: potentialMemoryQuery,
        ...(queryEmbedding ? { queryEmbedding } : {}),
      },
    }),
    getConversationSummary(userId, conversationId),
    callMemoryMcp<any>({ tool: "personal_skill_get_active", userId, traceId }),
  ]);
  const retrievedMemories = memoryResult.memories;
  const memories = retrievedMemories.filter((memory) => (memory.status ?? "active") === "active");
  const memoryResolution = resolveMemoryQuery(input.content, retrievedMemories);
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
  if (riskAssessment.level === "ordinary" && !memoryResolution && !isPersonalDisclosure(input.content)) {
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
      if (route.data.needsSearch) {
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

  if (memoryResolution || isPersonalDisclosure(input.content)) {
    await recordTrace({
      userId,
      traceId,
      stage: memoryResolution ? "memory.query_resolved" : "fact.routing_skipped",
      payload: memoryResolution
        ? { state: memoryResolution.state, memoryIds: memoryResolution.memoryIds }
        : { reason: "personal_disclosure" },
    });
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
      try {
        send({ type: "message.started", messageId: assistantMessageId, traceId });
        if (memories.length) {
          send({ type: "tool.started", name: "memory_search" });
          send({ type: "tool.completed", name: "memory_search" });
        }
        if (memoryResolution) {
          output = memoryResolution.answer;
          send({ type: "text.delta", delta: output });
        } else {
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
        }
        const status = request.signal.aborted ? "stopped" : "completed";
        await addMessage({ id: assistantMessageId, conversationId, userId, role: "assistant", content: output, metadata: { traceId, gateway: gateway.id, status, sources } });
        if (sources.length) await saveMessageSources({ userId, messageId: assistantMessageId, sources });
        if (completedMeta) await recordModelCallMeta({ userId, traceId, conversationId, adapterId: gateway.id, meta: completedMeta });
        const jobId = reflectionJobId ?? riskEventId;
        await recordTrace({ userId, traceId, stage: "dialogue.completed", durationMs: completedMeta?.durationMs, payload: { messageId: assistantMessageId, output, jobId, sources, meta: completedMeta, status } });
        send({ type: "message.completed", messageId: assistantMessageId, jobId, sources });
      } catch (error) {
        if (output) {
          await addMessage({ id: assistantMessageId, conversationId, userId, role: "assistant", content: output, metadata: { traceId, gateway: gateway.id, status: request.signal.aborted ? "stopped" : "interrupted", sources } });
        }
        send({ type: "error", code: publicErrorCode(error), message: publicErrorMessage(error) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" } });
}

async function handleNoDbPost(request: Request, context: { params: Promise<{ id: string }> }) {
  const userId = "local-user";
  const { id: conversationId } = await context.params;
  const input = InputSchema.parse(await request.json());
  const conversation = listNoDbConversations().find((item) => item.id === conversationId);
  if (!conversation) return new Response("这段对话已经不可用，请新建一段对话。", { status: 404 });

  const traceId = crypto.randomUUID();
  const userMessage = addNoDbMessage(conversationId, "user", input.content, { traceId });
  const riskAssessment = assessRisk(input.content);
  const gateway = getModelGateway();
  const recalledMemories = recallNoDbMemories(conversationId, input.content);
  const memoryResolution = resolveMemoryQuery(input.content, listNoDbMemories());
  const compiled = compileContext({
    foundationInstructions: composeFoundationInstructions(["zhiwei-persona", "dialogue-orchestrator", "risk-and-boundary", "privacy-and-withdrawal"]),
    personalSkill: undefined as never,
    profile: null,
    memories: recalledMemories,
    sessionSummary: null,
    messages: conversation.messages,
    maxInputTokens: Math.min(18_000, gateway.capabilities.maxContextTokens - 2_000),
  });
  const assistantMessageId = crypto.randomUUID();
  const reflectionPromise = gateway.reflect({
    userId,
    conversationId,
    messageId: userMessage.id,
    content: input.content,
    context: compiled,
    riskAssessment,
    kind: "chat",
  }).then((reflection) => {
    commitNoDbMemories({
      mutations: reflection.data.memories,
      sourceText: input.content,
      sourceMessageId: userMessage.id,
      conversationId,
    });
  }).catch(() => undefined);
  void reflectionPromise;
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: StreamEvent) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      let output = "";
      try {
        send({ type: "message.started", messageId: assistantMessageId, traceId });
        if (memoryResolution) {
          output = memoryResolution.answer;
          send({ type: "text.delta", delta: output });
        } else {
          for await (const event of gateway.streamDialogue({
            userId,
            conversationId,
            messageId: userMessage.id,
            content: input.content,
            context: compiled,
            riskAssessment,
          }, { signal: request.signal })) {
            if (event.type === "text.delta") {
              output += event.delta;
              send({ type: "text.delta", delta: event.delta });
            }
          }
        }
        addNoDbMessage(conversationId, "assistant", output, { traceId, gateway: gateway.id, status: "completed" }, assistantMessageId);
        send({ type: "message.completed", messageId: assistantMessageId, jobId: `no-db:${assistantMessageId}`, sources: [] });
      } catch (error) {
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
