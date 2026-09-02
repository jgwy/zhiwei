import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const foundationRoot = join(packageRoot, "foundation");
const manifest = JSON.parse(await readFile(join(packageRoot, "manifest.json"), "utf8"));
const required = [
  "zhiwei-persona",
  "dialogue-orchestrator",
  "onboarding-interview",
  "memory-reflection",
  "profile-synthesis",
  "emotion-and-return",
  "fact-and-tool-use",
  "personal-skill-evolver",
  "privacy-and-withdrawal",
  "risk-and-boundary",
  "scientific-answering",
];
for (const name of required) {
  const skill = manifest.skills.find((item) => item.name === name);
  if (!skill) throw new Error(`基底 Skill 清单缺少 ${name}`);
  if (!/^[a-f0-9]{64}$/.test(skill.sha256)) throw new Error(`${name} 的 SHA-256 无效`);

  const skillPath = join(foundationRoot, name, "SKILL.md");
  const content = await readFile(skillPath, "utf8");
  const currentHash = createHash("sha256").update(content).digest("hex");
  if (skill.sha256 !== currentHash || skill.content !== content) {
    throw new Error(`${name} 的 manifest 内容不是最新版本`);
  }

  const referenceLinks = [...content.matchAll(/\]\((references\/[^)]+\.md)\)/g)].map(
    (match) => match[1],
  );
  for (const reference of referenceLinks) {
    const referencePath = join(foundationRoot, name, reference);
    if (!(await stat(referencePath)).isFile()) {
      throw new Error(`${name} 引用的文档不存在：${reference}`);
    }
  }
}
const folders = (await readdir(foundationRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);
if (manifest.skills.length !== required.length || folders.length !== required.length) {
  throw new Error(`应恰好包含 ${required.length} 个基底 Skills`);
}
process.stdout.write(`Validated ${required.length} foundation skills.\n`);
