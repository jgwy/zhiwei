import { afterEach, describe, expect, it } from "vitest";
import { isProductionRuntime, resolveSecret } from "./config";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.ZHIWI_FORCE_PRODUCTION_CHECKS;
});

describe("resolveSecret", () => {
  it("returns the explicit value in every runtime", () => {
    process.env.INTERNAL_MCP_TOKEN = "explicit-token";
    expect(resolveSecret("INTERNAL_MCP_TOKEN", "fallback")).toBe("explicit-token");
  });

  it("falls back to the development default outside production", () => {
    process.env.NODE_ENV = "test";
    delete process.env.INTERNAL_MCP_TOKEN;
    expect(resolveSecret("INTERNAL_MCP_TOKEN", "fallback")).toBe("fallback");
  });

  it("refuses to boot in production without the secret", () => {
    process.env.NODE_ENV = "production";
    delete process.env.INTERNAL_MCP_TOKEN;
    expect(() => resolveSecret("INTERNAL_MCP_TOKEN", "fallback")).toThrow(/INTERNAL_MCP_TOKEN/);
  });

  it("supports forcing production checks without NODE_ENV", () => {
    process.env.NODE_ENV = "test";
    process.env.ZHIWI_FORCE_PRODUCTION_CHECKS = "true";
    delete process.env.ANON_COOKIE_SECRET;
    expect(isProductionRuntime()).toBe(true);
    expect(() => resolveSecret("ANON_COOKIE_SECRET", "fallback")).toThrow(/ANON_COOKIE_SECRET/);
  });
});
