import { callInternalMcp, type InternalMcpCall } from "./mcp-transport";

export async function callMemoryMcp<T>(input: InternalMcpCall): Promise<T> {
  return callInternalMcp<T>(
    process.env.MEMORY_MCP_URL ?? "http://127.0.0.1:4100/mcp",
    "Memory MCP",
    input,
  );
}
