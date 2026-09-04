"use client";

import { createElement, memo } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";

const remarkPlugins = [remarkGfm];

function safeHref(href?: string) {
  if (!href) return undefined;
  try {
    const url = new URL(href, "https://zhiwei.local");
    if (url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:") return href;
  } catch {
    return undefined;
  }
  return undefined;
}

const markdownComponents: Components = {
  a({ href, children }) {
    const safe = safeHref(href);
    if (!safe) return children;
    return createElement("a", { href: safe, target: "_blank", rel: "noreferrer" }, children);
  },
  img() {
    return null;
  },
};

export const MarkdownContent = memo(function MarkdownContent({ content }: { content: string }) {
  return createElement(
    "div",
    { className: "message-markdown" },
    createElement(Markdown, { remarkPlugins, components: markdownComponents }, content),
  );
});
