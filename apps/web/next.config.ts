import { loadEnvConfig } from "@next/env";
import type { NextConfig } from "next";

// Next 只加载 apps/web 下的 env 文件；根目录 .env 承载本地进程运行所需的配置。
// 已存在的环境变量优先，compose 注入的容器配置不受影响。
loadEnvConfig(new URL("../..", import.meta.url).pathname, process.env.NODE_ENV !== "production");

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: new URL("../..", import.meta.url).pathname,
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

