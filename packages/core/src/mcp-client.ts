export async function callMemoryMcp<T>(input: {
  tool: string;
  userId: string;
  arguments?: Record<string, unknown>;
  traceId?: string;
  role?: "runtime" | "developer";
}): Promise<T> {
  const url = process.env.MEMORY_MCP_URL ?? "http://127.0.0.1:4100/mcp";
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${process.env.INTERNAL_MCP_TOKEN ?? "local-development-mcp-token"}`,
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": "tools/call",
      "mcp-name": input.tool,
      "x-zhiwei-user": input.userId,
      "x-zhiwei-role": input.role ?? "runtime",
      ...(input.traceId ? { traceparent: input.traceId } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "tools/call",
      params: {
        name: input.tool,
        arguments: input.arguments ?? {},
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": {
            name: "zhiwei-runtime",
            version: "0.1.0",
          },
          "io.modelcontextprotocol/clientCapabilities": {},
          ...(input.traceId ? { traceparent: input.traceId } : {}),
        },
      },
    }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error?.message ?? `Memory MCP ${input.tool} 请求失败：${response.status}`);
  }
  if (!payload) throw new Error("Memory MCP 返回了无效响应");
  if (payload.error) throw new Error(payload.error.message ?? "Memory MCP 返回错误");
  return (payload.result?.structuredContent ?? payload.result) as T;
}
