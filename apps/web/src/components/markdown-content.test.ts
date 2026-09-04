import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownContent } from "./markdown-content";

function html(content: string) {
  return renderToStaticMarkup(createElement(MarkdownContent, { content }));
}

describe("assistant markdown", () => {
  it("compiles emphasis, lists, tables and fenced code", () => {
    const markup = html([
      "**加粗** 和 *斜体*",
      "",
      "- 列表一项",
      "",
      "| 列 | 值 |",
      "| --- | --- |",
      "| a | 1 |",
      "",
      "```js",
      "const x = 1;",
      "```",
    ].join("\n"));

    expect(markup).toContain('class="message-markdown"');
    expect(markup).toContain("<strong>加粗</strong>");
    expect(markup).toContain("<em>斜体</em>");
    expect(markup).toContain("<li>列表一项</li>");
    expect(markup).toContain("<table>");
    expect(markup).toContain("<th>列</th>");
    expect(markup).toContain("<pre>");
    expect(markup).toContain("const x = 1;");
  });

  it("opens http links in a new tab and drops javascript urls and images", () => {
    const markup = html("[安全](https://example.com) [邮件](mailto:hi@example.com) [危险](javascript:alert(1)) ![图](https://example.com/x.png)");

    expect(markup).toContain('href="https://example.com"');
    expect(markup).toContain('href="mailto:hi@example.com"');
    expect(markup).toContain('target="_blank"');
    expect(markup).toContain('rel="noreferrer"');
    expect(markup).toContain("危险");
    expect(markup).not.toContain("javascript:");
    expect(markup).not.toContain("<img");
  });
});
