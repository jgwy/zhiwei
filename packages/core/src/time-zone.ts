export const DEFAULT_TIME_ZONE = "Asia/Shanghai";

export function normalizeTimeZone(timeZone?: string | null): string {
  if (!timeZone || /^[+-]/.test(timeZone)) return DEFAULT_TIME_ZONE;
  try {
    return new Intl.DateTimeFormat("en", { timeZone }).resolvedOptions().timeZone;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}
