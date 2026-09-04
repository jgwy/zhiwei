import { expect, test, type Page } from "@playwright/test";

const message = (id: string, role = "user", content = id) => ({ id, role, content, createdAt: "2026-09-04T00:00:00.000Z", metadata: { status: "completed" } });
const conversation = (id: string) => ({ id, title: `对话 ${id}`, titleSource: "default", titleLocked: false, messageCount: 0, createdAt: "2026-09-04T00:00:00.000Z", updatedAt: "2026-09-04T00:00:00.000Z" });

async function mockApp(page: Page, history = false, withMood: boolean | "single" = false) {
  const requests: string[] = [];
  const messages = history ? Array.from({ length: 80 }, (_, index) => message(`recent-${index}`, index % 2 ? "assistant" : "user", `当前消息 ${index}：这是一段用来验证真实页面滚动位置的内容。`)) : [];
  await page.addInitScript(() => {
    const state = window as any;
    state.testStreams = [];
    state.testActivity = null;
    state.EventSource = class extends EventTarget {
      constructor() { super(); state.testActivity = this; }
      close() {}
    };
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input: RequestInfo | URL, options?: RequestInit) => {
      const url = String(input);
      if (options?.method !== "POST" || !url.includes("/api/conversations/") || !url.includes("/messages")) return originalFetch(input, options);
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const encoder = new TextEncoder();
      const index = state.testStreams.length;
      const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
      const entry = { url, body: JSON.parse(String(options.body)), push(event: unknown) { controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)); }, close() { controller.close(); } };
      state.testStreams.push(entry);
      const userMessage = { id: `server-user-${index}`, role: "user", content: entry.body.content ?? "第一次的问题", createdAt: new Date().toISOString() };
      entry.push({ type: "message.started", messageId: `server-assistant-${index}`, userMessage: url.endsWith("/retry") ? { ...userMessage, id: "server-user-0" } : userMessage, traceId: `trace-${index}` });
      options.signal?.addEventListener("abort", () => controller.error(new DOMException("已停止", "AbortError")), { once: true });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    };
  });
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    requests.push(`${url.pathname}${url.search}`);
    const payload = url.pathname === "/api/bootstrap" ? {
      user: { id: "mock-user", onboarding_complete: true, settings: {} },
      conversations: [conversation("one"), conversation("two"), conversation("three"), conversation("four")],
      activeConversationId: "one", messagePage: { messages, hasMore: history, nextCursor: history ? "before-recent" : null },
      profile: null, memories: [], mood: withMood ? [{ day: "2026-09-03", score: -1, summary: "准备课程展示，有一点紧张。" }, { day: "2026-09-04", score: 2, summary: "完成展示后，心情轻松了些。" }].slice(0, withMood === "single" ? 1 : 2) : [], skill: null, onboarding: { complete: true, answeredCount: 3, canFinish: true, question: null },
      returnNote: null, developerModeAvailable: true, adapter: "scripted", modelModeLabel: "测试模式", modelCapabilities: {},
    } : url.pathname === "/api/memories" ? { memories: [] }
      : url.pathname === "/api/profile" ? { profile: null }
      : url.pathname === "/api/mood" ? { mood: [] }
      : url.pathname.endsWith("/messages") ? { messages: url.searchParams.has("before") ? Array.from({ length: 80 }, (_, index) => message(`older-${index}`, "user", `更早消息 ${index}`)) : [], hasMore: false, nextCursor: null }
      : url.pathname === "/api/dev/data" ? { traces: [], memories: [], profiles: [], skills: [], mcpCalls: [], modelRuns: [], foundationSkills: [], competition: { runs: [], risks: [], withdrawals: [], conversations: [] } }
      : url.pathname === "/api/dev/model-costs" ? { totals: {}, runs: [{ id: "cost-1", role: "dialogue", model_name: "mock-model", created_at: "2026-09-04T00:00:00.000Z", status: "completed", first_delta_ms: 40 }], pricing: [], searchPricing: { turboPerCallCny: 0.003, maxPerCallCny: 0.004 }, disclaimer: "费用估算，不等同于阿里云账单。" }
      : {};
    await route.fulfill({ json: payload });
  });
  await page.goto("/");
  await expect(page.getByLabel("消息内容")).toBeVisible();
  return requests;
}

async function push(page: Page, index: number, event: Record<string, unknown>) {
  await page.evaluate(({ index, event }) => (window as any).testStreams[index].push(event), { index, event });
}

