import { expect, test } from "@playwright/test";

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
