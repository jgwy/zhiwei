const KNOWN_INSECURE_DEFAULTS = new Set([
  "local-development-cookie-secret-change-before-deploy",
  "local-development-mcp-token",
]);

export function isProductionRuntime(): boolean {
  return process.env.NODE_ENV === "production"
    || process.env.ZHIWI_FORCE_PRODUCTION_CHECKS === "true"
    || process.env.COMPETITION_MODE === "true";
}

export function resolveSecret(name: string, fallback: string): string {
  const value = process.env[name];
  if (value) {
    if (isProductionRuntime() && KNOWN_INSECURE_DEFAULTS.has(value)) {
      throw new Error(`生产或比赛环境禁止使用公开默认密钥：${name}。请替换为随机值后重启。`);
    }
    if (isProductionRuntime() && value.length < 32) {
      throw new Error(`生产或比赛环境的密钥长度不足：${name}。请使用至少 32 字符的随机值。`);
    }
    return value;
  }
  if (isProductionRuntime()) {
    throw new Error(`生产或比赛环境缺少必需的密钥：${name}。请在服务端显式设置后重启。`);
  }
  return fallback;
}
