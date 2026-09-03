import { createServer } from "node:http";
import {
  MemoryConfirmInputSchema,
  MemoryRejectInputSchema,
  MemorySearchInputSchema,
  MemoryUsageInputSchema,
  MemoryWithdrawInputSchema,
  PersonalSkillSchema,
  ReflectionOutputSchema,
  confirmMemory,
  commitProfileSnapshot,
  commitReflection,
  ensureUser,
  getActiveSkill,
  getProfileForContext,
  listMemoriesForUser,
  publishPersonalSkill,
  recordMcpCall,
  recordMemoryUsage,
  rejectMemory,
  searchMemories,
  withdrawMemory,
} from "@zhiwei/core";
import { z } from "zod";

const port = Number(process.env.MCP_PORT ?? 4100);
const token = process.env.INTERNAL_MCP_TOKEN ?? "local-development-mcp-token";

const toolSchemas = {
  memory_search: MemorySearchInputSchema,
  memory_list: z.object({}),
  memory_commit_reflection: z.object({
    conversationId: z.string().uuid(),
    sourceMessageId: z.string().uuid(),
    reflection: ReflectionOutputSchema,
    embeddings: z.array(z.array(z.number()).length(1024).nullable()).max(12).optional(),
    idempotencyKey: z.string().trim().min(8).max(200),
  }),
  memory_confirm: MemoryConfirmInputSchema,
  memory_reject: MemoryRejectInputSchema,
  memory_withdraw: MemoryWithdrawInputSchema,
  memory_record_usage: MemoryUsageInputSchema,
  profile_get_current: z.object({}),
  profile_commit_snapshot: z.object({
    summary: z.string().min(1).max(1_600),
    dimensionWeights: z.record(z.string(), z.number()),
    idempotencyKey: z.string().trim().min(8).max(200).optional(),
  }),
  personal_skill_get_active: z.object({}),
  personal_skill_publish_rewrite: z.object({ skill: PersonalSkillSchema }),
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
      sendJson(response, 200, rpcResult(body.id, {
        protocolVersion: "2026-07-28",
        serverInfo: { name: "zhiwei-memory-mcp", version: "0.1.0" },
        capabilities: { tools: {} },
      }));
      return;
    }

    if (body.method === "tools/list") {
      sendJson(response, 200, rpcResult(body.id, {
        tools: Object.entries(toolSchemas).map(([name, schema]) => ({
          name,
          description: toolDescription(name),
          inputSchema: z.toJSONSchema(schema),
        })),
        ttlMs: 300_000,
        cacheScope: "global",
      }));
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
    await ensureUser(userId);
    const args = schema.parse(body.params?.arguments ?? {}) as any;
    const started = Date.now();
    const traceId = typeof request.headers.traceparent === "string" ? request.headers.traceparent : undefined;
    const result = await invokeTool(toolName, userId, args, traceId);
    try {
      await recordMcpCall({
        userId,
        traceId,
        toolName,
        arguments: args,
        result: result as Record<string, unknown>,
        durationMs: Date.now() - started,
      });
    } catch (auditError) {
      process.stderr.write(`Memory MCP audit log failed: ${auditError instanceof Error ? auditError.message : String(auditError)}\n`);
    }
    sendJson(response, 200, rpcResult(body.id, result));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const conflict = message === "memory_version_conflict"
      || message === "memory_pending_conflict"
      || message === "memory_idempotency_conflict";
    sendJson(response, conflict ? 409 : 500, rpcError(requestId, conflict ? -32009 : -32603, message));
  }
});

server.listen(port, "0.0.0.0", () => {
  process.stdout.write(`Memory MCP listening on ${port}\n`);
});

async function invokeTool(tool: keyof typeof toolSchemas, userId: string, args: any, traceId?: string) {
  switch (tool) {
    case "memory_search":
      return { memories: await searchMemories(userId, args.query, args.limit, args.queryEmbedding, { conversationId: args.conversationId }) };
    case "memory_list":
      return { memories: await listMemoriesForUser(userId) };
    case "memory_commit_reflection":
      return commitReflection({ userId, traceId, ...args });
    case "memory_confirm":
      return confirmMemory({ userId, traceId, ...args });
    case "memory_reject":
      return rejectMemory({ userId, traceId, ...args });
    case "memory_withdraw":
      return withdrawMemory({ userId, traceId, ...args });
    case "memory_record_usage":
      return recordMemoryUsage({ userId, traceId, ...args });
    case "profile_get_current":
      return { profile: await getProfileForContext(userId) };
    case "profile_commit_snapshot":
      return { profile: await commitProfileSnapshot({ userId, ...args }) };
    case "personal_skill_get_active":
      return { skill: await getActiveSkill(userId) };
    case "personal_skill_publish_rewrite":
      return {
        version: await publishPersonalSkill({ userId, skill: args.skill, source: "model" }),
      };
  }
}

function toolDescription(name: string): string {
  const descriptions: Record<string, string> = {
    memory_search: "在当前用户与当前会话作用域内检索可用记忆。",
    memory_list: "列出当前用户可管理的活动记忆与待确认候选。",
    memory_commit_reflection: "提交由模型生成的记忆、画像、情绪和会话摘要。",
    memory_confirm: "确认指定候选版本，并生成新的活动版本。",
    memory_reject: "拒绝指定待确认候选版本。",
    memory_withdraw: "撤回当前用户的一条活动记忆，使其不再参与检索。",
    memory_record_usage: "在回答完成后批量记录实际加入上下文的记忆版本。",
    profile_get_current: "读取当前用户最新画像快照。",
    profile_commit_snapshot: "提交模型生成的画像综述与维度权重。",
    personal_skill_get_active: "读取当前用户正在生效的个人 Skill。",
    personal_skill_publish_rewrite: "发布模型重写的完整个人 Skill，并立即激活新版本。",
  };
  return descriptions[name] ?? name;
}

function readBody(request: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 2_000_000) request.destroy(new Error("request_too_large"));
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function rpcResult(id: unknown, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function sendJson(response: import("node:http").ServerResponse, status: number, payload: unknown) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}
