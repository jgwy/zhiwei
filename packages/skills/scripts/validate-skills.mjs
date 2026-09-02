import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
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
];
for (const name of required) {
  const skill = manifest.skills.find((item) => item.name === name);
  if (!skill) throw new Error(`基底 Skill 清单缺少 ${name}`);
  if (!/^[a-f0-9]{64}$/.test(skill.sha256)) throw new Error(`${name} 的 SHA-256 无效`);
}
if (manifest.skills.length !== required.length) {
  throw new Error(`应恰好包含 ${required.length} 个基底 Skills`);
}
process.stdout.write(`Validated ${required.length} foundation skills.\n`);

