type RateWindow = { count: number; resetAt: number };

export type RateLimitRule = { windowMs: number; max: number };

const buckets = new Map<string, RateWindow[]>();
let lastSweepAt = 0;

function sweep(now: number) {
  if (now - lastSweepAt < 60_000) return;
  lastSweepAt = now;
  for (const [key, windows] of buckets) {
    if (windows.every((window) => window.resetAt <= now)) buckets.delete(key);
  }
}

/**
 * 进程内滑动窗口限流。所有窗口都有余量才放行并计数；
 * 任一窗口超出上限即拒绝。供单实例部署使用，多实例需换集中式存储。
 */
export function consumeRateLimit(
  key: string,
  rules: RateLimitRule[] = defaultRules(),
  now = Date.now(),
): boolean {
  sweep(now);
  const windows = buckets.get(key) ?? [];
  const next: RateWindow[] = [];
  for (const [index, rule] of rules.entries()) {
    const window = windows[index];
    if (!window || window.resetAt <= now) next.push({ count: 0, resetAt: now + rule.windowMs });
    else next.push(window);
  }
  for (const [index, rule] of rules.entries()) {
    if (next[index]!.count >= rule.max) {
      buckets.set(key, next);
      return false;
    }
  }
  for (const window of next) window.count += 1;
  buckets.set(key, next);
  return true;
}

export function resetRateLimits(): void {
  buckets.clear();
}

function defaultRules(): RateLimitRule[] {
  return [
    {
      windowMs: 60_000,
      max: Number(process.env.MESSAGE_RATE_LIMIT_PER_MINUTE ?? 10),
    },
    {
      windowMs: 3_600_000,
      max: Number(process.env.MESSAGE_RATE_LIMIT_PER_HOUR ?? 120),
    },
  ];
}
