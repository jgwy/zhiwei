import {
  callMemoryMcp,
  callScienceMcp,
  compileContext,
  enqueueJob,
  finishReplyAttempt,
  getConversationSummary,
  listMessagesThrough,
  recordModelCallMeta,
  recordTrace,
  saveMessageSources,
  type FactBriefOutput,
  type FactRoutingOutput,
  type MemoryRecord,
  type ModelCallMeta,
  type ModelSource,
  type PersonalSkill,
  type ProfileSnapshot,
  type StreamEvent,
  type TurnAccepted,
} from "@zhiwei/core";
import { getModelGateway } from "@zhiwei/model-gateway";
import { composeFoundationInstructions } from "@zhiwei/skills";

const encoder = new TextEncoder();
export function streamAcceptedTurn(
  request: Request,
  userId: string,
  conversationId: string,
  turn: TurnAccepted,
  retry = false,
) {
  const cancellation = new AbortController();
  const signal = AbortSignal.any([request.signal, cancellation.signal]);
  const assistant = turn.assistant!;
  const { userMessage, traceId } = turn;
  const startedAt=Date.now();
  let preparationMs=0;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let output = "";
      let sources: ModelSource[] = [];
      let gateway: ReturnType<typeof getModelGateway> | undefined;
      const send = (event: StreamEvent) =>
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
        );
      const phase = (stage: string, message: string) =>
        send({ type: "phase", stage, message });
      const trace = (stage: string, payload: Record<string, unknown>) =>
        recordTrace({ userId, traceId, stage, payload }).catch(() => undefined);
      const record = (meta: ModelCallMeta) =>
        recordModelCallMeta({
          userId,
          traceId,
          conversationId,
          adapterId: gateway?.id ?? meta.provider,
          meta:meta.task === "dialogue" && meta.firstDeltaMs !== undefined ? {...meta,firstDeltaMs:preparationMs+meta.firstDeltaMs} : meta,
        }).catch(() => undefined);
      const failedCall = async (error: unknown) => {
        const meta = (error as { modelMeta?: ModelCallMeta })?.modelMeta;
        if (meta) await record(meta);
      };
      try {
        send({
          type: "message.started",
          messageId: assistant.id,
          traceId,
          userMessage,
        });
        phase("context", "正在整理这段对话…");
        gateway = getModelGateway();
        const ordinary = turn.riskAssessment.level === "ordinary";
        const messagesPromise=listMessagesThrough(userId,conversationId,userMessage.id,24);
        const embedded = (async () => {
          if (!ordinary) return undefined;
          try {
            const result = await gateway!.embed([userMessage.content], {
              signal,
            });
            await record(result.meta);
            return result.data[0];
          } catch (error) {
            await failedCall(error);
            if (signal.aborted) throw error;
            await trace("retrieval.degraded", {
              message: "向量服务不可用，已改用关键词检索。",
            });
            return undefined;
          }
        })();
        const routing = (async () => {
          if (!ordinary) return null;
          try {
            const result = await gateway!.routeFacts(userMessage.content, {
              signal, recentMessages:await messagesPromise,
            });
            await record(result.meta);
            return result.data;
          } catch (error) {
            await failedCall(error);
            if (signal.aborted) throw error;
            await trace("fact.verification_unavailable", {
              code: dialogueErrorCode(error),
            });
            return null;
          }
        })();
        const memoryPromise = embedded.then((queryEmbedding) =>
          callMemoryMcp<{ memories: MemoryRecord[] }>({
            tool: "memory_search",
            userId,
            traceId,
            signal,
            arguments: {
              query: userMessage.content.slice(0, 1000),
              limit: 8,
              ...(queryEmbedding ? { queryEmbedding } : {}),
            },
          }),
        );
        const [
          messages,
          profileResult,
          skillResult,
          summary,
          memoryResult,
          route,
        ] = await Promise.all([
          messagesPromise,
          callMemoryMcp<{ profile: ProfileSnapshot | null }>({
            tool: "profile_get_current",
            userId,
            traceId,
            signal,
          }),
          callMemoryMcp<{ skill: { content: PersonalSkill; version: number } }>(
            { tool: "personal_skill_get_active", userId, traceId, signal },
          ),
          getConversationSummary(userId, conversationId),
          memoryPromise,
          routing,
        ]);
        const compiled = compileContext({
          foundationInstructions: composeFoundationInstructions([
            "zhiwei-persona",
            "dialogue-orchestrator",
            "fact-and-tool-use",
            "scientific-answering",
            "risk-and-boundary",
            "privacy-and-withdrawal",
          ]),
          personalSkill: skillResult.skill.content,
          profile: profileResult.profile,
          memories: memoryResult.memories,
          sessionSummary: summary,
          messages,
          maxInputTokens: Math.min(
            18_000,
            gateway.capabilities.maxContextTokens - 2_000,
          ),
        });
        let factBrief: FactBriefOutput | null = null;
        if (route && (route.needsSearch || route.scientific)) {
          phase("verification", "正在核对相关事实与来源…");
          try {
            const brief = await gateway.buildFactBrief(
              { content: userMessage.content, route },
              { signal },
            );
            await record(brief.meta);
            factBrief = brief.data;
            sources = brief.meta.sources;
            if (route.scientific && factBrief.claims.length) {
              try {
                const audit = await callScienceMcp<any>({
                  tool: "science_claim_audit",
                  userId,
                  traceId,
                  signal,
                  arguments: {
                    impact: route.impact === "high" ? "high" : "medium",
                    sources: sources.map((source) => ({
                      title: source.title,
                      url: source.url,
                      publisher: source.siteName,
                      kind: "unknown",
                    })),
                    claims: factBrief.claims.map((claim) => ({
                      ...claim,
                      sourceIndices: claim.sourceIndices.map(
                        (index) => index - 1,
                      ),
                    })),
                  },
                });
                factBrief = {
                  ...factBrief,
                  claims: audit.auditedClaims.map((claim: any) => ({
                    text: claim.text,
                    status: claim.status,
                    sourceIndices: claim.sourceIndices.map(
                      (index: number) => index + 1,
                    ),
                    note: claim.auditReason ?? claim.note,
                  })),
                };
                await trace("science.claims_audited", audit);
              } catch (error) {
                if (signal.aborted) throw error;
                factBrief = {
                  ...factBrief,
                  claims: factBrief.claims.map((claim) => ({
                    ...claim,
                    status:
                      claim.status === "supported"
                        ? "human_review"
                        : claim.status,
                    note: "科学审计暂时不可用，未将此主张视为已核实。",
                  })),
                };
                await trace("science.audit_unavailable", {
                  code: dialogueErrorCode(error),
                });
              }
            }
          } catch (error) {
            await failedCall(error);
            if (signal.aborted) throw error;
            await trace("fact.verification_unavailable", {
              code: dialogueErrorCode(error),
            });
          }
        }
        const responsePlan =
          route ?? conservativeResponsePlan(userMessage.content);
        await trace("dialogue.context_compiled", {
          compiled,
          memoryIds: compiled.memories.map((memory) => memory.id),
          riskAssessment: turn.riskAssessment,
          responsePlan,
          factBrief,
          skillVersion: skillResult.skill.version,
        });
        phase("generation", "正在回应你…");
        preparationMs=Date.now()-startedAt;
        await trace("dialogue.preparation.completed",{durationMs:preparationMs});
        let completion: ModelCallMeta | undefined;
        for await (const event of gateway.streamDialogue(
          {
            userId,
            conversationId,
            messageId: userMessage.id,
            content: userMessage.content,
            context: compiled,
            riskAssessment: turn.riskAssessment,
            factBrief,
            scienceMode: route?.scientific ?? false,
            responsePlan,
          },
          { signal },
        )) {
          if (signal.aborted) throw signal.reason;
          if (event.type === "text.delta") {
            output += event.delta;
            send({ type: "text.delta", delta: event.delta });
          }
          if (event.type === "source")
            sources = uniqueSources([...sources, event.source]);
          if (event.type === "completed") {
            completion = event.meta;
            sources = uniqueSources([...sources, ...event.meta.sources]);
          }
        }
        if (!completion || !output.trim()) throw new Error("invalid_response");
        await record(completion);
        await finishReplyAttempt({
          userId,
          messageId: assistant.id,
          content: output,
          metadata: {
            traceId,
            status: "completed",
            streaming: false,
            gateway: gateway.id,
            sources,
          },
        });
        await saveMessageSources({
          userId,
          messageId: assistant.id,
          sources,
        }).catch(() => undefined);
        await trace("dialogue.completed", {
          messageId: assistant.id,
          output,
          jobId: turn.jobId,
          sources,
          meta: completion,
        });
        send({
          type: "message.completed",
          messageId: assistant.id,
          jobId: turn.jobId,
          sources,
          status: "completed",
        });
        const versionIds = compiled.memories.map((memory) => memory.versionId);
        if (versionIds.length)
          await callMemoryMcp({
            tool: "memory_record_usage",
            userId,
            traceId,
            arguments: {
              versionIds,
              conversationId,
              idempotencyKey: `memory-usage:${assistant.id}`,
            },
          }).catch(() => undefined);
        if (retry)
          await enqueueJob({
            userId,
            type: "session_summary",
            idempotencyKey: `retry-summary:${assistant.id}`,
            payload: {
              conversationId,
              sourceMessageId: userMessage.id,
              throughMessageId: assistant.id,
              traceId,
            },
          }).catch(() => undefined);
      } catch (error) {
        await failedCall(error);
        const status = signal.aborted ? "stopped" : "interrupted";
        await finishReplyAttempt({
          userId,
          messageId: assistant.id,
          content: output,
          metadata: { traceId, status, streaming: false, sources },
        }).catch(() => undefined);
        await trace("dialogue.failed", {
          messageId: assistant.id,
          status,
          code: dialogueErrorCode(error),
          output,
        });
        try {
          send({
            type: "error",
            code: signal.aborted
              ? "request_cancelled"
              : dialogueErrorCode(error),
            message: signal.aborted
              ? "回复已停止。"
              : dialogueErrorMessage(error),
          });
        } catch {
          /* Client cancellation already closed the transport. */
        }
      } finally {
        try {
          controller.close();
        } catch {
          /* Already cancelled. */
        }
      }
    },
    cancel() {
      cancellation.abort(new DOMException("回复已停止", "AbortError"));
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}

