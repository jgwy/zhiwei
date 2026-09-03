import { expect, test } from "@playwright/test";

test.afterEach(async ({ page }) => {
  await page.request.delete("/api/user/data", {
    data: { confirmation: "删除知微中的全部数据" },
  }).catch(() => undefined);
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
  } else {
    await expect(page.getByRole("heading", { name: "关于你", exact: true })).toBeVisible();
  }
  await expect(page.getByRole("heading", { name: "关于你的长期认识" })).toBeVisible();
  await page.getByRole("button", { name: "查看全文" }).click();
  await expect(page.getByRole("dialog", { name: "关于你的长期认识" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "管理具体认识" }).click();
  await expect(page.getByRole("dialog", { name: "管理具体认识" })).toBeVisible();
  await page.keyboard.press("Escape");
  if (testInfo.project.name.includes("mobile")) await page.getByRole("button", { name: "返回对话" }).click();

  if (testInfo.project.name.includes("mobile")) await page.locator(".mobile-nav-button").click();
  await page.getByRole("button", { name: /管理对话：/ }).first().click();
  await expect(page.getByRole("dialog", { name: "修改对话名称" })).toBeVisible();
  await page.keyboard.press("Escape");
  if (testInfo.project.name.includes("mobile")) await page.locator(".mobile-close").click();

  if (testInfo.project.name.includes("mobile")) {
    await page.locator(".mobile-nav-button").click();
  }
  await page.getByRole("button", { name: "关于", exact: true }).click();
  const aboutDialog = page.getByRole("dialog", { name: "知微" });
  await expect(aboutDialog).toBeVisible();
  await expect(aboutDialog.getByRole("img")).toHaveCount(5);
  await expect(aboutDialog.getByText("真切地陪伴你的数字分身", { exact: true })).toBeVisible();
  await expect(aboutDialog.getByRole("heading", { name: "我们如何使用阿里云相关技术" })).toBeVisible();
  await expect(aboutDialog.getByText("应用现已部署在阿里云服务器上", { exact: false })).toBeVisible();
  await expect(aboutDialog.getByText("开发过程完全使用 Qoder", { exact: false })).toBeVisible();
  await expect(aboutDialog.getByText("东南大学化学化工学院25级本科生", { exact: true })).toBeVisible();
  await expect(aboutDialog.getByText("Datawhale 成员", { exact: true })).toBeVisible();
  await expect(aboutDialog.getByText("ModelScope 社区开发者", { exact: true })).toBeVisible();
  await expect(aboutDialog.getByText("刘一民", { exact: true })).toBeVisible();
  await expect(aboutDialog.getByText("（华中科技大学）", { exact: true })).toBeVisible();
  await expect(aboutDialog.getByText("版本 1.0beta", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(aboutDialog).not.toBeVisible();

  if (testInfo.project.name.includes("mobile")) await page.locator(".mobile-nav-button").click();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(page.getByRole("heading", { name: "你的信息，由你决定" })).toBeVisible();
  await expect(page.getByRole("switch", { name: "使用记忆与画像" })).toBeVisible();
  await expect(page.getByRole("switch", { name: "近期认识" })).toBeVisible();
  await expect(page.getByRole("switch", { name: "长期认识" })).toBeVisible();
  await page.getByRole("button", { name: "返回知微" }).click();

  const composer = page.getByLabel("消息内容");
  await composer.fill("最近工作压力有点大，我总觉得自己做得不够好。");
  await page.getByRole("button", { name: "发送消息" }).click();
  await expect(page.getByText("不急着劝你振作", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "发送消息" })).toBeVisible();

  for (const message of [
    "我发现这种压力到了晚上还会反复冒出来。",
    "尤其是想到明天的事情，我会担心自己又做不好。",
    "我其实不需要立刻得到方案，只是不想把这些都憋着。",
  ]) {
    await composer.fill(message);
    await page.getByRole("button", { name: "发送消息" }).click();
    await expect(page.getByRole("button", { name: "发送消息" })).toBeVisible({ timeout: 10_000 });
  }
  const messageScroll = page.locator(".message-scroll");
  await expect.poll(() => messageScroll.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await messageScroll.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll"));
  });
  await expect(page.getByRole("button", { name: "回到最新" })).toBeVisible();
  await page.waitForTimeout(800);
  await expect.poll(() => messageScroll.evaluate((element) => element.scrollTop)).toBeLessThan(50);

  if (testInfo.project.name.includes("mobile")) {
    await page.locator(".mobile-nav-button").click();
  }
  await page.getByRole("button", { name: "开发者模式" }).click();
  await expect(page.getByText("每一次回答是怎么产生的")).toBeVisible();
  await page.getByRole("button", { name: "记忆与画像" }).click();
  await expect(page.getByText("证据如何变成理解")).toBeVisible();
  await expect(page.getByRole("heading", { name: "记忆事件" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "版本血缘" })).toBeVisible();
  await page.getByRole("button", { name: "个人技能演化" }).click();
  await expect(page.getByText("固定能力与个体演化")).toBeVisible();
  await expect(page.getByText("zhiwei-persona", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "比赛实验室" }).click();
  await expect(page.getByText("从“会回答”到“有温度”")).toBeVisible();
  await page.getByRole("button", { name: "运行三阶段消融" }).click();
  await expect(page.getByText("01 直接回答")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("03 个人技能")).toBeVisible();
  await expect(page.getByRole("heading", { name: "记忆生命周期 Replay" })).toBeVisible();
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
  await page.getByRole("button", { name: "管理具体认识" }).click();
  const withdraw = page.getByRole("button", { name: /撤回：/ }).first();
  await expect(withdraw).toBeVisible({ timeout: 10_000 });
  await withdraw.click();
  await page.getByRole("button", { name: "确认撤回", exact: true }).click();
  await expect(page.getByText("这条认识已撤回", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "关闭管理具体认识" }).click();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByPlaceholder("删除知微中的全部数据").fill("删除知微中的全部数据");
  await page.getByRole("button", { name: "永久删除全部数据" }).click();
  await expect(page.getByRole("heading", { name: "先让我认识一下此刻的你" })).toBeVisible({ timeout: 10_000 });
});
