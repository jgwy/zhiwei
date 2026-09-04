import { describe, expect, it } from "vitest";
import { normalizeTimeZone } from "./time-zone";

describe("mood query time zone", () => {
  it("accepts browser IANA zones and UTC", () => {
    expect(normalizeTimeZone("Asia/Shanghai")).toBe("Asia/Shanghai");
    expect(normalizeTimeZone("America/New_York")).toBe("America/New_York");
    expect(normalizeTimeZone("UTC")).toBe("UTC");
  });

  it("uses Shanghai for missing or invalid zones", () => {
    for (const value of [undefined, null, "", "unknown/place", "not a time zone", "+08:00"]) {
      expect(normalizeTimeZone(value)).toBe("Asia/Shanghai");
    }
  });
});
