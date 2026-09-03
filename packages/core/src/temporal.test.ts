import { describe, expect, it } from "vitest";
import {
  createTemporalContext,
  formatLocalDateTime,
  normalizeTemporalExpression,
} from "./temporal";

describe("temporal context", () => {
  it("normalizes yesterday to the user's local calendar day", () => {
    const context = createTemporalContext("Asia/Shanghai", new Date("2026-09-03T06:00:00.000Z"));
    const event = normalizeTemporalExpression("昨天项目正式结束了", context);

    expect(event).toMatchObject({
      kind: "range",
      start: "2026-09-01T16:00:00.000Z",
      end: "2026-09-02T16:00:00.000Z",
      precision: "day",
      expression: "昨天",
      timeZone: "Asia/Shanghai",
    });
  });

  it("respects daylight-saving boundaries for calendar-day ranges", () => {
    const context = createTemporalContext("America/New_York", new Date("2026-03-09T12:00:00.000Z"));
    const event = normalizeTemporalExpression("昨天开始不舒服", context);

    expect(event.start).toBe("2026-03-08T05:00:00.000Z");
    expect(event.end).toBe("2026-03-09T04:00:00.000Z");
  });

  it("keeps fuzzy expressions without inventing date bounds", () => {
    const context = createTemporalContext("Asia/Shanghai", new Date("2026-09-03T06:00:00.000Z"));
    const event = normalizeTemporalExpression("最近工作有些忙", context);

    expect(event).toEqual({
      kind: "fuzzy",
      start: null,
      end: null,
      precision: "approximate",
      expression: "最近",
      timeZone: "Asia/Shanghai",
    });
  });

  it("does not turn an invalid explicit date into a normalized instant", () => {
    const context = createTemporalContext("Asia/Shanghai", new Date("2026-09-03T06:00:00.000Z"));
    const event = normalizeTemporalExpression("约在2026年13月42日发生", context);

    expect(event).toMatchObject({ kind: "fuzzy", start: null, end: null, expression: "2026年13月42日" });
  });

  it("formats the same instant in the requested timezone", () => {
    expect(formatLocalDateTime("2026-09-03T06:00:00.000Z", "Asia/Shanghai")).toBe("2026-09-03 14:00:00");
    expect(formatLocalDateTime("2026-09-03T06:00:00.000Z", "America/New_York")).toBe("2026-09-03 02:00:00");
  });
});
