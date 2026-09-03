import { afterEach, describe, expect, it, vi } from "vitest";
import { callMemoryMcp } from "./mcp-client";
import { callScienceMcp } from "./science-mcp-client";
import { completeMcpResult, MCP_PROTOCOL_VERSION, mcpRpcResult, mcpToolResult, recordMcpAudit } from "./mcp-http";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("内部 MCP 无会话调用", () => {
  it.each(["memory", "science"])("%s 传递身份、协议、追踪并解开完整工具响应", async (service) => {
    vi.stubEnv("INTERNAL_MCP_TOKEN", "test-token");
    const fetchMock = vi.fn(async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      const headers = new Headers(init.headers);
      expect(headers.get("mcp-protocol-version")).toBe(MCP_PROTOCOL_VERSION);
      expect(headers.get("x-zhiwei-user")).toBe("user-a");
      expect(headers.get("x-zhiwei-role")).toBe("developer");
      expect(headers.get("traceparent")).toBe("trace-a");
      expect(headers.get("authorization")).toBe("Bearer test-token");
      expect(body.params.arguments).toEqual({ query: "物理" });
      expect(body.params.arguments.userId).toBeUndefined();
      expect(body.params._meta["io.modelcontextprotocol/protocolVersion"]).toBe(MCP_PROTOCOL_VERSION);
      expect(init.signal).toBeInstanceOf(AbortSignal);
      return Response.json(mcpRpcResult(body.id, mcpToolResult({ name: service, version: "1" }, { ok: true })));
    });
    vi.stubGlobal("fetch", fetchMock);
    const input = { userId: "user-a", arguments: { query: "物理" }, traceId: "trace-a", role: "developer" as const };
    const result = service === "memory"
      ? await callMemoryMcp({ ...input, tool: "memory_search" })
      : await callScienceMcp({ ...input, tool: "science_source_assess" });
    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("保留 CAS 冲突错误供调用方重试", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: { message: "memory_version_conflict" } }, { status: 409 })));
    await expect(callMemoryMcp({ userId: "user-a", tool: "memory_withdraw" })).rejects.toThrow("memory_version_conflict");
  });

  it("拒绝没有完整结果包装的响应", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => Response.json({ jsonrpc: "2.0", id: JSON.parse(init.body).id, result: { ok: true } })));
    await expect(callMemoryMcp({ userId: "user-a", tool: "memory_list" })).rejects.toThrow("无效响应");
  });

  it("已取消的请求不发送 HTTP", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const signal = AbortSignal.abort(new Error("已停止"));
    await expect(callMemoryMcp({ userId: "user-a", tool: "memory_search", signal })).rejects.toThrow("已停止");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("传递外部取消且默认 deadline 为十秒", async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout");
    vi.stubGlobal("fetch", vi.fn((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    })));
    const result = callScienceMcp({ userId: "user-a", tool: "science_claim_audit", arguments: {}, signal: controller.signal });
    controller.abort(new Error("请求结束"));
    await expect(result).rejects.toThrow("请求结束");
    expect(timeout).toHaveBeenCalledWith(10_000);
  });

  it("deadline 到达时终止等待", async () => {
    vi.stubGlobal("fetch", vi.fn((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    })));
    await expect(callMemoryMcp({ userId: "user-a", tool: "memory_search", timeoutMs: 5 })).rejects.toMatchObject({ name: "TimeoutError" });
  });
});

describe("MCP 公用完整响应与审计", () => {
  it("discover 和 list 保留 private 缓存与服务声明", () => {
    expect(completeMcpResult({ name: "science", version: "1" }, { supportedVersions: [MCP_PROTOCOL_VERSION], cacheScope: "private", ttlMs: 300_000 })).toEqual({
      resultType: "complete", supportedVersions: [MCP_PROTOCOL_VERSION], cacheScope: "private", ttlMs: 300_000,
      _meta: { "io.modelcontextprotocol/serverInfo": { name: "science", version: "1" } },
    });
  });

  it("审计失败仍让成功的业务操作正常返回", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    await expect(recordMcpAudit("Science MCP", async () => { throw new Error("audit_storage_unavailable"); })).resolves.toBeUndefined();
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("audit_storage_unavailable"));
  });
});
