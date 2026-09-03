import { loadEnvConfig } from "@next/env";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

// Windows 下 URL.pathname 会带前导斜杠和百分号编码，必须用 fileURLToPath 转换，
// 否则 outputFileTracingRoot 指向错乱的嵌套目录。
const monorepoRoot = fileURLToPath(new URL("../..", import.meta.url));

// Next 只加载 apps/web 下的 env 文件；根目录 .env 承载本地进程运行所需的配置。
// 已存在的环境变量优先，compose 注入的容器配置不受影响。
loadEnvConfig(monorepoRoot, process.env.NODE_ENV !== "production");

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: monorepoRoot,
  transpilePackages: ["@zhiwei/core", "@zhiwei/model-gateway", "@zhiwei/skills"],
  async headers() {
    return [
      {
        source: "/api/:path*",
        headers: [
          { key: "X-Accel-Buffering", value: "no" },
          { key: "Cache-Control", value: "no-store" },
        ],
      },
    ];
  },
};

export default nextConfig;

