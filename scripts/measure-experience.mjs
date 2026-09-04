import { chromium } from "@playwright/test";

const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}
const mode = option("--mode", "current");
const baseURL = new URL(option("--base-url", option("--baseURL", "http://127.0.0.1:3000")));
const repetitions = Number(option("--runs", "3"));
if (!["legacy", "current"].includes(mode)) throw new Error("--mode must be legacy or current");
if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 10) throw new Error("--runs must be 1–10");
if (!["127.0.0.1", "localhost", "[::1]"].includes(baseURL.hostname)) throw new Error("Only a local application URL is supported");

const timestamp = "2026-09-04T00:00:00.000Z";
const syntheticText = "这一周，我一边准备下周的课程展示，一边适应新的合作节奏。让我在意的并不是完成得够不够快，而是能不能把自己的想法说清楚，也认真听到对方的具体顾虑。今天我们先从一件真实发生的小事慢慢聊起。";
const conversations = Array.from({ length: 50 }, (_, conversationIndex) => {
  const id = `conversation-${conversationIndex + 1}`;
  return {
    id, title: `第 ${conversationIndex + 1} 段对话`, titleSource: "model", titleLocked: false,
    createdAt: timestamp, updatedAt: timestamp, messageCount: 80,
    messages: Array.from({ length: 80 }, (_, index) => ({
      id: `${id}-message-${index + 1}`, role: index % 2 ? "assistant" : "user", content: syntheticText,
      createdAt: new Date(Date.parse(timestamp) + index * 1_000).toISOString(),
      metadata: { status: "completed" },
    })),
  };
});
const shared = {
  user: { id: "performance-fixture", onboarding_complete: true, settings: {} },
  profile: null, memories: [], mood: [], skill: null,
  onboarding: { complete: true, answeredCount: 3, canFinish: true, question: null },
  returnNote: null, developerModeAvailable: true, adapter: "scripted", modelModeLabel: "免费性能样例",
  modelCapabilities: { streaming: true, structuredOutput: true, toolCalls: true, nativeWebSearch: false, usage: true, maxContextTokens: 32_000 },
};
const bootstrap = mode === "legacy" ? { ...shared, conversations } : {
  ...shared, conversations: conversations.map(({ messages, ...metadata }) => metadata),
  activeConversationId: conversations[0].id,
  messagePage: { messages: conversations[0].messages, hasMore: false, nextCursor: null },
};
const bootstrapBody = JSON.stringify(bootstrap);
const browser = await chromium.launch();
const results = [];

