import { describe, expect, it } from "vitest";
import { jsonError } from "./http";

describe("public HTTP errors", () => {
  it("maps provider failures to a stable simplified-Chinese response", async () => {
    const response = jsonError(new Error("provider_authentication_failed"), 500);
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({
      code: "provider_authentication_failed",
      error: "模型服务暂时无法使用，请联系开发者检查配置。",
    });
  });

  it("redacts an unsafe low-level message from a bad request", async () => {
    const response = jsonError(new Error("Bearer token at https://internal.invalid"), 400);
    const body = await response.json();

    expect(body.code).toBe("request_invalid");
    expect(body.error).not.toContain("Bearer");
    expect(body.error).not.toContain("internal.invalid");
  });

  it("keeps a safe user-facing Chinese validation message", async () => {
    const response = jsonError(new Error("这个问题已经回答过了"), 409);
    const body = await response.json();

    expect(body).toEqual({ code: "request_invalid", error: "这个问题已经回答过了" });
  });
});
