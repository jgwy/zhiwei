const KNOWN_INSECURE_DEFAULTS = new Set([
  "local-development-cookie-secret-change-before-deploy",
  "local-development-mcp-token",
]);

export function isProductionRuntime(): boolean {
  return (
    process.env.NODE_ENV === "production"
    || process.env.ZHIWI_FORCE_PRODUCTION_CHECKS === "true"
  );
}

function warnInsecureDefault(name: string): void {
  process.stderr.write(
    `[zhiwei] 警告：${name} 仍在使用公开的本地开发默认值，生产环境必须替换为随机值。\n`,
  );
}

export function resolveSecret(name: string, fallback: string): string {
  const value = process.env[name];
  if (value && value.length > 0) {
    if (isProductionRuntime() && KNOWN_INSECURE_DEFAULTS.has(value)) warnInsecureDefault(name);
    return value;
  }
  if (isProductionRuntime()) {
    throw new Error(
      `生产环境缺少必需的密钥：${name}。请在服务端显式设置后重启。`,
    );
  }
  return fallback;
}
