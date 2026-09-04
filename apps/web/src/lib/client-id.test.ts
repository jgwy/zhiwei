import { afterEach, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { createClientId } from "./client-id";

afterEach(() => vi.unstubAllGlobals());

describe("createClientId", () => {
  it("uses native UUID generation when available", () => {
    const randomUUID = vi.fn(() => "5e639062-939b-45f1-9271-dc3bc9aa6fa7");
    vi.stubGlobal("crypto", { randomUUID });
    expect(createClientId()).toBe("5e639062-939b-45f1-9271-dc3bc9aa6fa7");
    expect(randomUUID).toHaveBeenCalledOnce();
  });

  it("generates distinct version 4 UUIDs when HTTP omits randomUUID", () => {
    vi.stubGlobal("crypto", { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) });
    const ids = Array.from({ length: 128 }, createClientId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
  });
});
