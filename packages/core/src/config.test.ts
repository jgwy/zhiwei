import { afterEach, describe, expect, it } from "vitest";
import { isProductionRuntime, resolveSecret } from "./config";

const originalEnv = { ...process.env };

afterEach(() => { process.env = { ...originalEnv }; });

describe("resolveSecret", () => {
  it("keeps development fallback support", () => {
    process.env.NODE_ENV = "test";
    delete process.env.INTERNAL_MCP_TOKEN;
    expect(resolveSecret("INTERNAL_MCP_TOKEN", "fallback")).toBe("fallback");
  });

  it("rejects missing, public, or short secrets in competition mode", () => {
    process.env.NODE_ENV = "test";
    process.env.COMPETITION_MODE = "true";
    delete process.env.INTERNAL_MCP_TOKEN;
    expect(isProductionRuntime()).toBe(true);
    expect(() => resolveSecret("INTERNAL_MCP_TOKEN", "fallback")).toThrow(/缺少/);
    process.env.INTERNAL_MCP_TOKEN = "local-development-mcp-token";
    expect(() => resolveSecret("INTERNAL_MCP_TOKEN", "fallback")).toThrow(/公开默认/);
    process.env.INTERNAL_MCP_TOKEN = "too-short";
    expect(() => resolveSecret("INTERNAL_MCP_TOKEN", "fallback")).toThrow(/至少 32 字符/);
  });
});
