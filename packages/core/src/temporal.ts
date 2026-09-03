import type { EventTime, TemporalContext } from "./types";

const DAY_MS = 86_400_000;

export function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

export function createTemporalContext(
  timeZone: string,
  now = new Date(),
): TemporalContext {
  const safeTimeZone = isValidTimeZone(timeZone) ? timeZone : "Asia/Shanghai";
  return {
    currentTimeUtc: now.toISOString(),
    currentLocalTime: `${formatLocalDateTime(now, safeTimeZone)} ${safeTimeZone}`,
    timeZone: safeTimeZone,
  };
}

export function formatLocalDateTime(value: Date | string, timeZone: string): string {
  const parts = getZonedParts(new Date(value), timeZone);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)} ${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`;
}

export function formatRelativeTime(value: Date | string, now: Date | string = new Date()): string {
  const deltaMs = new Date(now).getTime() - new Date(value).getTime();
  const future = deltaMs < 0;
  const seconds = Math.abs(deltaMs) / 1_000;
  const [amount, unit] = seconds < 60
    ? [Math.max(1, Math.round(seconds)), "秒"]
    : seconds < 3_600
      ? [Math.round(seconds / 60), "分钟"]
      : seconds < 86_400
        ? [Math.round(seconds / 3_600), "小时"]
        : seconds < 2_592_000
          ? [Math.round(seconds / 86_400), "天"]
          : seconds < 31_536_000
            ? [Math.round(seconds / 2_592_000), "个月"]
            : [Math.round(seconds / 31_536_000), "年"];
  return future ? `${amount}${unit}后` : `${amount}${unit}前`;
}

export function describeTimestamp(
  value: string,
  context: TemporalContext,
): { absolute: string; relative: string } {
  return {
    absolute: `${formatLocalDateTime(value, context.timeZone)} ${context.timeZone}`,
    relative: formatRelativeTime(value, context.currentTimeUtc),
  };
}

export function normalizeTemporalExpression(
  text: string,
  context: TemporalContext,
): EventTime {
  const expression = findTemporalExpression(text);
  if (!expression) return unknownEventTime();

  const localNow = getZonedParts(new Date(context.currentTimeUtc), context.timeZone);
  const relativeDay = expression.match(/^(今天|昨天|前天)$/u)?.[1];
  if (relativeDay) {
    const offset = relativeDay === "今天" ? 0 : relativeDay === "昨天" ? -1 : -2;
    const localDay = addLocalDays(localNow.year, localNow.month, localNow.day, offset);
    const start = zonedDateTimeToUtc({ ...localDay, hour: 0, minute: 0, second: 0 }, context.timeZone);
    const next = addLocalDays(localDay.year, localDay.month, localDay.day, 1);
    const end = zonedDateTimeToUtc({ ...next, hour: 0, minute: 0, second: 0 }, context.timeZone);
    return rangeEvent(expression, "day", start, end, context.timeZone);
  }

  const dayMatch = expression.match(/^(\d{4})[年/-](\d{1,2})[月/-](\d{1,2})日?$/u);
  if (dayMatch) {
    const year = Number(dayMatch[1]);
    const month = Number(dayMatch[2]);
    const day = Number(dayMatch[3]);
    if (!isValidCalendarDate(year, month, day)) return fuzzyEvent(expression, context.timeZone);
    const start = zonedDateTimeToUtc({ year, month, day, hour: 0, minute: 0, second: 0 }, context.timeZone);
    const next = addLocalDays(year, month, day, 1);
    const end = zonedDateTimeToUtc({ ...next, hour: 0, minute: 0, second: 0 }, context.timeZone);
    return rangeEvent(expression, "day", start, end, context.timeZone);
  }

  const monthMatch = expression.match(/^(\d{4})年(\d{1,2})月$/u);
  if (monthMatch) {
    const year = Number(monthMatch[1]);
    const month = Number(monthMatch[2]);
    if (month < 1 || month > 12) return fuzzyEvent(expression, context.timeZone);
    const nextYear = month === 12 ? year + 1 : year;
    const nextMonth = month === 12 ? 1 : month + 1;
    return rangeEvent(
      expression,
      "month",
      zonedDateTimeToUtc({ year, month, day: 1, hour: 0, minute: 0, second: 0 }, context.timeZone),
      zonedDateTimeToUtc({ year: nextYear, month: nextMonth, day: 1, hour: 0, minute: 0, second: 0 }, context.timeZone),
      context.timeZone,
    );
  }

  if (expression === "去年夏天") {
    const year = localNow.year - 1;
    return rangeEvent(
      expression,
      "approximate",
      zonedDateTimeToUtc({ year, month: 6, day: 1, hour: 0, minute: 0, second: 0 }, context.timeZone),
      zonedDateTimeToUtc({ year, month: 9, day: 1, hour: 0, minute: 0, second: 0 }, context.timeZone),
      context.timeZone,
    );
  }

  if (expression === "去年") {
    const year = localNow.year - 1;
    return rangeEvent(
      expression,
      "year",
      zonedDateTimeToUtc({ year, month: 1, day: 1, hour: 0, minute: 0, second: 0 }, context.timeZone),
      zonedDateTimeToUtc({ year: year + 1, month: 1, day: 1, hour: 0, minute: 0, second: 0 }, context.timeZone),
      context.timeZone,
    );
  }

  if (/^(现在|目前|正在)$/u.test(expression)) {
    return {
      kind: "ongoing",
      start: null,
      end: null,
      precision: "approximate",
      expression,
      timeZone: context.timeZone,
    };
  }

  return fuzzyEvent(expression, context.timeZone);
}

function fuzzyEvent(expression: string, timeZone: string): EventTime {
  return {
    kind: "fuzzy",
    start: null,
    end: null,
    precision: "approximate",
    expression,
    timeZone,
  };
}

function findTemporalExpression(text: string): string | null {
  const patterns = [
    /\d{4}[年/-]\d{1,2}[月/-]\d{1,2}日?/u,
    /\d{4}年\d{1,2}月/u,
    /去年夏天/u,
    /(?:今天|昨天|前天|去年|现在|目前|正在|最近|以前|很久前)/u,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[0];
  }
  return null;
}

function unknownEventTime(): EventTime {
  return {
    kind: "unknown",
    start: null,
    end: null,
    precision: "unknown",
    expression: null,
    timeZone: null,
  };
}

function rangeEvent(
  expression: string,
  precision: EventTime["precision"],
  start: Date,
  end: Date,
  timeZone: string,
): EventTime {
  return {
    kind: "range",
    start: start.toISOString(),
    end: end.toISOString(),
    precision,
    expression,
    timeZone,
  };
}

type DateTimeParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

function getZonedParts(value: Date, timeZone: string): DateTimeParts {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const result: DateTimeParts = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 };
  for (const part of formatter.formatToParts(value)) {
    if (part.type === "year" || part.type === "month" || part.type === "day"
      || part.type === "hour" || part.type === "minute" || part.type === "second") {
      result[part.type] = Number(part.value);
    }
  }
  return result;
}

function zonedDateTimeToUtc(parts: DateTimeParts, timeZone: string): Date {
  const intended = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  let candidate = intended;
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const rendered = getZonedParts(new Date(candidate), timeZone);
    const renderedAsUtc = Date.UTC(rendered.year, rendered.month - 1, rendered.day, rendered.hour, rendered.minute, rendered.second);
    candidate -= renderedAsUtc - intended;
  }
  return new Date(candidate);
}

function addLocalDays(year: number, month: number, day: number, amount: number) {
  const shifted = new Date(Date.UTC(year, month - 1, day) + amount * DAY_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const value = new Date(Date.UTC(year, month - 1, day));
  return value.getUTCFullYear() === year
    && value.getUTCMonth() + 1 === month
    && value.getUTCDate() === day;
}