try {
  for (let run = 1; run <= repetitions; run += 1) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "zh-CN", serviceWorkers: "block" });
    const page = await context.newPage();
    const apiRequests = [];
    const unexpectedApiRequests = [];
    const pageErrors = [];
    const networkRequests = new Map();
    const staticJavaScript = [];
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
    cdp.on("Network.responseReceived", ({ requestId, response, type }) => {
      networkRequests.set(requestId, { url: response.url, mimeType: response.mimeType, type });
    });
    cdp.on("Network.loadingFinished", ({ requestId, encodedDataLength }) => {
      const response = networkRequests.get(requestId);
      if (response?.type === "Script" && new URL(response.url).origin === baseURL.origin) {
        staticJavaScript.push({ path: new URL(response.url).pathname, encodedTransferBytes: encodedDataLength });
      }
    });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.addInitScript(() => {
      const observer = new MutationObserver(() => {
        if (!document.querySelector(".chat-composer textarea")) return;
        window.__experienceFirstComposerMs = performance.now();
        observer.disconnect();
      });
      observer.observe(document, { childList: true, subtree: true });
    });
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== baseURL.origin) { await route.abort(); return; }
      if (!url.pathname.startsWith("/api/")) { await route.continue(); return; }
      let body;
      let status = 200;
      let contentType = "application/json";
      if (route.request().method() === "GET" && url.pathname === "/api/bootstrap") body = bootstrapBody;
      else if (route.request().method() === "GET" && /^\/api\/conversations\/[^/]+\/messages$/.test(url.pathname)) {
        const id = url.pathname.split("/")[3];
        const conversation = conversations.find((item) => item.id === id);
        if (!conversation) throw new Error(`Unknown fixture conversation: ${id}`);
        body = JSON.stringify({ messages: conversation.messages, hasMore: false, nextCursor: null });
      } else if (url.pathname === "/api/activity/stream") {
        contentType = "text/event-stream";
        body = ": offline performance fixture\n\n";
      } else {
        status = 501;
        unexpectedApiRequests.push({ method: route.request().method(), path: `${url.pathname}${url.search}` });
        body = JSON.stringify({ error: "性能样例不提供此接口" });
      }
      apiRequests.push({ method: route.request().method(), path: `${url.pathname}${url.search}`, mockedResponseBytes: Buffer.byteLength(body) });
      await route.fulfill({ status, contentType, body });
    });
    await page.goto(baseURL.href, { waitUntil: "domcontentloaded" });
    await page.getByLabel("消息内容").waitFor({ state: "visible", timeout: 30_000 });
    // Both versions get the same quiet period; current-mode idle prefetch is included.
    await page.waitForTimeout(2_000);
    await cdp.send("HeapProfiler.collectGarbage");
    const heap = await cdp.send("Runtime.getHeapUsage");
    const dom = await cdp.send("Memory.getDOMCounters");
    const measuredPage = await page.evaluate(() => ({
      firstComposerMs: window.__experienceFirstComposerMs,
      renderedElements: document.querySelectorAll("*").length,
      renderedMessages: document.querySelectorAll(".messages .message").length,
      scrollHeight: document.querySelector(".message-scroll")?.scrollHeight,
      staticJavaScriptDecodedBytes: performance.getEntriesByType("resource")
        .filter((entry) => entry.initiatorType === "script")
        .reduce((sum, entry) => sum + entry.decodedBodySize, 0),
    }));
    results.push({ run, ...measuredPage, heapUsedBytes: heap.usedSize, heapTotalBytes: heap.totalSize,
      dom: { documents: dom.documents, nodes: dom.nodes, eventListeners: dom.jsEventListeners },
      bootstrapResponseBytes: Buffer.byteLength(bootstrapBody),
      mockedApiTotalResponseBytes: apiRequests.reduce((sum, request) => sum + request.mockedResponseBytes, 0),
      staticJavaScriptTransferBytes: staticJavaScript.reduce((sum, resource) => sum + resource.encodedTransferBytes, 0),
      staticJavaScript, apiRequests, unexpectedApiRequests, pageErrors,
    });
    await context.close();
  }
} finally { await browser.close(); }

const median = (key) => {
  const values = results.map((result) => result[key]).sort((left, right) => left - right);
  const middle = Math.floor(values.length / 2);
  return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
};
const metrics = ["firstComposerMs", "heapUsedBytes", "heapTotalBytes", "renderedElements", "renderedMessages", "bootstrapResponseBytes", "mockedApiTotalResponseBytes", "staticJavaScriptTransferBytes", "staticJavaScriptDecodedBytes"];
process.stdout.write(`${JSON.stringify({
  mode, baseURL: baseURL.href, measuredAt: new Date().toISOString(), browser: "Chromium", runs: repetitions,
  fixture: { conversations: 50, messagesPerConversation: 80, totalMessages: 4_000, bootstrapMessages: mode === "legacy" ? 4_000 : 80, viewport: "1280×800", idleSettleMs: 2_000 },
  method: { api: "All API requests are fulfilled locally; no user data or model calls are created", heap: "Chromium Runtime.getHeapUsage after explicit GC", staticJavaScriptTransfer: "CDP encodedDataLength; includes response overhead and excludes mocked API bodies", timing: "Navigation-relative first rendered composer; local static asset/server time included", animations: "Unchanged application settings", cache: "Fresh browser context and disabled HTTP cache each run" },
  median: Object.fromEntries(metrics.map((key) => [key, median(key)])), results,
}, null, 2)}\n`);
if (results.some((result) => result.unexpectedApiRequests.length || result.pageErrors.length || result.renderedMessages !== 80)) process.exitCode = 1;
