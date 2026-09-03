import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
      "@zhiwei/core": resolve(__dirname, "../../packages/core/src/index.ts"),
      "@zhiwei/core/client": resolve(__dirname, "../../packages/core/src/client.ts"),
      "@zhiwei/model-gateway": resolve(__dirname, "../../packages/model-gateway/src/index.ts"),
      "@zhiwei/skills": resolve(__dirname, "../../packages/skills/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    exclude: ["tests/e2e/**", "**/node_modules/**"],
  },
});
