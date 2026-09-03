import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({ handler: null as RequestListener | null }));
const store = vi.hoisted(() => ({ assertUserExists: vi.fn(), searchMemories: vi.fn(), getReflectionControlState:vi.fn(), commitReflection: vi.fn(), getLatestProfile: vi.fn(), getProfileForContext: vi.fn(), publishPersonalSkill: vi.fn(), recordMcpCall: vi.fn() }));
vi.mock("node:http", async (original) => ({
  ...await original<typeof import("node:http")>(),
  createServer: vi.fn((handler: RequestListener) => { transport.handler = handler; return { listen: vi.fn() }; }),
}));
vi.mock("@zhiwei/core", async (original) => ({ ...await original<typeof import("@zhiwei/core")>(), ...store }));

beforeAll(async () => { await import("./server"); });
beforeEach(() => {
  for (const mock of Object.values(store)) mock.mockReset();
  store.assertUserExists.mockResolvedValue(undefined);
  store.searchMemories.mockResolvedValue([]);
  store.getReflectionControlState.mockResolvedValue({mutationCursor:0,withdrawals:[]});
  store.commitReflection.mockResolvedValue({ memories: [] });
  store.recordMcpCall.mockResolvedValue(undefined);
});

const userId = "11111111-1111-4111-8111-111111111111";
const messageId = "22222222-2222-4222-8222-222222222222";
async function request(method: string, params: Record<string, unknown> = {}) {
  const incoming = Readable.from([JSON.stringify({ jsonrpc: "2.0", id: "test-rpc", method, params })]) as IncomingMessage;
  incoming.url = "/mcp";
  incoming.method = "POST";
  incoming.headers = { authorization: `Bearer ${process.env.INTERNAL_MCP_TOKEN ?? "local-development-mcp-token"}`, "mcp-protocol-version": "2026-07-28", "mcp-method": method, "mcp-name": String(params.name ?? ""), "x-zhiwei-user": userId };
  let status = 0;
  let body = "";
  const response = { writeHead: (code: number) => { status = code; }, end: (text: string) => { body = text; } } as unknown as ServerResponse;
  await transport.handler!(incoming, response);
  return { status, body: JSON.parse(body) };
}

it("工具列表与discover保持完整私有响应且不暴露开发者恢复工具", async () => {
  const discover = await request("server/discover");
  expect(discover.body.result).toMatchObject({ resultType: "complete", supportedVersions: ["2026-07-28"], cacheScope: "private" });
  const list = await request("tools/list");
  expect(list.body.result.tools.map((tool: { name: string }) => tool.name)).not.toContain("memory_restore_version");
});

it("反思检索传递12条候选和purpose", async () => {
  const result = await request("tools/call", { name: "memory_search", arguments: { query: "购物", purpose: "reflection", limit: 12 } });
  expect(result.status).toBe(200);
  expect(store.searchMemories).toHaveBeenCalledWith(userId, "购物", 12, undefined, "reflection");
});

it("提交固定批次和摘要的逐条证据", async () => {
  const args = { conversationId: userId, sourceMessageId: messageId, sourceMessageIds: [messageId], summaryEvidenceMessageIds: [messageId], reflection: { memories: [] }, idempotencyKey: "reflection-batch-test" };
  const result = await request("tools/call", { name: "memory_commit_reflection", arguments: args });
  expect(result.status).toBe(200);
  expect(store.commitReflection).toHaveBeenCalledWith(expect.objectContaining(args));
  expect(result.body.result.structuredContent).toEqual({ memories: [] });
  const invalid = await request("tools/call", { name: "memory_commit_reflection", arguments: { ...args, sourceMessageIds: Array(4).fill(messageId) } });
  expect(invalid.status).toBe(400);
});

it("展示画像可读取最近快照，默认回答仍使用同步快照", async () => {
  store.getLatestProfile.mockResolvedValue({ summary: "保留展示" });
  store.getProfileForContext.mockResolvedValue(null);
  const display = await request("tools/call", { name: "profile_get_current", arguments: { forDisplay: true } });
  expect(display.body.result.structuredContent.profile.summary).toBe("保留展示");
  const context = await request("tools/call", { name: "profile_get_current", arguments: {} });
  expect(context.body.result.structuredContent.profile).toBeNull();
  expect(store.getLatestProfile).toHaveBeenCalledOnce();
  expect(store.getProfileForContext).toHaveBeenCalledOnce();
});

it("个人Skill完整重写透传幂等键", async () => {
  const { defaultPersonalSkill } = await import("@zhiwei/core");
  store.publishPersonalSkill.mockResolvedValue(2);
  const result = await request("tools/call", { name: "personal_skill_publish_rewrite", arguments: { skill: defaultPersonalSkill, idempotencyKey: "personal-skill-test" } });
  expect(result.status).toBe(200);
  expect(store.publishPersonalSkill).toHaveBeenCalledWith({ userId, skill: defaultPersonalSkill, source: "model", idempotencyKey: "personal-skill-test" });
});
