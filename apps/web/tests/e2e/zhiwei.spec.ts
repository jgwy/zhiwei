import { expect, test, type Page } from "@playwright/test";

async function completeOnboarding(page: Page) {
  await page.getByRole("button", { name: "开始认识" }).click();
  for (const remaining of [2, 1, 0]) {
    const option = page.locator(".option-chips button").first();
    await expect(option).toBeEnabled();
    await option.click();
    await expect(page.locator(".onboarding-footer")).toContainText(
      remaining ? `再回答 ${remaining} 题即可开始聊天` : "已经可以开始聊天",
      { timeout: 20_000 },
    );
  }
  await page.getByRole("button", { name: "先聊到这里，开始聊天" }).click();
}

test("从空白问卷进入聊天并生成画像、memory 与 Skill 证据", async ({ page }, testInfo) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "先让我认识一下此刻的你" })).toBeVisible();
  await completeOnboarding(page);
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
  await completeOnboarding(page);
  const withdraw = page.getByRole("button", { name: /撤回记忆/ }).first();
  await expect(withdraw).toBeVisible({ timeout: 10_000 });
  await withdraw.click();
  await expect(page.getByText("这条认识已撤回", { exact: false })).toBeVisible();
  await page.getByPlaceholder("删除知微中的全部数据").fill("删除知微中的全部数据");
  await page.getByRole("button", { name: "永久删除全部数据" }).click();
  await expect(page.getByRole("heading", { name: "先让我认识一下此刻的你" })).toBeVisible({ timeout: 10_000 });
});

test("消息和记忆展示服务端时间与完整时间链", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-desktop", "时间链完整验收只需在桌面 Chromium 执行一次");
  await page.goto("/");
  await completeOnboarding(page);

  const composer = page.getByLabel("消息内容");
  await composer.fill("昨天工作压力很大，我一直不知道怎么办。");
  await page.getByRole("button", { name: "发送消息" }).click();
  await expect(page.locator(".message.assistant .message-content")).not.toBeEmpty();

  const messageTime = page.locator(".message time").last();
  await expect(messageTime).toHaveText(/刚刚|分钟前/);
  await expect(messageTime).toHaveAttribute("title", /Asia\/Shanghai/);
  await expect(page.locator(".message-date-divider")).toHaveCount(1);

  await expect.poll(async () => {
    const state = await page.evaluate(async () => fetch("/api/bootstrap", { cache: "no-store" }).then((response) => response.json()));
    const messages = state.conversations[0]?.messages ?? [];
    return {
      timezone: state.user.timezone,
      ordered: messages.every((message: { sequence: number }, index: number) => index === 0 || messages[index - 1].sequence < message.sequence),
      serverTimes: messages.every((message: { createdAt?: string }) => Boolean(message.createdAt)),
    };
  }, { timeout: 10_000 }).toEqual({ timezone: "Asia/Shanghai", ordered: true, serverTimes: true });

  const timedMemory = page.locator(".memory-row", { hasText: "昨天工作压力很大" });
  await expect(timedMemory).toBeVisible({ timeout: 15_000 });
  await expect(timedMemory.getByText("发生于昨天", { exact: false })).toBeVisible();
  await timedMemory.getByText("时间记录", { exact: true }).click();
  await expect(timedMemory.getByText("首次获知", { exact: false })).toBeVisible();
  await expect(timedMemory.getByText("最近确认", { exact: false })).toBeVisible();
  await expect(timedMemory.getByText("版本写入", { exact: false })).toBeVisible();
});

test("编辑历史用户消息会截断后续聊天并重新回复", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  test.skip(!testInfo.project.name.startsWith("chromium"), "历史改写流程在桌面和移动 Chromium 验证");
  await page.goto("/");
  await completeOnboarding(page);

  const composer = page.getByLabel("消息内容");
  const initialComposerHeight = await composer.evaluate((element) => element.getBoundingClientRect().height);
  await composer.fill("输入框增长测试\n".repeat(40));
  await expect.poll(() => composer.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThan(initialComposerHeight);
  await expect.poll(() => composer.evaluate((element) => getComputedStyle(element).overflowY)).toBe("auto");
  await composer.fill("第一条原始消息");
  await page.getByRole("button", { name: "发送消息" }).click();
  await expect(page.getByRole("button", { name: "发送消息" })).toBeVisible({ timeout: 30_000 });
  await composer.fill("这条后续消息应被删除");
  await page.getByRole("button", { name: "发送消息" }).click();
  await expect(page.getByRole("button", { name: "发送消息" })).toBeVisible({ timeout: 30_000 });

  const original = page.locator(".message.user", { hasText: "第一条原始消息" });
  await original.hover();
  await original.getByRole("button", { name: "编辑消息" }).click();
  const editInput = page.getByLabel("编辑消息内容");
  const initialEditHeight = await editInput.evaluate((element) => element.getBoundingClientRect().height);
  await editInput.fill("内容增长测试\n".repeat(30));
  await expect.poll(() => editInput.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThan(initialEditHeight);
  await expect.poll(() => editInput.evaluate((element) => getComputedStyle(element).overflowY)).toBe("auto");
  await editInput.fill("第一条编辑后的消息");
  await page.getByRole("button", { name: "发送", exact: true }).click();

  await expect(page.getByText("第一条编辑后的消息", { exact: true })).toBeVisible();
  await expect(page.getByText("这条后续消息应被删除", { exact: true })).not.toBeVisible();
  await expect(page.locator(".message.user time", { hasText: "已编辑" })).toBeVisible();
  await expect(page.getByRole("button", { name: "发送消息" })).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => {
    const state = await page.evaluate(async () => fetch("/api/bootstrap", { cache: "no-store" }).then((response) => response.json()));
    return state.conversations[0]?.historyRevision;
  }).toBe(3);
});

