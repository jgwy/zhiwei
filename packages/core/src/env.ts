import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ENV_LINE_PATTERN = /^([A-Z0-9_]+)=(.*)$/;

function parseEnvLine(line: string): Array<[string, string]> {
  const match = ENV_LINE_PATTERN.exec(line.trim());
  const key = match?.[1];
  const rawValue = match?.[2];
  if (key === undefined || rawValue === undefined) return [];
  const value = rawValue.trim().replace(/^["']|["']$/g, "");
  return [[key, value]];
}

// 从 monorepo 根目录加载 .env，不覆盖已存在的环境变量。
// 本地"Docker 只跑 Postgres、应用跑本地进程"的方式依赖它——Next 以 apps/web
// 为工作目录、tsx 不加载 env 文件，没有这一步 INTERNAL_MCP_TOKEN 等配置到不了进程。
// compose 部署时容器内没有根目录 .env，配置由 docker-compose 显式注入，此处自动跳过。
export function loadLocalEnv(filePath?: string): void {
  // webpack 打包产物里 import.meta.dirname 是 undefined，此时必须由调用方显式传路径。
  const envPath = filePath
    ?? (typeof import.meta.dirname === "string"
      ? resolve(import.meta.dirname, "../../../.env")
      : undefined);
  if (!envPath) return;
  let content: string;
  try {
    content = readFileSync(envPath, "utf8");
  } catch {
    return;
  }
  for (const line of content.split(/\r?\n/)) {
    for (const [key, value] of parseEnvLine(line)) {
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
}
