import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { pathToFileURL } from "node:url";

export async function setupEnv(projectRoot) {
  const envPath = resolve(projectRoot, ".env");
  let created = false;
  let source;
  try {
    source = await readFile(envPath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    source = await readFile(resolve(projectRoot, ".env.example"), "utf8");
    created = true;
  }

  const values = parseEnv(source);
  let generated = 0;
  for (const name of ["ANON_COOKIE_SECRET", "INTERNAL_MCP_TOKEN"]) {
    if (values[name]?.trim()) continue;
    const assignment = `${name}=${randomBytes(32).toString("hex")}`;
    const pattern = new RegExp(`^[ \\t]*(?:export[ \\t]+)?${name}[ \\t]*=.*$`, "gm");
    source = pattern.test(source)
      ? source.replace(pattern, assignment)
      : `${source}${source.endsWith("\n") ? "" : "\n"}${assignment}\n`;
    generated++;
  }
  if (created || generated > 0) await writeFile(envPath, source, { mode: 0o600 });
  return { created, generated };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await setupEnv(resolve(import.meta.dirname, ".."));
  console.log(result.created ? "已创建 .env，并生成本地身份与内部通信密钥。" : result.generated ? "已补全 .env 中缺失的内部密钥，其他配置保持不变。" : ".env 配置已存在，未作修改。");
}
