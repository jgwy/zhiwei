import { MCP_PROTOCOL_VERSION } from "./mcp-http";
import { resolveSecret } from "./config";

export type InternalMcpCall = {
  tool: string;
  userId: string;
  arguments?: Record<string, unknown>;
  traceId?: string;
  role?: "runtime" | "developer";
  signal?: AbortSignal;
  timeoutMs?: number;
};

export async function callInternalMcp<T>(url: string, service: string, input: InternalMcpCall): Promise<T> {
  const deadline = AbortSignal.timeout(input.timeoutMs ?? 10_000);
  const signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline;
  signal.throwIfAborted();
  const requestId = crypto.randomUUID();
  const response = await fetch(url, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${resolveSecret("INTERNAL_MCP_TOKEN", "local-development-mcp-token")}`,
      "mcp-protocol-version": MCP_PROTOCOL_VERSION,
      "mcp-method": "tools/call",
      "mcp-name": input.tool,
      "x-zhiwei-user": input.userId,
      "x-zhiwei-role": input.role ?? "runtime",
      ...(input.traceId ? { traceparent: input.traceId } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: requestId,
      method: "tools/call",
      params: {
        name: input.tool,
        arguments: input.arguments ?? {},
        _meta: {
          "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
          "io.modelcontextprotocol/clientInfo": { name: "zhiwei-runtime", version: "0.1.0" },
          "io.modelcontextprotocol/clientCapabilities": {},
          ...(input.traceId ? { traceparent: input.traceId } : {}),
        },
      },
    }),
  });
  const payload = await response.json().catch((error) => {
    signal.throwIfAborted();
    if (error instanceof SyntaxError) return null;
    throw error;
  });
  if (!response.ok || payload?.error) {
    throw new Error(payload?.error?.message ?? `${service} ${input.tool} 请求失败：${response.status}`);
  }
  if (payload?.jsonrpc !== "2.0" || payload.id !== requestId || payload.result?.resultType !== "complete" || !("structuredContent" in payload.result)) {
    throw new Error(`${service} 返回了无效响应`);
  }
  if (payload.result.isError) throw new Error(`${service} 工具执行失败`);
  return payload.result.structuredContent as T;
}