test("历史对话按年、月、周分组并在刷新后恢复默认开合", async ({ page }, testInfo) => {
  const day = 86_400_000;
  const now = Date.now();
  const conversation = (id: string, offsetDays: number) => {
    const updatedAt = new Date(now - offsetDays * day).toISOString();
    return {
      id,
      title: id,
      titleSource: "default",
      titleLocked: false,
      createdAt: updatedAt,
      updatedAt,
      historyRevision: 0,
      messages: [],
    };
  };
  const bootstrap = {
    user: {
      id: "00000000-0000-0000-0000-000000000001",
      onboarding_complete: true,
      settings: {},
      timezone: "Asia/Shanghai",
    },
    conversations: [
      conversation("本周对话", 0),
      conversation("上周对话", 8),
      conversation("上月对话", 40),
      conversation("去年对话", 400),
    ],
    profile: null,
    memories: [],
    mood: [],
    skill: null,
    onboarding: { complete: true, answeredCount: 3, canFinish: true, question: null },
    returnNote: null,
    developerModeAvailable: false,
    adapter: "scripted",
    modelModeLabel: "仿真模式",
    modelCapabilities: {
      streaming: true,
      structuredOutput: true,
      toolCalls: false,
      nativeWebSearch: false,
      usage: false,
      maxContextTokens: 8_192,
    },
  };

  await page.route("**/api/bootstrap", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(bootstrap),
  }));
  await page.route("**/api/activity/stream", (route) => route.abort());
  await page.goto("/");

  if (testInfo.project.name.includes("mobile")) {
    await page.locator(".mobile-nav-button").click();
  }

  const history = page.locator("nav.conversation-list");
  await expect(history).toHaveAttribute("aria-label", "历史对话");
  await expect(history).toBeVisible();
  const yearGroups = history.locator(":scope > .conversation-group-year");
  await expect(yearGroups).toHaveCount(2);
  await expect(yearGroups.nth(0).locator(":scope > .conversation-group-toggle")).toHaveAttribute("aria-expanded", "true");
  await expect(yearGroups.nth(1).locator(":scope > .conversation-group-toggle")).toHaveAttribute("aria-expanded", "false");

  const currentYear = yearGroups.nth(0);
  const currentMonthGroups = currentYear.locator(":scope > .conversation-group-content > .conversation-group-month");
  await expect(currentMonthGroups.nth(0).locator(":scope > .conversation-group-toggle")).toHaveAttribute("aria-expanded", "true");
  await expect(currentMonthGroups.nth(1).locator(":scope > .conversation-group-toggle")).toHaveAttribute("aria-expanded", "false");
  await expect(currentMonthGroups.nth(0).locator(".conversation-group-week").first().locator(":scope > .conversation-group-toggle")).toHaveAttribute("aria-expanded", "true");

  const oldYearToggle = yearGroups.nth(1).locator(":scope > .conversation-group-toggle");
  await oldYearToggle.click();
  await expect(oldYearToggle).toHaveAttribute("aria-expanded", "true");
  const oldMonth = yearGroups.nth(1).locator(":scope > .conversation-group-content > .conversation-group-month").first();
  await oldMonth.locator(":scope > .conversation-group-toggle").click();
  const oldWeek = oldMonth.locator(":scope > .conversation-group-content > .conversation-group-week").first();
  await oldWeek.locator(":scope > .conversation-group-toggle").click();
  await expect(yearGroups.nth(1).getByRole("button", { name: "去年对话", exact: true })).toBeVisible();
  await page.reload();
  if (testInfo.project.name.includes("mobile")) {
    await page.locator(".mobile-nav-button").click();
  }
  await expect(page.locator("nav.conversation-list").locator(":scope > .conversation-group-year").nth(1).locator(":scope > .conversation-group-toggle")).toHaveAttribute("aria-expanded", "false");
});
