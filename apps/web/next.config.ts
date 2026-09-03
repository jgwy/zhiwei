import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

// Windows 下 URL.pathname 会带前导斜杠和百分号编码，必须用 fileURLToPath 转换，
// 否则 outputFileTracingRoot 指向错乱的嵌套目录。
const monorepoRoot = fileURLToPath(new URL("../..", import.meta.url));

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

