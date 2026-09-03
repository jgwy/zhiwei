import { describe, expect, it } from "vitest";
import { parseJsonLoose } from "./gateway";

describe("parseJsonLoose", () => {
  it("parses plain JSON objects", () => {
    expect(parseJsonLoose('{"title":"新的话题"}')).toEqual({ title: "新的话题" });
  });

  it("parses JSON wrapped in a markdown code fence", () => {
    expect(parseJsonLoose('```json\n{"title":"新的话题"}\n```')).toEqual({ title: "新的话题" });
  });

  it("parses JSON inside a bare fence without a language tag", () => {
    expect(parseJsonLoose('```\n{"summary":"一句话"}\n```')).toEqual({ summary: "一句话" });
  });

  it("extracts the JSON object when prose surrounds it", () => {
    expect(parseJsonLoose('好的，以下是结果：{"title":"旅行计划"} 请查收。')).toEqual({ title: "旅行计划" });
  });

  it("strips a BOM before parsing", () => {
    expect(parseJsonLoose('\uFEFF{"title":"新的话题"}')).toEqual({ title: "新的话题" });
  });

  it("rethrows when nothing parseable exists", () => {
    expect(() => parseJsonLoose("完全不是 JSON 的回复")).toThrow();
  });
});
