import { expect, test } from "@playwright/test";

test("思考图标随首段文本和停止操作正确清理", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-desktop", "动画生命周期只需在桌面 Chromium 验证一次");
  const conversationId = crypto.randomUUID();
  const now = new Date().toISOString();
  await page.route("**/api/bootstrap", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        user: { id: crypto.randomUUID(), onboarding_complete: true, settings: {} },
        conversations: [{ id: conversationId, title: "等待状态测试", titleSource: "default", titleLocked: false, createdAt: now, updatedAt: now, messages: [] }],
        profile: null,
        memories: [],
        mood: [],
        skill: null,
        onboarding: { complete: true, answeredCount: 0, canFinish: true, question: null },
        returnNote: null,
        developerModeAvailable: true,
        adapter: "scripted",
        modelModeLabel: "仿真模式",
        modelCapabilities: { streaming: true, structuredOutput: true, toolCalls: true, nativeWebSearch: false, usage: true, maxContextTokens: 24_000 },
      }),
    });
  });

  let releaseResponse: (() => void) | undefined;
  let responseGate = new Promise<void>((resolve) => { releaseResponse = resolve; });
  await page.route("**/api/conversations/*/messages", async (route) => {
    const requestGate = responseGate;
    await requestGate;
    const messageId = crypto.randomUUID();
    try {
      await route.fulfill({
        contentType: "text/event-stream; charset=utf-8",
        body: [
          `data: ${JSON.stringify({ type: "message.started", messageId, traceId: crypto.randomUUID() })}\n\n`,
          `data: ${JSON.stringify({ type: "text.delta", delta: "回复完成" })}\n\n`,
          `data: ${JSON.stringify({ type: "message.completed", messageId, jobId: crypto.randomUUID(), sources: [] })}\n\n`,
        ].join(""),
      });
    } catch {
      // The second request is intentionally aborted by the stop button.
    }
  });

  await page.goto("/");
  const composer = page.getByLabel("消息内容");
  await composer.fill("测试等待状态");
  await page.getByRole("button", { name: "发送消息" }).click();
  const indicator = page.getByRole("status", { name: "正在思考" });
  await expect(indicator).toBeVisible();
  await expect(indicator.locator("img")).toHaveAttribute("src", "/about/aliyun-cloud.png");
  expect(await indicator.locator("img").evaluate((element) => getComputedStyle(element).animationName)).toBe("thinking-logo-bounce");
  releaseResponse?.();
  await expect(page.getByText("回复完成", { exact: true })).toBeVisible();
  await expect(indicator).toBeHidden();

  responseGate = new Promise<void>((resolve) => { releaseResponse = resolve; });
  await composer.fill("测试停止清理");
  await page.getByRole("button", { name: "发送消息" }).click();
  await expect(indicator).toBeVisible();
  await page.getByRole("button", { name: "停止回复" }).click();
  await expect(indicator).toBeHidden();
  await expect(page.getByRole("button", { name: "发送消息" })).toBeVisible();
  releaseResponse?.();
});

test("从空白问卷进入聊天并生成画像、memory 与 Skill 证据", async ({ page }, testInfo) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "先让我认识一下此刻的你" })).toBeVisible();
  await page.getByRole("button", { name: "开始认识" }).click();
  await page.getByRole("button", { name: "刚进入职场" }).click();
  await page.getByRole("button", { name: "学习或工作" }).click();
  await page.getByRole("button", { name: "先听我说" }).click();
  await expect(page.getByText("已经可以开始聊天")).toBeVisible();
  await page.getByRole("button", { name: "先聊到这里，开始聊天" }).click();
  await expect(page.getByRole("heading", { name: "现在，你想从哪里聊起？" })).toBeVisible();

  if (testInfo.project.name.includes("mobile")) {
    await page.locator(".mobile-nav-button").click();
    await expect(page.getByRole("button", { name: "新的对话" })).toBeVisible();
    await page.locator(".mobile-close").click();
    await page.getByRole("button", { name: "打开或收起洞察栏" }).click();
    await expect(page.getByRole("button", { name: "返回对话" })).toBeVisible();
    await page.getByRole("button", { name: "返回对话" }).click();
  } else {
    await expect(page.getByRole("heading", { name: "关于你" })).toBeVisible();
  }

  if (testInfo.project.name.includes("mobile")) {
    await page.locator(".mobile-nav-button").click();
  }
  await page.getByRole("button", { name: "关于", exact: true }).click();
  const aboutDialog = page.getByRole("dialog", { name: "知微" });
  await expect(aboutDialog).toBeVisible();
  await expect(aboutDialog.getByRole("img")).toHaveCount(5);
  await expect(aboutDialog.getByText("真切地陪伴你的数字分身", { exact: true })).toBeVisible();
  await expect(aboutDialog.getByText("刘一民", { exact: true })).toBeVisible();
  await expect(aboutDialog.getByText("（华中科技大学）", { exact: true })).toBeVisible();
  await expect(aboutDialog.getByText("版本 1.0beta", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(aboutDialog).not.toBeVisible();

  const composer = page.getByLabel("消息内容");
  await composer.fill("最近工作压力有点大，我总觉得自己做得不够好。");
  await page.getByRole("button", { name: "发送消息" }).click();
  await expect(page.getByText("不急着劝你振作", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "发送消息" })).toBeVisible();

  if (testInfo.project.name.includes("mobile")) {
    await page.locator(".mobile-nav-button").click();
  }
  await page.getByRole("button", { name: "开发者模式" }).click();
  await expect(page.getByText("每一次回答是怎么产生的")).toBeVisible();
  await page.getByRole("button", { name: "记忆与画像" }).click();
  await expect(page.getByText("证据如何变成理解")).toBeVisible();
  await page.getByRole("button", { name: "个人技能演化" }).click();
  await expect(page.getByText("固定能力与个体演化")).toBeVisible();
  await expect(page.getByText("zhiwei-persona", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "比赛实验室" }).click();
  await expect(page.getByText("从“会回答”到“有温度”")).toBeVisible();
  await page.getByRole("button", { name: "运行三阶段消融" }).click();
  await expect(page.getByText("01 直接回答")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("03 个人技能")).toBeVisible();
  await page.getByRole("button", { name: "模型与费用" }).click();
  await expect(page.getByRole("heading", { name: "模型与费用" })).toBeVisible();
  await expect(page.getByText("费用估算，不等同于阿里云账单。")).toBeVisible();
});

test("记忆可撤回且当前匿名档案可全量删除", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-desktop", "破坏性数据控制只需在独立桌面测试档案验证一次");
  await page.goto("/");
  await page.getByRole("button", { name: "开始认识" }).click();
  await page.getByRole("button", { name: "刚进入职场" }).click();
  await page.getByRole("button", { name: "学习或工作" }).click();
  await page.getByRole("button", { name: "先听我说" }).click();
  await page.getByRole("button", { name: "先聊到这里，开始聊天" }).click();
  const withdraw = page.getByRole("button", { name: /撤回记忆/ }).first();
  await expect(withdraw).toBeVisible({ timeout: 10_000 });
  await withdraw.click();
  await expect(page.getByText("这条认识已撤回", { exact: false })).toBeVisible();
  await page.getByPlaceholder("删除知微中的全部数据").fill("删除知微中的全部数据");
  await page.getByRole("button", { name: "永久删除全部数据" }).click();
  await expect(page.getByRole("heading", { name: "先让我认识一下此刻的你" })).toBeVisible({ timeout: 10_000 });
});
