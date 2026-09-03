import { afterEach, describe, expect, it } from "vitest";
import { validateCompetitionModelConfig } from "./gateway";

const originalEnv = { ...process.env };
afterEach(() => { process.env = { ...originalEnv }; });

describe("competition model configuration", () => {
  it("rejects simulator providers and non-Qwen models", () => {
    process.env.COMPETITION_MODE = "true";
    process.env.MODEL_BASE_URL = "https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1";
    expect(() => validateCompetitionModelConfig("scripted")).toThrow(/百炼/);
    process.env.MODEL_DIALOGUE_NAME = "other-model";
    expect(() => validateCompetitionModelConfig("aliyun-bailian")).toThrow(/Qwen/);
  });

  it("rejects a non-Bailian endpoint and accepts the official compatible endpoint shape", () => {
    process.env.COMPETITION_MODE = "true";
    process.env.MODEL_DIALOGUE_NAME = "qwen-plus-character";
    process.env.MODEL_BACKGROUND_NAME = "qwen3.8-flash";
    process.env.MODEL_EMBEDDING_NAME = "qwen3.7-text-embedding";
    process.env.MODEL_BASE_URL = "https://example.com/v1";
    expect(() => validateCompetitionModelConfig("aliyun-bailian")).toThrow(/百炼/);
    process.env.MODEL_BASE_URL = "https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1";
    expect(() => validateCompetitionModelConfig("aliyun-bailian")).not.toThrow();
  });
});
