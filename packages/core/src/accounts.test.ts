import { describe, expect, it } from "vitest";
import { AccountCredentialsSchema, hashAccountPassword, mergeAccountSettings, verifyAccountPassword } from "./accounts";

describe("account credentials", () => {
  it("normalizes account names but preserves password characters", () => {
    expect(AccountCredentialsSchema.parse({ username: "  Zhiwei_知微  ", password: "  私人的长密码-123  " }))
      .toEqual({ username: "zhiwei_知微", password: "  私人的长密码-123  " });
    expect(AccountCredentialsSchema.safeParse({ username: "abc@def", password: "1234567890" }).success).toBe(false);
    expect(AccountCredentialsSchema.safeParse({ username: "abc", password: "short" }).success).toBe(false);
  });

  it("salts each password and accepts only a matching secret", async () => {
    const password = "testing-only-long-password";
    const first = await hashAccountPassword(password);
    const second = await hashAccountPassword(password);
    expect(first).not.toBe(second);
    expect(first).not.toContain(password);
    expect(await verifyAccountPassword(password, first)).toBe(true);
    expect(await verifyAccountPassword(`${password}!`, first)).toBe(false);
    expect(await verifyAccountPassword(password, "malformed")).toBe(false);
  });

  it("never enables a consent either side disabled", () => {
    expect(mergeAccountSettings({ memoryEnabled: true, emotionTrackingEnabled: false }, { memoryEnabled: false, longTermMemoryEnabled: true }))
      .toEqual({ memoryEnabled: false, emotionTrackingEnabled: false, longTermMemoryEnabled: true });
  });
});
