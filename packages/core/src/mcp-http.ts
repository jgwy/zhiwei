import type { IncomingMessage, ServerResponse } from "node:http";

export const MCP_PROTOCOL_VERSION = "2026-07-28";
export type McpServerInfo = { name: string; version: string };

export async function readMcpBody(request: IncomingMessage): Promise<string> {
  request.setEncoding("utf8");
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 2_000_000) throw new Error("request_too_large");
  }
  return body;
}

export function mcpRpcResult(id: unknown, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

export function mcpRpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

export function completeMcpResult<T extends Record<string, unknown>>(serverInfo: McpServerInfo, result: T) {
  return {
    resultType: "complete" as const,
    ...result,
    _meta: { "io.modelcontextprotocol/serverInfo": serverInfo },
  };
}

export function mcpToolResult(serverInfo: McpServerInfo, result: unknown) {
  return completeMcpResult(serverInfo, {
    content: [{ type: "text", text: JSON.stringify(result) }],
    structuredContent: result,
  });
}

export function sendMcpJson(response: ServerResponse, status: number, payload: unknown) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

export async function recordMcpAudit(service: string, operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation();
  } catch (error) {
    process.stderr.write(`${service} 审计记录失败：${error instanceof Error ? error.message : String(error)}\n`);
  }
}
