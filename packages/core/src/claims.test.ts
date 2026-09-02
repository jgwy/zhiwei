import { describe, expect, it } from "vitest";
import { checkAtomicClaims } from "./claims";

describe("checkAtomicClaims", () => {
  it("attaches authoritative evidence only to matching solar claims", () => {
    const claims = checkAtomicClaims(
      "太阳耀斑是太阳释放电磁辐射的爆发现象。强事件可能影响通信，但这句话还需要核对。",
    );
    expect(claims[0]?.status).toBe("supported");
    expect(claims[0]?.sourceUrl).toContain("noaa.gov");
    expect(claims[1]?.status).toBe("uncertain");
  });
});