test("助手消息编译 markdown，用户消息保持原文", async ({ page }) => {
  await mockApp(page);
  const composer = page.getByLabel("消息内容");
  await composer.fill("**我自己打的星号**");
  await page.getByRole("button", { name: "发送消息" }).click();
  await push(page, 0, { type: "text.delta", delta: "**核心结论**\n\n- 第一点\n- 第二点" });
  await push(page, 0, { type: "message.completed", messageId: "server-assistant-0", status: "completed" });
  await expect(page.locator(".message.user .message-content")).toHaveText("**我自己打的星号**");
  await expect(page.locator(".message.user strong")).toHaveCount(0);
  const markdown = page.locator(".message.assistant .message-markdown");
  await expect(markdown.locator("strong")).toHaveText("核心结论");
  await expect(markdown.locator("li")).toHaveText(["第一点", "第二点"]);
});

test("增量先于完成显示，后台刷新不吞回合，旧 SSE 不干扰下一轮", async ({ page }) => {
  const requests = await mockApp(page);
  await expect(page.locator(".empty-chart")).toHaveCount(1);
  await expect(page.locator(".mood-chart .recharts-responsive-container")).toHaveCount(0);
  const bootstrapCount = requests.filter((path) => path.startsWith("/api/bootstrap")).length;
  const composer = page.getByLabel("消息内容");
  await composer.fill("第一次的问题");
  await page.getByRole("button", { name: "发送消息" }).click();
  await push(page, 0, { type: "text.delta", delta: "先接住你的具体处境，" });
  await expect(page.getByText("先接住你的具体处境，", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "停止回复" })).toBeVisible();
  await page.evaluate(() => (window as any).testActivity.dispatchEvent(new MessageEvent("memory.updated", { data: JSON.stringify({ payload: {} }) })));
  await expect.poll(() => requests.includes("/api/memories")).toBe(true);
  await expect(page.getByText("第一次的问题", { exact: true })).toHaveCount(1);
  await expect(page.getByText("先接住你的具体处境，", { exact: true })).toBeVisible();
  expect(requests.filter((path) => path.startsWith("/api/bootstrap"))).toHaveLength(bootstrapCount);
  await push(page, 0, { type: "message.completed", messageId: "server-assistant-0", status: "completed" });
  await expect(page.getByRole("button", { name: "发送消息" })).toBeVisible();
  await composer.fill("下一句");
  await page.getByRole("button", { name: "发送消息" }).click();
  await push(page, 0, { type: "text.delta", delta: "不该出现的旧请求内容" });
  await push(page, 0, { type: "message.completed", messageId: "server-assistant-0" });
  await expect(page.getByRole("button", { name: "停止回复" })).toBeVisible();
  await push(page, 1, { type: "text.delta", delta: "这是第二轮的回应。" });
  await push(page, 1, { type: "message.completed", messageId: "server-assistant-1", status: "completed" });
  await expect(page.getByText("这是第二轮的回应。", { exact: true })).toBeVisible();
  await expect(page.getByText("不该出现的旧请求内容", { exact: false })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "重新生成", exact: true })).toHaveCount(1);
});

test("有心情数据时按需加载原样曲线与尺寸", async ({ page }, testInfo) => {
  await mockApp(page, false, true);
  if (testInfo.project.name.includes("mobile")) await page.getByRole("button", { name: "打开或收起洞察栏" }).click();
  const chart = page.locator(".mood-chart .recharts-responsive-container");
  await expect(chart).toBeVisible();
  await expect(chart.locator(".recharts-line-curve")).toHaveCount(1);
  expect(await chart.evaluate((element) => element.getBoundingClientRect().height)).toBe(118);
  await expect(page.locator(".empty-chart")).toHaveCount(0);
  const dots = chart.locator(".recharts-line-dot");
  await dots.nth(0).hover();
  await expect(chart.locator(".recharts-tooltip-label")).toHaveText("9月3日");
  await dots.nth(1).hover();
  await expect(chart.locator(".recharts-tooltip-label")).toHaveText("9月4日");
});

