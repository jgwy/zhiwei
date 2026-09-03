export async function callCheckMcp<T>(input: {
  tool: "check_claims";
  userId: string;
  arguments: Record<string, unknown>;
  traceId?: string;
}): Promise<T> {
  const url = process.env.CHECK_MCP_URL ?? "http://127.0.0.1:4300/mcp";
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
      ...(input.traceId ? { traceparent: input.traceId } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "tools/call",
      params: { name: input.tool, arguments: input.arguments, _meta: { "io.modelcontextprotocol/clientInfo": { name: "zhiwei-runtime", version: "0.1.0" } } },
    }),
  });
  if (!response.ok) throw new Error(`事实核验服务 ${input.tool} 请求失败：${response.status}`);
  const payload = await response.json();
  if (payload.error) throw new Error(payload.error.message ?? "事实核验服务返回错误");
  return payload.result as T;
}
