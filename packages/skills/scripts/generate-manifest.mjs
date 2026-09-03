import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "foundation");
const folders = (await readdir(root, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

const skills = [];
for (const folder of folders) {
  const content = await readFile(join(root, folder, "SKILL.md"), "utf8");
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!frontmatter) throw new Error(`${folder}/SKILL.md 缺少 YAML frontmatter`);
  const name = frontmatter[1].match(/^name:\s*"?([^"\n]+)"?$/m)?.[1]?.trim();
  const description = frontmatter[1].match(/^description:\s*"?([^"\n]+)"?$/m)?.[1]?.trim();
  if (!name || !description) throw new Error(`${folder}/SKILL.md 缺少 name 或 description`);
  if (name !== folder) throw new Error(`${folder}/SKILL.md 的 name 必须与目录一致`);
  if (/TODO|TBD|placeholder|稍后替换/i.test(content)) {
    throw new Error(`${folder}/SKILL.md 含未完成文本`);
  }
  skills.push({
    name,
    description,
    version: "1.0.0",
    sha256: createHash("sha256").update(content).digest("hex"),
    content,
  });
}

await writeFile(
  join(root, "..", "manifest.json"),
  `${JSON.stringify({ skills }, null, 2)}\n`,
);
