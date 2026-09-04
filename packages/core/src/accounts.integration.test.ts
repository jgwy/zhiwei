import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { closePool, getPool } from "./db";
import { ACCOUNT_DATA_TABLES, bindAccount, checkAccountAttempts, getAccount, resolveAccountUserId, restoreAccount } from "./accounts";
import { addMessage, commitReflection, createConversation, deleteAllUserData, ensureUser, getLatestProfile, getProfileForContext, listConversations, publishPersonalSkill, searchMemories, updateSettings } from "./repository";
import { getPreparedQuestion } from "./onboarding";
import { defaultPersonalSkill } from "./personal-skill";
import { getMessagePage, submitTurn, finishReplyAttempt } from "./turns";

const integration = process.env.INTEGRATION_DATABASE_URL ? describe : describe.skip;
integration("account recovery with isolated PostgreSQL", () => {
  const ids = new Set<string>();
  const originalUrl = process.env.DATABASE_URL;
  const password = "only-a-test-password-123";
  beforeAll(async () => {
    const target = new URL(process.env.INTEGRATION_DATABASE_URL!);
    if (!/test/iu.test(target.pathname)) throw new Error("account integration requires a dedicated test database");
    await closePool(); process.env.DATABASE_URL = target.toString();
  });
  afterEach(async () => { for (const id of ids) await deleteAllUserData(id); ids.clear(); });
  afterAll(async () => { await closePool(); if (originalUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = originalUrl; });

  async function fixture(name = "游客") {
    const userId = crypto.randomUUID(); ids.add(userId); await ensureUser(userId);
    const conversation = await createConversation(userId, "chat", name);
    const message = await addMessage({ userId, conversationId: conversation.id, role: "user", content: `${name}的原始聊天` });
    return { userId, conversationId: conversation.id, message, username: `account-${userId.slice(0, 12)}` };
  }
  async function memory(userId: string, messageId: string, conversationId: string, content: string) {
    return commitReflection({ userId, conversationId, sourceMessageId: messageId, sourceMessageIds: [messageId], idempotencyKey: `reflection:${messageId}`, reflection: { memories: [{ operation: "create", category: "interest", content, tier: "long", confidence: .8, validUntil: null, reason: "明确描述", evidenceMessageIds: [messageId], triggerMessageId: messageId }], mood: null } });
  }

  it("covers every user-owned table in the actual migrated schema", async () => {
    const columns = await getPool().query(`SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='user_id'`);
    expect(columns.rows.map((row) => row.table_name).sort()).toEqual([...ACCOUNT_DATA_TABLES, "accounts"].sort());
  });

  it("binds a unique account; wrong credentials leave both owners unchanged", async () => {
    const owner = await fixture("账号"); const guest = await fixture();
    await bindAccount(owner.userId, { username: owner.username, password });
    expect(await getAccount(owner.userId)).toEqual({ username: owner.username });
    await expect(bindAccount(guest.userId, { username: owner.username, password })).rejects.toMatchObject({ code: "account_name_taken" });
    await expect(restoreAccount(guest.userId, { username: owner.username, password: "incorrect-password" })).rejects.toMatchObject({ code: "account_credentials_invalid" });
    expect(await resolveAccountUserId(guest.userId)).toBe(guest.userId);
    expect(await listConversations(guest.userId)).toHaveLength(1);
    expect(await listConversations(owner.userId)).toHaveLength(1);
  });

  it("merges data without changing message IDs, evidence, expiry, summaries or other users", async () => {
    const owner = await fixture("旧账号"); const guest = await fixture("当前游客"); const other = await fixture("其他用户");
    await bindAccount(owner.userId, { username: owner.username, password });
    await memory(owner.userId, owner.message.id, owner.conversationId, "用户喜欢摄影");
    await memory(guest.userId, guest.message.id, guest.conversationId, "用户正在学习钢琴");
    await updateSettings(owner.userId, { emotionTrackingEnabled: false });
    await updateSettings(guest.userId, { returnNotesEnabled: false });
    for (const person of [owner, guest]) {
      await getPreparedQuestion(person.userId, 0);
      await getPreparedQuestion(person.userId, 1);
      await publishPersonalSkill({ userId: person.userId, skill: defaultPersonalSkill, source: "model" });
      await getPool().query(`INSERT INTO profile_snapshots(id,user_id,summary,dimension_weights,understanding_components,understanding_score,sync_status) VALUES(gen_random_uuid(),$1,$2,'{}','{}',8,'current')`, [person.userId, `${person.username}的画像原文`]);
      await getPool().query(`INSERT INTO conversation_summaries(id,user_id,conversation_id,summary,source_message_id) VALUES(gen_random_uuid(),$1,$2,$3,$4)`, [person.userId, person.conversationId, `${person.username}的会话摘要`, person.message.id]);
      await getPool().query(`INSERT INTO jobs(id,user_id,type,payload,idempotency_key) VALUES(gen_random_uuid(),$1,'onboarding_plan','{}','same-key')`, [person.userId]);
    }
    const before = (await getPool().query(`SELECT id,content,created_at FROM messages WHERE user_id=ANY($1::uuid[]) ORDER BY id`, [[owner.userId, guest.userId]])).rows;
    const first = await restoreAccount(guest.userId, { username: owner.username, password });
    expect(first.alreadyRestored).toBe(false);
    expect(await resolveAccountUserId(guest.userId)).toBe(owner.userId);
    expect(await listConversations(owner.userId)).toHaveLength(2);
    expect((await getMessagePage(owner.userId, guest.conversationId)).messages[0]?.id).toBe(guest.message.id);
    expect((await getPool().query(`SELECT id,content,created_at FROM messages WHERE user_id=$1 ORDER BY id`, [owner.userId])).rows).toEqual(before);
    expect((await getPool().query(`SELECT count(*)::int AS count FROM memory_evidence WHERE user_id=$1`, [owner.userId])).rows[0].count).toBe(2);
    expect(await searchMemories(owner.userId, "用户")).toHaveLength(2);
    expect((await memory(owner.userId, guest.message.id, guest.conversationId, "用户正在学习钢琴")).receipt.replayed).toBe(true);
    expect((await getPool().query(`SELECT count(*)::int AS count FROM jobs WHERE user_id=$1 AND payload->>'trigger'='account-restored'`, [owner.userId])).rows[0].count).toBe(1);
    expect((await getLatestProfile(owner.userId))?.syncStatus).toBe("stale");
    expect(await getProfileForContext(owner.userId)).toBeNull();
    expect((await getPool().query(`SELECT settings FROM users WHERE id=$1`, [owner.userId])).rows[0].settings).toMatchObject({ emotionTrackingEnabled: false, returnNotesEnabled: false });
    const next = await publishPersonalSkill({ userId: owner.userId, skill: defaultPersonalSkill, source: "model" });
    expect(next.version).toBe(5);
    expect((await restoreAccount(guest.userId, { username: owner.username, password })).alreadyRestored).toBe(true);
    expect(await listConversations(owner.userId)).toHaveLength(2);
    expect(await listConversations(other.userId)).toHaveLength(1);
    for (const table of ACCOUNT_DATA_TABLES)
      expect((await getPool().query(`SELECT count(*)::int AS count FROM ${table} WHERE user_id=$1`, [guest.userId])).rows[0].count).toBe(0);
    await expect(addMessage({ userId: guest.userId, conversationId: guest.conversationId, role: "user", content: "过期请求" })).rejects.toThrow("account_session_changed");
  });

  it("refuses recovery during a reply or running job, then preserves the completed reply", async () => {
    const owner = await fixture(); const guest = await fixture();
    await bindAccount(owner.userId, { username: owner.username, password });
    const turn = await submitTurn({ userId: guest.userId, conversationId: guest.conversationId, content: "准备明天的考试" });
    await expect(restoreAccount(guest.userId, { username: owner.username, password })).rejects.toMatchObject({ code: "account_data_busy" });
    await finishReplyAttempt({ userId: guest.userId, messageId: turn.assistant!.id, content: "先把需要复习的内容梳理一下。", metadata: { status: "completed", streaming: false } });
    await getPool().query(`UPDATE jobs SET status='running' WHERE id=$1`, [turn.jobId]);
    await expect(restoreAccount(guest.userId, { username: owner.username, password })).rejects.toMatchObject({ code: "account_data_busy" });
    await getPool().query(`UPDATE jobs SET status='pending' WHERE id=$1`, [turn.jobId]);
    await restoreAccount(guest.userId, { username: owner.username, password });
    expect((await getMessagePage(owner.userId, guest.conversationId)).messages).toHaveLength(3);
  });

  it("does not merge two already-bound accounts, and deletion clears aliases and credentials", async () => {
    const owner = await fixture(); const second = await fixture(); const guest = await fixture();
    await bindAccount(owner.userId, { username: owner.username, password });
    await bindAccount(second.userId, { username: second.username, password });
    await expect(restoreAccount(second.userId, { username: owner.username, password })).rejects.toMatchObject({ code: "account_already_bound" });
    await restoreAccount(guest.userId, { username: owner.username, password });
    await deleteAllUserData(owner.userId);
    expect(await getAccount(owner.userId)).toBeNull();
    expect((await getPool().query(`SELECT id FROM users WHERE id=ANY($1::uuid[])`, [[owner.userId, guest.userId]])).rowCount).toBe(0);
    expect(await getAccount(second.userId)).toEqual({ username: second.username });
    expect(await listConversations(second.userId)).toHaveLength(1);
  });

  it("limits repeated account guesses before hashing", async () => {
    const guest = await fixture();
    for (let i = 0; i < 10; i++) await checkAccountAttempts(guest.userId, guest.username);
    await expect(checkAccountAttempts(guest.userId, guest.username)).rejects.toMatchObject({ code: "account_rate_limited" });
  });
});
