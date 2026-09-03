import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const outputDirectory = resolve(projectRoot, "submission", "source");
const outputFile = resolve(outputDirectory, "zhiwei-source.zip");

mkdirSync(outputDirectory, { recursive: true });
const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
  cwd: projectRoot,
  encoding: "utf8",
}).trim();
if (dirty) {
  console.error("拒绝打包：工作区仍有未提交变化。提交或明确清理后再生成比赛源码包。\n");
  console.error(dirty);
  process.exit(1);
}
execFileSync(
  "git",
  ["archive", "--format=zip", `--output=${outputFile}`, "HEAD"],
  { cwd: projectRoot, stdio: "inherit" },
);

console.log(outputFile);
