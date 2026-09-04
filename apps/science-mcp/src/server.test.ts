import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({ handler: null as RequestListener | null }));
const audit = vi.hoisted(() => vi.fn());
vi.mock("node:http", async (original) => ({
  ...await original<typeof import("node:http")>(),
  createServer: vi.fn((handler: RequestListener) => {
    transport.handler = handler;
    return { listen: vi.fn() };
  }),
}));
vi.mock("@zhiwei/core", async (original) => ({
  ...await original<typeof import("@zhiwei/core")>(),
  recordMcpCall: audit,
}));

beforeAll(async () => { await import("./server"); });
beforeEach(() => { audit.mockReset(); audit.mockResolvedValue(undefined); });

async function request(method: string, params: Record<string, unknown> = {}, version = "2026-07-28") {
  const incoming = Readable.from([JSON.stringify({ jsonrpc: "2.0", id: "test-rpc", method, params })]) as IncomingMessage;
  incoming.url = "/mcp";
  incoming.method = "POST";
  incoming.headers = { authorization: `Bearer ${process.env.INTERNAL_MCP_TOKEN ?? "local-development-mcp-token"}`, "mcp-protocol-version": version, "mcp-method": method, "mcp-name": String(params.name ?? ""), "x-zhiwei-user": "11111111-1111-4111-8111-111111111111" };
  let status = 0;
  let body = "";
  const response = { writeHead: (code: number) => { status = code; }, end: (text: string) => { body = text; } } as unknown as ServerResponse;
  await transport.handler!(incoming, response);
  return { status, body: JSON.parse(body) };
}

it("science discover/list 使用无会话完整响应", async () => {
  const discovery = await request("server/discover");
  expect(discovery.status).toBe(200);
  expect(discovery.body.result).toMatchObject({ resultType: "complete", supportedVersions: ["2026-07-28"], cacheScope: "private", capabilities: { tools: {} } });
  const list = await request("tools/list");
  expect(list.body.result.resultType).toBe("complete");
  expect(list.body.result.tools).toHaveLength(2);
});

it("science 协议不匹配与非法参数返回 400", async () => {
  expect((await request("tools/list", {}, "old")).status).toBe(400);
  const invalid = await request("tools/call", { name: "science_source_assess", arguments: { sources: [] } });
  expect(invalid.status).toBe(400);
  expect(invalid.body.id).toBe("test-rpc");
  expect(audit).not.toHaveBeenCalled();
});

it("审计落库失败仍返回已完成的科学工具结果", async () => {
  audit.mockRejectedValueOnce(new Error("storage_unavailable"));
  const log = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  try {
    const result = await request("tools/call", { name: "science_source_assess", arguments: { sources: [{ title: "官方资料", url: "https://www.noaa.gov/test", kind: "official" }] } });
    expect(result.status).toBe(200);
    expect(result.body.result.resultType).toBe("complete");
    expect(result.body.result.structuredContent.assessments).toHaveLength(1);
    expect(result.body.result.content[0].type).toBe("text");
    expect(log).toHaveBeenCalled();
  } finally { log.mockRestore(); }
});