function uniqueSources(sources: ModelSource[]) {
  return [...new Map(sources.map((source) => [source.url, source])).values()];
}
function conservativeResponsePlan(
  content: string,
): Pick<
  FactRoutingOutput,
  "responseMode" | "depth" | "physicalSymptom" | "reason"
> {
  const physicalSymptom =
    /头晕|眩晕|头痛|头疼|胃痛|胸闷|心慌|失眠|恶心|喘不过气/u.test(content);
  const highEmotion = /性压抑|压抑|崩溃|撑不住|绝望|好痛苦|一直哭/u.test(
    content,
  );
  return {
    responseMode:
      physicalSymptom || highEmotion ? "emotional-deep" : "character",
    depth: physicalSymptom || highEmotion ? "high" : "moderate",
    physicalSymptom,
    reason: "路由暂时不可用，采用保守的陪伴深度。",
  };
}
export function dialogueErrorCode(error: unknown) {
  const code = error instanceof Error ? error.message : String(error);
  return [
    "rate_limited",
    "provider_unavailable",
    "invalid_response",
    "request_cancelled",
    "provider_authentication_failed",
    "timeout",
    "stream_interrupted",
  ].includes(code)
    ? code
    : "generation_failed";
}
export function dialogueErrorMessage(error: unknown) {
  const messages: Record<string, string> = {
    rate_limited: "现在请求有点多，请稍后再试。",
    provider_unavailable: "知微暂时无法回复，请稍后再试。",
    invalid_response: "这次回复没有完整生成，可以重试。",
    request_cancelled: "回复已停止。",
    timeout: "这次等待有点久，回复已中断，可以重试。",
    stream_interrupted: "回复中断了，可以从这里重试。",
    provider_authentication_failed: "模型服务暂时无法使用，请检查配置。",
  };
  return messages[dialogueErrorCode(error)] ?? "回复中断了，可以从这里重试。";
}
