import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ get: vi.fn(), has: vi.fn(), set: vi.fn(), resolve: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: vi.fn(async () => ({ get: mocks.get, has: mocks.has, set: mocks.set })) }));
vi.mock("@zhiwei/core", () => ({ resolveAccountUserId: mocks.resolve }));

import { getOrCreateSessionUserId, getSessionUserId, USER_COOKIE } from "./session";
import { proxy } from "../proxy";

const secret = "unit-test-cookie-signing-key";
function signed(id: string) {
  const input = `${id}.1788500000000`;
  return `${input}.${createHmac("sha256", secret).update(input).digest("base64url")}`;
}

describe("test API session identity", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("ANON_COOKIE_SECRET", secret);
    mocks.has.mockReturnValue(false);
    mocks.resolve.mockImplementation(async (id: string) => id);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("creates one signed HttpOnly cookie matching the returned identity", async () => {
    const id = await getOrCreateSessionUserId(new Request("http://localhost/api/test/chat"));
    expect(id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(mocks.set).toHaveBeenCalledTimes(1);
    const [name, value, options] = mocks.set.mock.calls[0]!;
    expect(name).toBe(USER_COOKIE);
    const [cookieId, issuedAt, signature] = String(value).split(".");
    expect(cookieId).toBe(id);
    expect(Number(issuedAt)).toBeGreaterThan(0);
    expect(signature).toBe(createHmac("sha256", secret).update(`${cookieId}.${issuedAt}`).digest("base64url"));
    expect(options).toEqual({ httpOnly: true, sameSite: "lax", secure: false, path: "/", maxAge: 60 * 60 * 24 * 365 });
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it.each([
    new Request("https://zhiwei.example/api/test/chat"),
    new Request("http://localhost/api/test/chat", { headers: { "x-forwarded-proto": "https" } }),
  ])("marks direct or forwarded HTTPS cookies Secure", async (request) => {
    await getOrCreateSessionUserId(request);
    expect(mocks.set).toHaveBeenCalledWith(USER_COOKIE, expect.any(String), expect.objectContaining({ secure: true }));
  });

  it("reuses a valid cookie and resolves its restored account without rewriting it", async () => {
    mocks.has.mockReturnValue(true);
    mocks.get.mockReturnValue({ value: signed("bca6fa96-0bad-41dc-b9f4-b3041aadbb03") });
    mocks.resolve.mockResolvedValue("restored-account-owner");
    expect(await getOrCreateSessionUserId(new Request("http://localhost/api/test/chat"))).toBe("restored-account-owner");
    expect(mocks.resolve).toHaveBeenCalledExactlyOnceWith("bca6fa96-0bad-41dc-b9f4-b3041aadbb03");
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it.each(["broken", "owner.1788500000000.bad-signature", signed("owner").replace("owner", "another")])("rejects malformed or tampered cookies without replacing them: %s", async (value) => {
    mocks.has.mockReturnValue(true);
    mocks.get.mockReturnValue({ value });
    await expect(getOrCreateSessionUserId(new Request("http://localhost/api/test/chat"))).rejects.toThrow("anonymous_session_invalid");
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it("does not silently provision identity through the existing session-only helper", async () => {
    mocks.get.mockReturnValue(undefined);
    await expect(getSessionUserId()).rejects.toThrow("anonymous_session_missing");
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it.each(["GET", "POST"])("leaves %s test API cookies to the route, without a second identity", async (method) => {
    const response = await proxy(new NextRequest("http://localhost/api/test/chat", { method }));
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(mocks.set).not.toHaveBeenCalled();
  });
});
