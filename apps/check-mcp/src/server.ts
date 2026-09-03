import { createServer } from "node:http";
import { recordMcpCall } from "@zhiwei/core";
import { z } from "zod";
import { checkClaims } from "./check";

const port = Number(process.env.CHECK_MCP_PORT ?? 4300);
const token = process.env.INTERNAL_MCP_TOKEN ?? "local-development-mcp-token";

const sourceSchema = z.object({
  title: z.string().min(1).max(500),
  url: z.string().url().max(2_000),
  publisher: z.string().min(1).max(200).optional(),
  kind: z.enum(["official", "research", "secondary", "community", "unknown"]).default("unknown"),
});
const claimSchema = z.object({
  text: z.string().min(1).max(2_000),
  status: z.enum(["supported", "uncertain", "human_review"]),
  sourceIndices: z.array(z.number().int()).max(24).default([]),
  note: z.string().max(1_000).optional(),
});
const toolSchema = z.object({
  query: z.string().min(1).max(4_000),
  impact: z.enum(["ordinary", "high"]),
  claims: z.array(claimSchema).max(24),
  sources: z.array(sourceSchema).max(24),
});

const server = createServer(async (request, response) => {
  try {
    if (request.url === "/health") return sendJson(response, 200, { ok: true, service: "zhiwei-check-mcp" });
    if (request.url !== "/mcp" || request.method !== "POST") return sendJson(response, 404, { error: "not_found" });
    if (request.headers.authorization !== `Bearer ${token}`) return sendJson(response, 401, rpcError(null, -32001, "未通过内部服务认证"));
    const origin = request.headers.origin;
    if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/u.test(origin)) return sendJson(response, 403, rpcError(null, -32002, "不允许该请求来源"));

    const body = JSON.parse(await readBody(request));
    if (request.headers["mcp-method"] !== body.method) return sendJson(response, 400, rpcError(body.id ?? null, -32600, "Mcp-Method 与请求体不一致"));
    if (body.method === "server/discover") return sendJson(response, 200, rpcResult(body.id, { protocolVersion: "2026-07-28", serverInfo: { name: "zhiwei-check-mcp", version: "0.1.0" }, capabilities: { tools: {} } }));
    if (body.method === "tools/list") return sendJson(response, 200, rpcResult(body.id, {
      tools: [{ name: "check_claims", description: "检查外部事实主张的来源索引、来源质量及人物姓名与机构来源绑定；不满足条件的主张降为人工复核。", inputSchema: z.toJSONSchema(toolSchema) }],
      ttlMs: 300_000,
      cacheScope: "global",
    }));
    if (body.method !== "tools/call" || body.params?.name !== "check_claims" || request.headers["mcp-name"] !== "check_claims") return sendJson(response, 400, rpcError(body.id ?? null, -32601, "未知的核验工具"));
    const userId = request.headers["x-zhiwei-user"];
    if (typeof userId !== "string" || !z.string().uuid().safeParse(userId).success) return sendJson(response, 400, rpcError(body.id ?? null, -32602, "缺少有效的用户范围"));

    const args = toolSchema.parse(body.params?.arguments ?? {});
    const started = Date.now();
    const result = checkClaims(args);
    await recordMcpCall({ userId, traceId: typeof request.headers.traceparent === "string" ? request.headers.traceparent : undefined, toolName: "check_claims", arguments: args, result, durationMs: Date.now() - started });
    return sendJson(response, 200, rpcResult(body.id, result));
  } catch (error) {
    const message = error instanceof z.ZodError ? "核验参数不符合工具约定" : error instanceof Error ? error.message : String(error);
    return sendJson(response, 500, rpcError(null, -32603, message));
  }
});

server.listen(port, "0.0.0.0", () => process.stdout.write(`Check MCP listening on ${port}\n`));

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
function rpcResult(id: unknown, result: unknown) { return { jsonrpc: "2.0", id, result }; }
function rpcError(id: unknown, code: number, message: string) { return { jsonrpc: "2.0", id, error: { code, message } }; }
function sendJson(response: import("node:http").ServerResponse, status: number, payload: unknown) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}
