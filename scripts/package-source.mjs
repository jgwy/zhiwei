import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const outputDirectory = resolve(projectRoot, "submission", "source");
const outputFile = resolve(outputDirectory, "zhiwei-source.zip");

mkdirSync(outputDirectory, { recursive: true });
execFileSync(
  "git",
  ["archive", "--format=zip", `--output=${outputFile}`, "HEAD"],
  { cwd: projectRoot, stdio: "inherit" },
);

console.log(outputFile);
