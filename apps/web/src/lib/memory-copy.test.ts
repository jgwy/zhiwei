import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("ordinary memory update copy", () => {
  it("uses the same wording in the actual worker receipt and browser fallback", () => {
    const worker = readFileSync(new URL("../../../worker/src/worker.ts", import.meta.url), "utf8");
    const browser = readFileSync(new URL("../components/zhiwei-app.tsx", import.meta.url), "utf8");
    const receipt = "知微重新整理了对你的总体印象。";
    expect(worker).toContain(`const receipt = "${receipt}"`);
    expect(browser).toContain(`payload.receipt : "${receipt}"`);
  });

  it("uses the updated term for the first understanding score explanation", () => {
    const repository = readFileSync(new URL("../../../../packages/core/src/repository.ts", import.meta.url), "utf8");
    expect(repository).toContain('message: "形成了第一轮长期印象。"');
  });
});