test("从设置返回后的焦点恢复不抢走已经开始输入的消息框", async ({ page }, testInfo) => {
  await mockApp(page);
  if (testInfo.project.name.includes("mobile")) await page.locator(".mobile-nav-button").click();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("heading", { name: "你的信息，由你决定" }).waitFor();
  await page.evaluate(() => {
    const state = window as any;
    state.savedAnimationFrame = window.requestAnimationFrame;
    state.pendingAnimationFrames = [];
    window.requestAnimationFrame = (callback) => { state.pendingAnimationFrames.push(callback); return state.pendingAnimationFrames.length; };
  });
  await page.getByRole("button", { name: "返回知微" }).click();
  const composer = page.getByLabel("消息内容");
  await composer.fill("我已经开始输入这一句");
  await page.evaluate(() => {
    const state = window as any;
    window.requestAnimationFrame = state.savedAnimationFrame;
    for (const callback of state.pendingAnimationFrames) callback(performance.now());
  });
  await expect(composer).toBeFocused();
  await expect(composer).toHaveValue("我已经开始输入这一句");
  await expect(page.getByRole("button", { name: "发送消息" })).toBeEnabled();
});

test("单点心情悬停使用真实日期，初始和刷新查询携带设备时区", async ({ page }, testInfo) => {
  const requests = await mockApp(page, false, "single");
  if (testInfo.project.name.includes("mobile")) await page.getByRole("button", { name: "打开或收起洞察栏" }).click();
  const chart = page.locator(".mood-chart .recharts-responsive-container");
  await chart.locator(".recharts-line-dot").hover();
  await expect(chart.locator(".recharts-tooltip-label")).toHaveText("9月3日");
  const timeZone = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  expect(new URL(requests.find((path) => path.startsWith("/api/bootstrap"))!, "http://test").searchParams.get("timeZone")).toBe(timeZone);
  await page.evaluate(() => (window as any).testActivity.dispatchEvent(new MessageEvent("mood.updated", { data: JSON.stringify({ payload: {} }) })));
  await expect.poll(() => requests.some((path) => path.startsWith("/api/mood?"))).toBe(true);
  expect(new URL(requests.find((path) => path.startsWith("/api/mood?"))!, "http://test").searchParams.get("timeZone")).toBe(timeZone);
});

test("搜索计时沿用真实开始时间，阶段切换和停止后清除，旧请求不恢复计时", async ({ page }) => {
  await mockApp(page);
  await page.clock.install();
  const composer = page.getByLabel("消息内容");
  await composer.fill("请核验这条消息");
  await page.getByRole("button", { name: "发送消息" }).click();
  const startedAt = await page.evaluate(() => new Date(Date.now() - 4_000).toISOString());
  await push(page, 0, { type: "phase", stage: "search", message: "正在查找资料", startedAt });
  await expect(page.getByText("正在查找资料 · 已用 4 秒", { exact: true })).toBeVisible();
  await page.clock.fastForward(2_000);
  await expect(page.getByText("正在查找资料 · 已用 6 秒", { exact: true })).toBeVisible();
  await push(page, 0, { type: "phase", stage: "compose", message: "正在根据资料整理回应" });
  await expect(page.getByText("正在根据资料整理回应", { exact: true })).toBeVisible();
  await expect(page.getByText(/正在查找资料 · 已用/)).toHaveCount(0);
  await push(page, 0, { type: "text.delta", delta: "这是根据资料整理的回应。" });
  await push(page, 0, { type: "message.completed", messageId: "server-assistant-0", status: "completed" });
  await expect(page.locator(".waiting-reply")).toHaveCount(0);
  await composer.fill("再核验另一个问题");
  await page.getByRole("button", { name: "发送消息" }).click();
  await push(page, 0, { type: "phase", stage: "search", message: "旧请求不应影响当前状态", startedAt });
  await expect(page.getByText(/正在查找资料 · 已用/)).toHaveCount(0);
  await push(page, 1, { type: "phase", stage: "search", message: "正在查找资料", startedAt });
  await expect(page.getByText(/正在查找资料 · 已用/)).toBeVisible();
  await page.getByRole("button", { name: "停止回复" }).click();
  await expect(page.locator(".waiting-reply")).toHaveCount(0);
  await expect(page.getByText("已停止", { exact: true })).toBeVisible();
  await composer.fill("最后一个核验问题");
  await page.getByRole("button", { name: "发送消息" }).click();
  await push(page, 2, { type: "phase", stage: "search", message: "正在查找资料", startedAt });
  await push(page, 2, { type: "error", message: "这次查证没有完成，请重试。" });
  await expect(page.locator(".waiting-reply")).toHaveCount(0);
  await expect(page.getByText("回复中断了，可以重试。", { exact: true })).toBeVisible();
});

