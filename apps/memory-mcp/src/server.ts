import { createServer } from "node:http";
import {
  DimensionWeightsSchema,
  MemoryConsolidationInputSchema,
  MemoryEmbeddingInputSchema,
  MemoryListInputSchema,
  MemoryReflectionCommitSchema,
  MemoryRestoreInputSchema,
  MemorySearchInputSchema,
  MemoryUsageInputSchema,
  MemoryWithdrawInputSchema,
  PersonalSkillSchema,
  commitMemoryConsolidation,
  commitProfileSnapshot,
  commitReflection,
  assertUserExists,
  getActiveSkill,
  getProfileForContext,
  getReflectionControlState,
  getLatestProfile,
  listMemoriesForUser,
  publishPersonalSkill,
  recordMcpCall,
  recordMemoryUsage,
  resolveSecret,
  restoreMemoryVersion,
  searchMemories,
  setMemoryEmbedding,
  withdrawMemory,
  MCP_PROTOCOL_VERSION,
  completeMcpResult,
  mcpRpcError as rpcError,
  mcpRpcResult as rpcResult,
  mcpToolResult,
  readMcpBody as readBody,
  recordMcpAudit,
  sendMcpJson as sendJson,
} from "@zhiwei/core";
import { z } from "zod";

const port = Number(process.env.MCP_PORT ?? 4100);
const token = resolveSecret("INTERNAL_MCP_TOKEN", "local-development-mcp-token");
const protocolVersion = MCP_PROTOCOL_VERSION;
const serverInfo = { name: "zhiwei-memory-mcp", version: "0.2.0" };

const toolSchemas = {
  memory_search: MemorySearchInputSchema,
  memory_list: MemoryListInputSchema,
  memory_commit_reflection: z.object({
    conversationId: z.string().uuid(),
    sourceMessageId: z.string().uuid(),
    sourceMessageIds: z.array(z.string().uuid()).max(3).optional(),
    expectedMutationCursor: z.number().int().nonnegative().optional(),
    summaryEvidenceMessageIds: z.array(z.string().uuid()).max(3).optional(),
    reflection: MemoryReflectionCommitSchema,
    embeddings: z.array(z.array(z.number()).length(1024).nullable()).max(3).optional(),
    idempotencyKey: z.string().trim().min(8).max(200),
  }),
  memory_withdraw: MemoryWithdrawInputSchema,
  memory_record_usage: MemoryUsageInputSchema,
  memory_set_embedding: MemoryEmbeddingInputSchema,
  memory_commit_consolidation: MemoryConsolidationInputSchema,
  memory_restore_version: MemoryRestoreInputSchema,
  profile_get_current: z.object({ forDisplay: z.boolean().optional() }),
  profile_commit_snapshot: z.object({
    summary: z.string().min(1).max(1_600),
    dimensionWeights: DimensionWeightsSchema,
    sourceMemoryVersionIds: z.array(z.string().uuid()).max(1_000)
      .refine((ids) => new Set(ids).size === ids.length, "来源版本不能重复"),
    schemaVersion: z.string().trim().min(1).max(80),
    idempotencyKey: z.string().trim().min(8).max(200),
  }),
  personal_skill_get_active: z.object({}),
  personal_skill_publish_rewrite: z.object({
    skill: PersonalSkillSchema,
    idempotencyKey: z.string().trim().min(8).max(200).optional(),
  }),
} as const;

