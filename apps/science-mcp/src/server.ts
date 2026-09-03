import { createServer } from "node:http";
import {
  ScienceAuditClaimSchema,
  ScienceImpactSchema,
  ScienceSourceSchema,
  recordMcpCall,
  resolveSecret,
} from "@zhiwei/core";
import { z } from "zod";
import { assessScienceSources, auditScienceClaims } from "./audit";

const port = Number(process.env.SCIENCE_MCP_PORT ?? 4200);
const token = resolveSecret("INTERNAL_MCP_TOKEN", "local-development-mcp-token");

const toolSchemas = {
  science_source_assess: z.object({
    sources: z.array(ScienceSourceSchema).min(1).max(24),
  }),
  science_claim_audit: z.object({
    claims: z.array(ScienceAuditClaimSchema).min(1).max(24),
    sources: z.array(ScienceSourceSchema).max(24),
    impact: ScienceImpactSchema,
  }),
} as const;

const server = createServer(async (request, response) => {
  try {
    if (request.url === "/health") {
      sendJson(response, 200, { ok: true, service: "zhiwei-science-mcp" });
      return;
    }
    if (request.url !== "/mcp" || request.method !== "POST") {
      sendJson(response, 404, { error: "not_found" });
      return;
    }
    if (request.headers.authorization !== `Bearer ${token}`) {
      sendJson(response, 401, rpcError(null, -32001, "未通过内部服务认证"));
      return;
    }
    const origin = request.headers.origin;
    if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      sendJson(response, 403, rpcError(null, -32002, "不允许该请求来源"));
      return;
    }

    const body = JSON.parse(await readBody(request));
    const methodHeader = request.headers["mcp-method"];
    if (methodHeader !== body.method) {
      sendJson(response, 400, rpcError(body.id ?? null, -32600, "Mcp-Method 与请求体不一致"));
      return;
    }

    if (body.method === "server/discover") {
      sendJson(response, 200, rpcResult(body.id, {
        protocolVersion: "2026-07-28",
        serverInfo: { name: "zhiwei-science-mcp", version: "0.1.0" },
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
      sendJson(response, 400, rpcError(body.id ?? null, -32601, "未知的方法"));
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
      sendJson(response, 404, rpcError(body.id ?? null, -32602, "未知的科学审计工具"));
      return;
    }
    const args = schema.parse(body.params?.arguments ?? {}) as any;
    const started = Date.now();
    const result = invokeTool(toolName, args);
    await recordMcpCall({
      userId,
      traceId: typeof request.headers.traceparent === "string" ? request.headers.traceparent : undefined,
      toolName,
      arguments: args,
      result: result as Record<string, unknown>,
      durationMs: Date.now() - started,
    });
    sendJson(response, 200, rpcResult(body.id, result));
  } catch (error) {
    const message = error instanceof z.ZodError
      ? "科学审计参数不符合工具约定"
      : error instanceof Error ? error.message : String(error);
    sendJson(response, 500, rpcError(null, -32603, message));
  }
});

server.listen(port, "0.0.0.0", () => {
  process.stdout.write(`Science MCP listening on ${port}\n`);
});

function invokeTool(tool: keyof typeof toolSchemas, args: any) {
  switch (tool) {
    case "science_source_assess":
      return { assessments: assessScienceSources(args.sources) };
    case "science_claim_audit":
      return auditScienceClaims(args);
  }
}

function toolDescription(name: string): string {
  const descriptions: Record<string, string> = {
    science_source_assess: "按发布主体、域名和来源类型评估科学资料的权威等级，并给出可解释的中文理由。",
    science_claim_audit: "审计原子科学主张与从 0 开始的来源索引；高影响主张缺少权威一手证据时转为人工复核。",
  };
  return descriptions[name] ?? name;
}

function readBody(request: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 2_000_000) request.destroy(new Error("请求体过大"));
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
