import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadLocalEnv } from "./env";

const createdDirs: string[] = [];

afterEach(() => {
  for (const dir of createdDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete process.env.LOAD_ENV_TEST_ALPHA;
  delete process.env.LOAD_ENV_TEST_BETA;
});

function writeTempEnv(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "zhiwei-env-"));
  createdDirs.push(dir);
  const filePath = join(dir, ".env");
  writeFileSync(filePath, content, "utf8");
  return filePath;
}

describe("loadLocalEnv", () => {
  it("loads missing keys, strips quotes, and skips invalid lines", () => {
    const filePath = writeTempEnv(
      'LOAD_ENV_TEST_ALPHA=hello\nLOAD_ENV_TEST_BETA="quoted value"\n# comment\nINVALID LINE\n',
    );
    loadLocalEnv(filePath);
    expect(process.env.LOAD_ENV_TEST_ALPHA).toBe("hello");
    expect(process.env.LOAD_ENV_TEST_BETA).toBe("quoted value");
  });

  it("does not override variables that already exist in the environment", () => {
    process.env.LOAD_ENV_TEST_ALPHA = "existing";
    const filePath = writeTempEnv("LOAD_ENV_TEST_ALPHA=from-file\n");
    loadLocalEnv(filePath);
    expect(process.env.LOAD_ENV_TEST_ALPHA).toBe("existing");
  });

  it("is a silent no-op when the env file does not exist", () => {
    expect(() => loadLocalEnv(join(tmpdir(), "zhiwei-env-not-here", ".env"))).not.toThrow();
  });
});
