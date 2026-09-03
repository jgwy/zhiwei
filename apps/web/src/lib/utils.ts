import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export async function readSseStream(
  response: Response,
  onEvent: (event: any) => void,
) {
  if (!response.body) throw new Error("服务器没有返回流式内容");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() ?? "";
    for (const block of blocks) {
      const data = block
        .split("\n")
        .find((line) => line.startsWith("data: "))
        ?.slice(6);
      if (data) onEvent(JSON.parse(data));
    }
  }
}

export function formatTime(value: string, timeZone?: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
  }).format(new Date(value));
}

export function formatRelativeDateTime(value: string, now = new Date()) {
  const delta = now.getTime() - new Date(value).getTime();
  if (Math.abs(delta) < 60_000) return delta < 0 ? "马上" : "刚刚";
  const relative = new Intl.RelativeTimeFormat("zh-CN", { numeric: "auto" });
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["year", 365 * 86_400_000],
    ["month", 30 * 86_400_000],
    ["day", 86_400_000],
    ["hour", 3_600_000],
    ["minute", 60_000],
  ];
  const [unit, size] = units.find(([, candidate]) => Math.abs(delta) >= candidate) ?? ["minute", 60_000];
  return relative.format(-Math.round(delta / size), unit);
}

export function formatFullTime(value: string, timeZone?: string) {
  return `${new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone,
  }).format(new Date(value))}${timeZone ? ` · ${timeZone}` : ""}`;
}

export function formatDateDivider(value: string, timeZone?: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "short",
    timeZone,
  }).format(new Date(value));
}

export function localDateKey(value: string, timeZone?: string) {
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone,
  }).format(new Date(value));
}