const server = createServer(async (request, response) => {
  let requestId: unknown = null;
  try {
    if (request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, service: "zhiwei-memory-mcp" }));
      return;
    }
    if (request.url !== "/mcp" || request.method !== "POST") {
      sendJson(response, 404, { error: "not_found" });
      return;
    }
    if (request.headers.authorization !== `Bearer ${token}`) {
      sendJson(response, 401, rpcError(null, -32001, "unauthorized"));
      return;
    }
    if (request.headers["mcp-protocol-version"] !== protocolVersion) {
      sendJson(response, 400, {
        ...rpcError(null, -32022, "unsupported_protocol_version"),
        supported: [protocolVersion],
      });
      return;
    }
    const origin = request.headers.origin;
    if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      sendJson(response, 403, rpcError(null, -32002, "origin_not_allowed"));
      return;
    }

    const body = JSON.parse(await readBody(request));
    requestId = body.id ?? null;
    const methodHeader = request.headers["mcp-method"];
    if (methodHeader !== body.method) {
      sendJson(response, 400, rpcError(body.id ?? null, -32600, "Mcp-Method 与请求体不一致"));
      return;
    }

    if (body.method === "server/discover") {
      sendJson(response, 200, rpcResult(body.id, completeMcpResult(serverInfo, {
        supportedVersions: [protocolVersion],
        capabilities: { tools: {} },
        ttlMs: 300_000,
        cacheScope: "private",
      })));
      return;
    }

    if (body.method === "tools/list") {
      const developerCaller = request.headers["x-zhiwei-role"] === "developer" && process.env.DEV_MODE === "true";
      sendJson(response, 200, rpcResult(body.id, completeMcpResult(serverInfo, {
        tools: Object.entries(toolSchemas).filter(([name]) => name !== "memory_restore_version" || developerCaller).map(([name, schema]) => ({
          name,
          description: toolDescription(name),
          inputSchema: z.toJSONSchema(schema),
        })),
        ttlMs: 300_000,
        cacheScope: "private",
      })));
      return;
    }

    if (body.method !== "tools/call") {
      sendJson(response, 400, rpcError(body.id ?? null, -32601, "method_not_found"));
      return;
    }

    const toolName = body.params?.name as keyof typeof toolSchemas;
    if (request.headers["mcp-name"] !== toolName) {
      sendJson(response, 400, rpcError(body.id ?? null, -32600, "Mcp-Name 与请求体不一致"));
      return;
    }
    const userId = request.headers["x-zhiwei-user"];
    if (typeof userId !== "string" || !z.string().uuid().safeParse(userId).success) {
      sendJson(response, 400, rpcError(body.id ?? null, -32602, "缺少有效的用户范围"));
      return;
    }
    const schema = toolSchemas[toolName];
    if (!schema) {
      sendJson(response, 404, rpcError(body.id ?? null, -32602, "unknown_tool"));
      return;
    }
    if (toolName === "memory_restore_version" && (
      request.headers["x-zhiwei-role"] !== "developer"
      || process.env.DEV_MODE !== "true"
    )) {
      sendJson(response, 403, rpcError(body.id ?? null, -32003, "developer_scope_required"));
      return;
    }
    await assertUserExists(userId);
    const args = schema.parse(body.params?.arguments ?? {}) as any;
    const started = Date.now();
    const traceId = typeof request.headers.traceparent === "string" ? request.headers.traceparent : undefined;
    const result = await invokeTool(toolName, userId, args, traceId);
    await recordMcpAudit("Memory MCP", () => recordMcpCall({
        userId,
        traceId,
        toolName,
        arguments: args,
        result: result as Record<string, unknown>,
        durationMs: Date.now() - started,
    }));
    sendJson(response, 200, rpcResult(body.id, mcpToolResult(serverInfo, result)));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const invalid = error instanceof z.ZodError || error instanceof SyntaxError;
    const conflict = [
      "memory_version_conflict",
      "memory_idempotency_conflict",
      "memory_profile_source_conflict",
      "memory_stale_after_withdrawal",
    ].includes(message);
    sendJson(
      response,
      invalid ? 400 : conflict ? 409 : 500,
      rpcError(requestId, invalid ? -32602 : conflict ? -32009 : -32603, message),
    );
  }
});

server.listen(port, "0.0.0.0", () => {
  process.stdout.write(`Memory MCP listening on ${port}\n`);
});

async function invokeTool(tool: keyof typeof toolSchemas, userId: string, args: any, traceId?: string) {
  switch (tool) {
    case "memory_search": {
      const memories=await searchMemories(userId,args.query,args.limit,args.queryEmbedding,args.purpose);
      return {memories,...(args.purpose==="reflection"?await getReflectionControlState(userId,args.query,args.afterEvidenceAt):{})};
    }
    case "memory_list":
      return { memories: await listMemoriesForUser(userId, args) };
    case "memory_commit_reflection":
      return commitReflection({ userId, traceId, ...args });
    case "memory_withdraw":
      return withdrawMemory({ userId, traceId, ...args });
    case "memory_record_usage":
      return recordMemoryUsage({ userId, traceId, ...args });
    case "memory_set_embedding":
      return setMemoryEmbedding({ userId, traceId, ...args });
    case "memory_commit_consolidation":
      return commitMemoryConsolidation({ userId, traceId, ...args });
    case "memory_restore_version":
      return restoreMemoryVersion({ userId, traceId, ...args });
    case "profile_get_current":
      return { profile: await (args.forDisplay ? getLatestProfile(userId) : getProfileForContext(userId)) };
    case "profile_commit_snapshot":
      return { profile: await commitProfileSnapshot({ userId, ...args }) };
    case "personal_skill_get_active":
      return { skill: await getActiveSkill(userId) };
    case "personal_skill_publish_rewrite":
      return {
        version: await publishPersonalSkill({ userId, skill: args.skill, source: "model", idempotencyKey: args.idempotencyKey }),
      };
  }
}

function toolDescription(name: string): string {
  const descriptions: Record<string, string> = {
    memory_search: "检索当前用户已授权的活动记忆：对话最多八条，后台反思候选最多十二条。",
    memory_list: "按层级和状态列出当前用户自己的记忆版本。",
    memory_commit_reflection: "以幂等方式提交模型生成的记忆动作和会话观察。",
    memory_withdraw: "按记忆和版本撤回当前活动认识。",
    memory_record_usage: "记录实际进入一次回答上下文的记忆版本。",
    memory_set_embedding: "为仍处于活动状态的记忆版本补写向量。",
    memory_commit_consolidation: "在核对通过后原子提交长期记忆收拢结果。",
    memory_restore_version: "开发者将一个历史版本复制为新的活动版本。",
    profile_get_current: "读取与当前长期记忆版本严格同步的画像快照。",
    profile_commit_snapshot: "提交带完整来源版本的长期画像综述与了解度快照。",
    personal_skill_get_active: "读取当前用户正在生效的个人 Skill。",
    personal_skill_publish_rewrite: "发布模型重写的完整个人 Skill，并立即激活新版本。",
  };
  return descriptions[name] ?? name;
}
