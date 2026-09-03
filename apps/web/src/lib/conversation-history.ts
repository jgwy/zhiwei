import type { ConversationView } from "./client-types";

type CalendarDate = {
  year: number;
  month: number;
  day: number;
};

export type ConversationWeekGroup = {
  id: string;
  label: string;
  isCurrent: boolean;
  conversations: ConversationView[];
};

export type ConversationMonthGroup = {
  id: string;
  label: string;
  isCurrent: boolean;
  count: number;
  weeks: ConversationWeekGroup[];
};

export type ConversationYearGroup = {
  id: string;
  label: string;
  isCurrent: boolean;
  count: number;
  months: ConversationMonthGroup[];
};

export type ConversationHistory = {
  years: ConversationYearGroup[];
  currentPath: string[];
};

type GroupedConversation = {
  conversation: ConversationView;
  date: Date;
  calendar: CalendarDate;
  index: number;
};

const DAY_MS = 86_400_000;

export function groupConversationsByTime(
  conversations: ConversationView[],
  timeZone: string,
  now = new Date(),
): ConversationHistory {
  const currentCalendar = calendarDate(now, timeZone);
  const currentWeekStart = weekStart(currentCalendar);
  const grouped = new Map<number, Map<number, Map<string, GroupedConversation[]>>>();

  conversations.forEach((conversation, index) => {
    const activityValue = validDate(conversation.updatedAt, timeZone) ?? validDate(conversation.createdAt, timeZone);
    if (!activityValue) return;
    const date = activityValue.date;
    const calendar = activityValue.calendar;
    const yearGroups = grouped.get(calendar.year) ?? new Map<number, Map<string, GroupedConversation[]>>();
    const monthGroups = yearGroups.get(calendar.month) ?? new Map<string, GroupedConversation[]>();
    const start = weekStart(calendar);
    const weekId = weekKey(start);
    const weekConversations = monthGroups.get(weekId) ?? [];
    weekConversations.push({ conversation, date, calendar, index });
    monthGroups.set(weekId, weekConversations);
    yearGroups.set(calendar.month, monthGroups);
    grouped.set(calendar.year, yearGroups);
  });

  const years = [...grouped.entries()]
    .sort(([left], [right]) => right - left)
    .map(([year, monthGroups]) => {
      const yearId = yearKey(year);
      const months = [...monthGroups.entries()]
        .sort(([left], [right]) => right - left)
        .map(([month, weekGroups]) => {
          const monthId = monthKey(year, month);
          const isCurrentMonth = currentCalendar.year === year && currentCalendar.month === month;
          const weeks = [...weekGroups.entries()]
            .sort(([left], [right]) => right.localeCompare(left))
            .map(([startKey, entries]) => {
              const start = parseDateKey(startKey);
              const clippedStart = maxCalendar(start, { year, month, day: 1 });
              const clippedEnd = minCalendar(addDays(start, 6), lastDayOfMonth(year, month));
              const isCurrentWeek = isCurrentMonth && sameCalendar(start, currentWeekStart);
              const sorted = entries
                .slice()
                .sort((left, right) => right.date.getTime() - left.date.getTime() || entryIndex(left) - entryIndex(right))
                .map(({ conversation }) => conversation);
              return {
                id: weekGroupKey(monthId, startKey),
                label: isCurrentWeek ? "本周" : formatWeekLabel(clippedStart, clippedEnd),
                isCurrent: isCurrentWeek,
                conversations: sorted,
              } satisfies ConversationWeekGroup;
            });
          return {
            id: monthId,
            label: `${month}月`,
            isCurrent: isCurrentMonth,
            count: weeks.reduce((total, week) => total + week.conversations.length, 0),
            weeks,
          } satisfies ConversationMonthGroup;
        });
      return {
        id: yearId,
        label: `${year}年`,
        isCurrent: currentCalendar.year === year,
        count: months.reduce((total, month) => total + month.count, 0),
        months,
      } satisfies ConversationYearGroup;
    });

  const currentYearId = yearKey(currentCalendar.year);
  const currentMonthId = monthKey(currentCalendar.year, currentCalendar.month);
  const currentWeekId = weekGroupKey(currentMonthId, weekKey(currentWeekStart));
  return { years, currentPath: [currentYearId, currentMonthId, currentWeekId] };
}

function validDate(value: string | undefined, timeZone: string) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return { date, calendar: calendarDate(date, timeZone) };
}

function calendarDate(value: Date, timeZone?: string): CalendarDate {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone,
  }).formatToParts(value);
  const partValue = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return { year: partValue("year"), month: partValue("month"), day: partValue("day") };
}

function weekStart(value: CalendarDate): CalendarDate {
  const date = asUtcDate(value);
  const daysSinceMonday = (date.getUTCDay() + 6) % 7;
  return fromUtcDate(new Date(date.getTime() - daysSinceMonday * DAY_MS));
}

function asUtcDate(value: CalendarDate) {
  return new Date(Date.UTC(value.year, value.month - 1, value.day));
}

function fromUtcDate(value: Date): CalendarDate {
  return { year: value.getUTCFullYear(), month: value.getUTCMonth() + 1, day: value.getUTCDate() };
}

function addDays(value: CalendarDate, amount: number) {
  return fromUtcDate(new Date(asUtcDate(value).getTime() + amount * DAY_MS));
}

function lastDayOfMonth(year: number, month: number) {
  return { year, month, day: new Date(Date.UTC(year, month, 0)).getUTCDate() };
}

function maxCalendar(left: CalendarDate, right: CalendarDate) {
  return compareCalendar(left, right) >= 0 ? left : right;
}

function minCalendar(left: CalendarDate, right: CalendarDate) {
  return compareCalendar(left, right) <= 0 ? left : right;
}

function compareCalendar(left: CalendarDate, right: CalendarDate) {
  return asUtcDate(left).getTime() - asUtcDate(right).getTime();
}

function sameCalendar(left: CalendarDate, right: CalendarDate) {
  return left.year === right.year && left.month === right.month && left.day === right.day;
}

function formatWeekLabel(start: CalendarDate, end: CalendarDate) {
  if (sameCalendar(start, end)) return `${start.month}月${start.day}日`;
  const startText = `${start.month}月${start.day}日`;
  const endText = start.month === end.month ? `${end.day}日` : `${end.month}月${end.day}日`;
  return `${startText}—${endText}`;
}

function yearKey(year: number) {
  return `year:${year}`;
}

function monthKey(year: number, month: number) {
  return `${yearKey(year)}:month:${String(month).padStart(2, "0")}`;
}

function weekGroupKey(monthId: string, startKey: string) {
  return `${monthId}:week:${startKey}`;
}

function weekKey(value: CalendarDate) {
  return `${value.year}-${String(value.month).padStart(2, "0")}-${String(value.day).padStart(2, "0")}`;
}

function parseDateKey(value: string): CalendarDate {
  const [year = "0", month = "0", day = "0"] = value.split("-");
  return { year: Number(year), month: Number(month), day: Number(day) };
}

function entryIndex(entry: GroupedConversation) {
  return entry.index;
}