test("最新回复重试复用用户消息，空回复错误保留入口，停止保留正文", async ({ page }) => {
  await mockApp(page);
  await page.getByLabel("消息内容").fill("第一次的问题");
  await page.getByRole("button", { name: "发送消息" }).click();
  await push(page, 0, { type: "error", message: "这次回复没有完成，请重试。" });
  await expect(page.getByRole("button", { name: "重试", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).testStreams[1]?.url)).toBe("/api/conversations/one/messages/server-assistant-0/retry");
  await expect(page.getByText("第一次的问题", { exact: true })).toHaveCount(1);
  await push(page, 1, { type: "text.delta", delta: "已经收到的部分回复。" });
  await expect(page.getByText("已经收到的部分回复。", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "停止回复" }).click();
  await expect(page.getByText("已停止", { exact: true })).toBeVisible();
  await expect(page.getByText("已经收到的部分回复。", { exact: true })).toBeVisible();
});

test("等待反馈仅在正文为空时出现，新提示不会被旧定时器清除", async ({ page }) => {
  await mockApp(page);
  await page.clock.install();
  await page.getByLabel("消息内容").fill("第一次的问题");
  await page.getByRole("button", { name: "发送消息" }).click();
  await page.clock.fastForward(6_200);
  await expect(page.getByText("知微正在整理回应，再等一小会儿…", { exact: true })).toBeVisible();
  await page.clock.fastForward(9_000);
  await expect(page.getByText("这次需要多一点时间，你可以继续等，也可以停止回复。", { exact: true })).toBeVisible();
  await push(page, 0, { type: "text.delta", delta: "已经开始回应。" });
  await push(page, 0, { type: "message.completed", messageId: "server-assistant-0", status: "completed" });
  await expect(page.locator(".waiting-reply")).toHaveCount(0);
  await page.locator(".message.assistant").hover();
  await page.getByRole("button", { name: "有被懂到", exact: true }).click();
  await expect(page.locator(".toast")).toContainText("谢谢你告诉我");
  await page.clock.fastForward(3_000);
  await page.getByRole("button", { name: "不太像我", exact: true }).click();
  await page.getByRole("button", { name: "语气不对", exact: true }).click();
  await expect(page.locator(".toast")).toContainText("谢谢你纠正我");
  await page.clock.fastForward(600);
  await expect(page.locator(".toast")).toContainText("谢谢你纠正我");
  await page.clock.fastForward(3_200);
  await expect(page.locator(".toast")).toHaveCount(0);
});

test("中文输入法不误发送，输入框增高，分页保留锚点，开发者数据按需加载", async ({ page }, testInfo) => {
  const requests = await mockApp(page, true);
  const composer = page.getByLabel("消息内容");
  await composer.fill("尚在选字");
  await composer.dispatchEvent("compositionstart");
  await composer.press("Enter");
  expect(await page.evaluate(() => (window as any).testStreams.length)).toBe(0);
  await composer.dispatchEvent("compositionend");
  await composer.fill(Array.from({ length: 20 }, () => "这里有一行很长的输入内容").join("\n"));
  const height = await composer.evaluate((element) => element.getBoundingClientRect().height);
  expect(height).toBeGreaterThan(100);
  expect(height).toBeLessThanOrEqual(182);
  const scroller = page.locator(".message-scroll");
  await scroller.evaluate((element) => { element.scrollTop = 0; element.dispatchEvent(new Event("scroll")); });
  await expect.poll(() => requests.includes("/api/conversations/one/messages?before=before-recent")).toBe(true);
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(200);
  await expect(page.getByText("当前消息 0：这是一段用来验证真实页面滚动位置的内容。", { exact: true })).toBeInViewport();
  if (testInfo.project.name.includes("mobile")) await page.locator(".mobile-nav-button").click();
  await page.getByRole("button", { name: "开发者模式", exact: true }).click();
  await expect(page.getByText("每一次回答是怎么产生的", { exact: true })).toBeVisible();
  expect(requests).toContain("/api/dev/data?section=trace");
  expect(requests).not.toContain("/api/dev/model-costs");
  await page.getByRole("button", { name: "模型与费用", exact: true }).click();
  await expect(page.getByText("费用估算，不等同于阿里云账单。", { exact: true })).toBeVisible();
  await expect(page.locator(".model-run-card")).toHaveCount(0);
  await page.locator(".model-run-list details > summary").first().click();
  await expect(page.locator(".model-run-card")).toHaveCount(1);
  await page.getByRole("button", { name: "返回知微", exact: true }).click();
  await expect(composer).toHaveValue(Array.from({ length: 20 }, () => "这里有一行很长的输入内容").join("\n"));
});
