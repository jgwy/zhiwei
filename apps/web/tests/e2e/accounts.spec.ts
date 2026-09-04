import { expect, test, type Page } from "@playwright/test";

// This suite creates and deletes its own accounts. Never run it against the main site.
test.beforeEach(async ({ baseURL }) => {
  const url = new URL(baseURL!);
  test.skip(!["127.0.0.1", "localhost"].includes(url.hostname) || url.port === "3000", "账号测试仅使用独立本地测试站点");
});

async function request(page: Page, path: string, body?: unknown, method = "POST") {
  return page.evaluate(async ({ path, body, method }) => {
    const response = await fetch(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  }, { path, body, method });
}

async function finishOnboarding(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "开始认识", exact: true })).toBeVisible();
  const data = await request(page, "/api/bootstrap", undefined, "GET");
  expect(data.data.adapter).toBe("scripted");
  for (let i = 0; i < 3; i++) {
    const state = await request(page, "/api/bootstrap", undefined, "GET");
    const result = await request(page, "/api/onboarding/answer", { questionId: state.data.onboarding.question.id, answer: ["我在大学读化学", "正在准备下周的实验课", "先听我把话说完"][i] });
    expect(result.status).toBe(200);
  }
  expect((await request(page, "/api/onboarding/complete", {})).status).toBe(200);
  await page.reload();
  await expect(page.getByLabel("消息内容")).toBeVisible();
}

async function openInsights(page: Page) {
  if ((page.viewportSize()?.width ?? 1280) < 900)
    await page.getByRole("button", { name: "打开或收起洞察栏" }).click();
}

async function credentials(page: Page, username: string, password: string, binding: boolean) {
  await page.getByLabel("账号", { exact: true }).fill(username);
  await page.getByLabel("密码", { exact: true }).fill(password);
  if (binding) await page.getByLabel("确认密码", { exact: true }).fill(password);
}

test("绑定与恢复保留游客对话、草稿、原消息和历史会话", async ({ page, browser }, testInfo) => {
  const username = `qa-${Date.now()}-${testInfo.workerIndex}`;
  const password = "synthetic-password-only-123";
  const guestContext = await browser.newContext({ viewport: page.viewportSize()! });
  const guest = await guestContext.newPage();
  let ownerReady = false;
  let guestReady = false;
  try {
    await finishOnboarding(page); ownerReady = true;
    const owner = (await request(page, "/api/bootstrap", undefined, "GET")).data;
    await request(page, `/api/conversations/${owner.activeConversationId}`, { title: "原账号里的聊天" }, "PATCH");
    await openInsights(page);
    await page.getByRole("button", { name: "绑定账号", exact: true }).click();
    await credentials(page, username, password, true);
    await page.getByLabel("确认密码", { exact: true }).fill(`${password}x`);
    await page.getByRole("button", { name: "确认绑定", exact: true }).click();
    await expect(page.getByRole("dialog").getByRole("alert")).toContainText("两次输入的密码不一致");
    await page.getByLabel("确认密码", { exact: true }).fill(password);
    await page.getByRole("button", { name: "确认绑定", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "已绑定账号", exact: true })).toBeDisabled();

    await finishOnboarding(guest); guestReady = true;
    await guest.getByLabel("消息内容").fill("这是游客对话里已发送的一句话");
    await guest.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(guest.getByRole("button", { name: "重新生成", exact: true })).toBeVisible();
    const before = (await request(guest, "/api/bootstrap", undefined, "GET")).data;
    await request(guest, `/api/conversations/${before.activeConversationId}`, { title: "当前游客的聊天" }, "PATCH");
    await guest.reload();
    await guest.getByLabel("消息内容").fill("这一条还没发送的游客草稿");
    await openInsights(guest);
    await guest.getByRole("button", { name: "恢复账号数据", exact: true }).click();
    await credentials(guest, username, "incorrect-password", false);
    await guest.getByRole("button", { name: "恢复并保留游客聊天", exact: true }).click();
    await expect(guest.getByRole("dialog").getByRole("alert")).toContainText("账号或密码不正确");
    await guest.getByLabel("密码", { exact: true }).fill(password);
    await guest.getByRole("button", { name: "恢复并保留游客聊天", exact: true }).click();
    await expect(guest.getByRole("dialog")).toHaveCount(0);
    await expect(guest.getByRole("button", { name: "已绑定账号", exact: true })).toBeDisabled();
    if ((guest.viewportSize()?.width ?? 1280) < 900) await guest.getByRole("button", { name: "返回对话", exact: true }).click();
    await expect(guest.getByLabel("消息内容")).toHaveValue("这一条还没发送的游客草稿");
    await expect(guest.getByText("这是游客对话里已发送的一句话", { exact: true })).toBeVisible();
    const after = (await request(guest, `/api/bootstrap?conversationId=${before.activeConversationId}`, undefined, "GET")).data;
    expect(after.user.id).toBe(owner.user.id);
    expect(after.activeConversationId).toBe(before.activeConversationId);
    expect(after.conversations.map((conversation: any) => conversation.title)).toEqual(expect.arrayContaining(["当前游客的聊天", "原账号里的聊天"]));
    expect(after.messagePage.messages.map((message: any) => [message.id, message.content])).toEqual(before.messagePage.messages.map((message: any) => [message.id, message.content]));
    expect(after.conversations).toHaveLength(2);
    expect((await request(guest, "/api/account/restore", { username, password })).status).toBe(200);
    expect((await request(guest, "/api/bootstrap", undefined, "GET")).data.conversations).toHaveLength(2);
    await guest.reload();
    await expect(guest.getByLabel("消息内容")).toBeVisible();
    const body = await guest.locator("body").innerText();
    expect(body).not.toContain(password);
    await guest.screenshot({ path: testInfo.outputPath("account-restored.png"), fullPage: true });
  } finally {
    if (guestReady) await request(guest, "/api/user/data", { confirmation: "删除知微中的全部数据" }, "DELETE");
    if (ownerReady) await request(page, "/api/user/data", { confirmation: "删除知微中的全部数据" }, "DELETE");
    await guestContext.close();
  }
});

test("首次访问可以直接打开恢复入口，不需要先回答问卷", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "开始认识", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "恢复账号数据", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByLabel("账号", { exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "恢复账号数据", exact: true })).toBeFocused();
  await request(page, "/api/user/data", { confirmation: "删除知微中的全部数据" }, "DELETE");
});
