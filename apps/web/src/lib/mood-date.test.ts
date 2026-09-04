import { describe, expect, it } from "vitest";
import { browserTimeZone, formatMoodDay } from "./mood-date";

describe("mood day labels", () => {
  it("formats calendar keys without parsing them in the device time zone", () => {
    expect(formatMoodDay("2026-09-03")).toBe("9月3日");
    expect(formatMoodDay("2026-09-04")).toBe("9月4日");
    expect(formatMoodDay("2027-01-01")).toBe("1月1日");
  });

  it("does not turn chart indices into January dates", () => {
    for (const value of [0, 1, "0", "1", undefined, null]) expect(formatMoodDay(value)).toBe("");
  });

  it("uses the current runtime's IANA zone", () => {
    expect(browserTimeZone()).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });
});
