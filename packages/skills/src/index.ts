import manifest from "../manifest.json";

export type FoundationSkill = {
  name: string;
  description: string;
  version: string;
  sha256: string;
  content: string;
};

export const foundationSkills = manifest.skills as FoundationSkill[];

export function getFoundationSkill(name: string): FoundationSkill {
  const skill = foundationSkills.find((item) => item.name === name);
  if (!skill) throw new Error(`未找到基底 Skill：${name}`);
  return skill;
}

export function composeFoundationInstructions(names: string[]): string {
  return names
    .map((name) => getFoundationSkill(name))
    .map((skill) => `<skill name="${skill.name}" version="${skill.version}">\n${skill.content}\n</skill>`)
    .join("\n\n");
}

