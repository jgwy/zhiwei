import type { NextConfig } from "next";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const rootEnv = fileURLToPath(new URL("../../.env", import.meta.url));
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: fileURLToPath(new URL("../..", import.meta.url)),
  reactCompiler: true,
  agentRules: false,
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
