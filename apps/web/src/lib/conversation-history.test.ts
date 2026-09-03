import { describe, expect, it } from "vitest";
import type { ConversationView } from "./client-types";
import { groupConversationsByTime } from "./conversation-history";

function conversation(id: string, updatedAt: string, createdAt = updatedAt): ConversationView {
  return {
    id,
    title: id,
    titleSource: "default",
    titleLocked: false,
    createdAt,
    updatedAt,
    historyRevision: 0,
    messages: [],
  };
}

describe("groupConversationsByTime", () => {
  it("groups weeks from Monday through Sunday and opens the current path", () => {
    const now = new Date("2026-09-16T12:00:00.000Z");
    const result = groupConversationsByTime([
      conversation("wed", "2026-09-16T10:00:00.000Z"),
      conversation("mon", "2026-09-14T10:00:00.000Z"),
      conversation("previous", "2026-09-13T10:00:00.000Z"),
    ], "UTC", now);

    const month = result.years[0]!.months[0]!;
    expect(month.weeks.map((week) => week.label)).toEqual(["本周", "9月7日—13日"]);
    expect(month.weeks[0]!.conversations.map((item) => item.id)).toEqual(["wed", "mon"]);
    expect(result.currentPath).toEqual([
      "year:2026",
      "year:2026:month:09",
      "year:2026:month:09:week:2026-09-14",
    ]);
  });

  it("splits a cross-month week at the month boundary", () => {
    const result = groupConversationsByTime([
      conversation("august", "2026-08-31T03:00:00.000Z"),
      conversation("september", "2026-09-01T03:00:00.000Z"),
    ], "UTC", new Date("2026-09-03T12:00:00.000Z"));

    const year = result.years[0]!;
    expect(year.months.map((month) => month.label)).toEqual(["9月", "8月"]);
    expect(year.months[0]!.weeks[0]!.conversations.map((item) => item.id)).toEqual(["september"]);
    expect(year.months[1]!.weeks[0]!.label).toBe("8月31日");
  });

  it("keeps years and months in descending order across a year boundary", () => {
    const result = groupConversationsByTime([
      conversation("new-year", "2026-01-01T03:00:00.000Z"),
      conversation("old-year", "2025-12-31T03:00:00.000Z"),
    ], "UTC", new Date("2026-01-02T12:00:00.000Z"));

    expect(result.years.map((year) => year.label)).toEqual(["2026年", "2025年"]);
    expect(result.years[0]!.months[0]!.weeks[0]!.conversations[0]!.id).toBe("new-year");
    expect(result.years[1]!.months[0]!.weeks[0]!.conversations[0]!.id).toBe("old-year");
  });

  it("uses the supplied timezone when assigning the activity date", () => {
    const result = groupConversationsByTime([
      conversation("shanghai-late", "2026-08-31T16:30:00.000Z"),
    ], "Asia/Shanghai", new Date("2026-09-01T01:00:00.000Z"));

    expect(result.years[0]!.months[0]!.label).toBe("9月");
    expect(result.years[0]!.months[0]!.weeks[0]!.conversations[0]!.id).toBe("shanghai-late");
  });

  it("falls back to creation time for an invalid activity timestamp", () => {
    const result = groupConversationsByTime([
      conversation("fallback", "not-a-date", "2024-05-06T10:00:00.000Z"),
    ], "UTC", new Date("2026-09-03T12:00:00.000Z"));

    expect(result.years[0]!.label).toBe("2024年");
    expect(result.years[0]!.months[0]!.label).toBe("5月");
  });

  it("returns no groups for an empty list", () => {
    expect(groupConversationsByTime([], "UTC", new Date("2026-09-03T12:00:00.000Z"))).toEqual({
      years: [],
      currentPath: [
        "year:2026",
        "year:2026:month:09",
        "year:2026:month:09:week:2026-08-31",
      ],
    });
  });
});
