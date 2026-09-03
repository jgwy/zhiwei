import { cp, mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";

const projectRoot = resolve(import.meta.dirname, "..");
const workspaces = ["apps/worker", "apps/memory-mcp", "apps/science-mcp", "packages/core", "packages/model-gateway", "packages/skills"];
const manifests = await Promise.all(workspaces.map(async (workspace) => JSON.parse(await readFile(resolve(projectRoot, workspace, "package.json"), "utf8"))));
const external = [...new Set(manifests.flatMap((manifest) => Object.keys(manifest.dependencies ?? {})))].filter((name) => !name.startsWith("@zhiwei/"));

await build({
  absWorkingDir: projectRoot,
  entryPoints: {
    "apps/worker/worker": "apps/worker/src/worker.ts",
    "apps/memory-mcp/server": "apps/memory-mcp/src/server.ts",
    "apps/science-mcp/server": "apps/science-mcp/src/server.ts",
    "packages/core/scripts/migrate": "packages/core/scripts/migrate.ts",
  },
  outdir: "dist",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  external,
  tsconfig: "tsconfig.base.json",
  minifySyntax: true,
  legalComments: "none",
  logLevel: "info",
});

await mkdir(resolve(projectRoot, "dist/packages/core"), { recursive: true });
await cp(resolve(projectRoot, "packages/core/migrations"), resolve(projectRoot, "dist/packages/core/migrations"), { recursive: true });
