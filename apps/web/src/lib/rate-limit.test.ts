import { afterEach, describe, expect, it } from "vitest";
import { consumeRateLimit, resetRateLimits } from "./rate-limit";

const rules = [
  { windowMs: 60_000, max: 3 },
  { windowMs: 3_600_000, max: 5 },
];

afterEach(() => resetRateLimits());

describe("consumeRateLimit", () => {
  it("admits requests until the smallest window is exhausted", () => {
    let now = 1_000_000;
    expect(consumeRateLimit("u1", rules, now)).toBe(true);
    now += 1_000;
    expect(consumeRateLimit("u1", rules, now)).toBe(true);
    now += 1_000;
    expect(consumeRateLimit("u1", rules, now)).toBe(true);
    now += 1_000;
    expect(consumeRateLimit("u1", rules, now)).toBe(false);
  });

  it("blocks on the hourly window even when the minute window resets", () => {
    let now = 2_000_000;
    // 每次间隔超过一分钟窗口，让分钟窗口不断重置、小时窗口逐渐填满。
    for (let index = 0; index < 5; index += 1) {
      now += 61_000;
      expect(consumeRateLimit("u2", rules, now)).toBe(true);
    }
    now += 61_000;
    expect(consumeRateLimit("u2", rules, now)).toBe(false);
  });

  it("admits again once every window has expired", () => {
    let now = 3_000_000;
    for (let index = 0; index < 5; index += 1) consumeRateLimit("u3", rules, now += 61_000);
    now += 3_601_000;
    expect(consumeRateLimit("u3", rules, now)).toBe(true);
  });

  it("tracks keys independently", () => {
    const now = 4_000_000;
    expect(consumeRateLimit("a", rules, now)).toBe(true);
    expect(consumeRateLimit("b", rules, now)).toBe(true);
    expect(consumeRateLimit("a", rules, now)).toBe(true);
  });
});
