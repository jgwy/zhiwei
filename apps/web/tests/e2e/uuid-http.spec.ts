import { expect, test } from "@playwright/test";

test("HTTP 页面缺少 randomUUID 时仍可发送及重新生成", async ({ page }) => {
  const errors: string[] = [];
  let requests = 0;
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    Object.defineProperty(crypto, "randomUUID", { value: undefined, configurable: true });
    window.EventSource = class extends EventTarget {
      close() {}
    } as unknown as typeof EventSource;
  });
  const createdAt = "2026-09-04T00:00:00.000Z";
  const userMessage = { id: "user-message", role: "user", content: "HTTP 兼容性验证", createdAt };
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === "POST" && path.includes("/messages")) {
      requests++;
      const messageId = `assistant-${requests}`;
      const events = [
        { type: "message.started", messageId, userMessage, traceId: "test-trace" },
        { type: "text.delta", delta: `回复 ${requests}` },
        { type: "message.completed", messageId, status: "completed" },
      ];
      await route.fulfill({ contentType: "text/event-stream", body: events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") });
      return;
    }
    const payload = path === "/api/bootstrap" ? {
      user: { id: "test-user", onboarding_complete: true, settings: {} },
      conversations: [{ id: "test-conversation", title: "测试对话", createdAt, updatedAt: createdAt, messageCount: 0 }],
      activeConversationId: "test-conversation",
      messagePage: { messages: [], hasMore: false, nextCursor: null },
      profile: null, memories: [], mood: [], skill: null, returnNote: null,
      onboarding: { complete: true, answeredCount: 3, canFinish: true, question: null },
      developerModeAvailable: false, adapter: "scripted", modelModeLabel: "测试模式", modelCapabilities: {},
    } : { messages: [], memories: [], mood: [], profile: null, hasMore: false, nextCursor: null };
    await route.fulfill({ json: payload });
  });
  await page.goto("/");
  expect(await page.evaluate(() => typeof crypto.randomUUID)).toBe("undefined");
  await page.getByLabel("消息内容").fill(userMessage.content);
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(page.getByText("回复 1", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "重新生成", exact: true }).click();
  await expect(page.getByText("回复 2", { exact: true })).toBeVisible();
  await expect(page.locator(".message.user")).toHaveCount(1);
  expect(requests).toBe(2);
  expect(errors).toEqual([]);
});
