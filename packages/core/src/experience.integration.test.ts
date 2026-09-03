import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { closePool, getPool } from "./db";
import {
  addMessage, attachMemoryReceipt, claimJob, commitReflection, completeJob, createConversation,
  deleteAllUserData, enqueueJob, ensureUser, getModelCostData, getReflectionControlState, recordModelRun, searchMemories, updateSettings, withdrawMemory,
} from "./repository";
import { nextJobDelay, recoverReplyAttempts, recoverRunningJobs } from "./job-lifecycle";
import { enqueueQuestionPlanning, getPreparedQuestion, publishQuestionCandidates } from "./onboarding";
import { questionBank } from "./questions";
import { finishReplyAttempt, getBatchEvidence, getMessagePage, retryTurn, submitTurn } from "./turns";
import type { MemoryMutation, QuestionDefinition } from "./types";

const integration = process.env.INTEGRATION_DATABASE_URL ? describe : describe.skip;

integration("experience batches with isolated PostgreSQL", () => {
  const users = new Set<string>();
  const originalDatabaseUrl = process.env.DATABASE_URL;

  beforeAll(async () => {
    const target = new URL(process.env.INTEGRATION_DATABASE_URL!);
    // Worker recovery is deliberately global; these tests require a dedicated test database.
    if (!/test/iu.test(target.pathname)) throw new Error("experience integration requires a dedicated test database");
    await closePool();
    process.env.DATABASE_URL = target.toString();
  });

  afterEach(async () => {
    for (const userId of users) await deleteAllUserData(userId);
    users.clear();
  });

  afterAll(async () => {
    await closePool();
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  });

  async function fixture() {
    const userId = crypto.randomUUID();
    users.add(userId);
    await ensureUser(userId);
    const conversation = await createConversation(userId);
    return { userId, conversationId: conversation.id };
  }

  async function jobs(userId: string, type = "reflection") {
    return (await getPool().query(`SELECT * FROM jobs WHERE user_id=$1 AND type=$2 ORDER BY created_at,id`, [userId, type])).rows;
  }

  function createMemory(content: string, sourceId: string): MemoryMutation {
    return {
      operation: "create", category: "challenge", content, tier: "short", confidence: 0.8,
      validUntil: new Date(Date.now() + 7 * 86_400_000).toISOString(), reason: "用户描述了具体情况",
      evidenceMessageIds: [sourceId], triggerMessageId: sourceId,
    };
  }

  it("coalesces one and two messages behind idle time, then seals exactly three", async () => {
    const owner = await fixture();
    const first = await submitTurn({ ...owner, content: "我这周在准备大学物理的期末考试" });
    const one = (await jobs(owner.userId))[0]!;
    expect(one.payload).toMatchObject({ sourceMessageIds: [first.userMessage.id], sealed: false });
    expect(new Date(one.run_after).getTime() - Date.now()).toBeGreaterThan(9 * 60_000);
    const second = await submitTurn({ ...owner, content: "其中的电磁学章节让我很担心" });
    const two = (await jobs(owner.userId))[0]!;
    expect(two.id).toBe(one.id);
    expect(two.payload).toMatchObject({ sourceMessageIds: [first.userMessage.id, second.userMessage.id], sealed: false });
    expect(new Date(two.run_after).getTime() - Date.now()).toBeGreaterThan(9 * 60_000);
    expect(await claimJob("memory")).toBeNull();
    const third = await submitTurn({ ...owner, content: "周末会和同学一起复习这几章" });
    const three = await jobs(owner.userId);
    expect(three).toHaveLength(1);
    expect(three[0].payload).toMatchObject({ sourceMessageIds: [first.userMessage.id, second.userMessage.id, third.userMessage.id], sealed: true });
    expect(new Date(three[0].run_after).getTime()).toBeLessThanOrEqual(Date.now());
    expect((await claimJob("memory"))?.id).toBe(one.id);
    const fourth = await submitTurn({ ...owner, content: "今天又读完了一章力学教材" });
    expect((await jobs(owner.userId)).find((job) => job.id === fourth.jobId)?.payload.sourceMessageIds).toEqual([fourth.userMessage.id]);
  });

  it("seals a due idle batch on claim, and seals pending evidence for a control message", async () => {
    const owner = await fixture();
    const first = await submitTurn({ ...owner, content: "我下周要参加实习面试" });
    await getPool().query(`UPDATE jobs SET run_after=now()-interval '1 second' WHERE id=$1`, [first.jobId]);
    expect(await nextJobDelay("memory")).toBe(0);
    await claimJob("memory");
    expect((await jobs(owner.userId))[0].payload.sealed).toBe(true);
    await completeJob(first.jobId);
    const next = await submitTurn({ ...owner, content: "我在考虑上海的一份工作" });
    const control = await submitTurn({ ...owner, content: "请忘掉我刚才说的上海工作" });
    const sealed = (await jobs(owner.userId)).find((job) => job.id === next.jobId)!;
    expect(control.jobId).toBe(next.jobId);
    expect(sealed.payload).toMatchObject({ sealed: true, immediate: true, sourceMessageIds: [next.userMessage.id, control.userMessage.id] });
    expect(new Date(sealed.run_after).getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("retries only the latest reply, keeping one user evidence and old attempts", async () => {
    const owner = await fixture();
    const accepted = await submitTurn({ ...owner, content: "这周的毕业论文进度让我焦虑", clientRequestId: crypto.randomUUID() });
    const originalJobs = await getPool().query(`SELECT id,type FROM jobs WHERE user_id=$1 ORDER BY id`, [owner.userId]);
    let currentId = accepted.assistant!.id;
    const oldAttempts: string[] = [];
    for (const status of ["failed", "stopped", "completed"]) {
      await finishReplyAttempt({ userId: owner.userId, messageId: currentId, content: status === "failed" ? "" : "先听你把这件具体的事情说完。", metadata: { status, streaming: false } });
      oldAttempts.push(currentId);
      const retry = await retryTurn(owner.userId, owner.conversationId, currentId);
      expect(retry.userMessage.id).toBe(accepted.userMessage.id);
      currentId = retry.assistant.id;
    }
    const stored = await getPool().query(`SELECT id,role,is_current_reply,attempt_number FROM messages WHERE user_id=$1`, [owner.userId]);
    expect(stored.rows.filter((row) => row.role === "user")).toHaveLength(1);
    expect(stored.rows.filter((row) => row.role === "assistant")).toHaveLength(4);
    expect(stored.rows.filter((row) => oldAttempts.includes(row.id)).every((row) => !row.is_current_reply)).toBe(true);
    expect(stored.rows.find((row) => row.id === currentId)?.attempt_number).toBe(4);
    expect((await getMessagePage(owner.userId, owner.conversationId)).messages.map((message) => message.id)).toEqual([accepted.userMessage.id, currentId]);
    expect((await getPool().query(`SELECT id,type FROM jobs WHERE user_id=$1 ORDER BY id`, [owner.userId])).rows).toEqual(originalJobs.rows);
    await expect(retryTurn(owner.userId, owner.conversationId, oldAttempts[0]!)).rejects.toThrow("retry_latest_only");
    await expect(retryTurn(owner.userId, owner.conversationId, currentId)).rejects.toThrow("reply_in_progress");
  });

  it("paginates 181 same-timestamp messages without duplicates, omissions or cross-user reads", async () => {
    const owner = await fixture();
    const other = await fixture();
    const ids = Array.from({ length: 181 }, () => crypto.randomUUID()).sort();
    await getPool().query(`INSERT INTO messages(id,user_id,conversation_id,role,content,created_at)
      SELECT id,$2,$3,'user','分页历史消息','2026-09-03T01:00:00.123456Z'::timestamptz FROM unnest($1::uuid[]) id`, [ids, owner.userId, owner.conversationId]);
    const pages = [];
    let cursor: string | null = null;
    do {
      const page = await getMessagePage(owner.userId, owner.conversationId, cursor);
      pages.push(page);
      cursor = page.nextCursor;
      if (!page.hasMore) break;
    } while (pages.length < 4);
    expect(pages.map((page) => page.messages.length)).toEqual([80, 80, 21]);
    const all = pages.flatMap((page) => page.messages.map((message) => message.id));
    expect(new Set(all).size).toBe(181);
    expect([...all].sort()).toEqual(ids);
    await expect(getMessagePage(other.userId, owner.conversationId)).rejects.toThrow("conversation_not_found");
  });

  it("retains long-term candidates with over 200 recent memories and keeps reflection quota separate", async () => {
    const owner = await fixture();
    const other = await fixture();
    for (const [tier, count] of [["long", 5], ["short", 205]] as const) {
      const roots = Array.from({ length: count }, () => crypto.randomUUID());
      const versions = roots.map(() => crypto.randomUUID());
      await getPool().query(`INSERT INTO memories(id,user_id) SELECT id,$2 FROM unnest($1::uuid[]) id`, [roots, owner.userId]);
      await getPool().query(`INSERT INTO memory_versions(id,memory_id,user_id,category,content,tier,confidence,valid_until,reason,created_at)
        SELECT version_id,memory_id,$3,'interest','物理教材阅读',$4,0.8,CASE WHEN $4='short' THEN now()+interval '7 days' ELSE NULL END,
          '检索测试证据',CASE WHEN $4='long' THEN now()-interval '30 days' ELSE now() END
        FROM unnest($1::uuid[],$2::uuid[]) AS source(version_id,memory_id)`, [versions, roots, owner.userId, tier]);
    }
    const result = await searchMemories(owner.userId, "物理教材阅读", 8);
    expect(result.filter((memory) => memory.tier === "long")).toHaveLength(5);
    expect(result.filter((memory) => memory.tier === "short")).toHaveLength(3);
    const reflection = await searchMemories(owner.userId, "物理教材阅读", 12, undefined, "reflection");
    expect(reflection).toHaveLength(12);
    expect(reflection.filter((memory) => memory.tier === "short").length).toBeGreaterThan(3);
    expect(await searchMemories(other.userId, "物理教材阅读", 8)).toEqual([]);
  });

  it("preserves per-action evidence, original mood time and idempotent batch replay", async () => {
    const owner = await fixture();
    const other = await fixture();
    const first = await addMessage({ ...owner, role: "user", content: "购物退货被拒，我很委屈" });
    const second = await addMessage({ ...owner, role: "user", content: "物理考试安排在下周一" });
    const third = await addMessage({ ...owner, role: "user", content: "我希望你先听我说" });
    await getPool().query(`UPDATE messages SET created_at='2026-09-01T02:03:04Z' WHERE id=$1`, [first.id]);
    const sourceIds = [first.id, second.id, third.id];
    const content = {
      ...owner, sourceMessageId: third.id, sourceMessageIds: sourceIds, idempotencyKey: `batch:${first.id}`,
      reflection: {
        memories: [createMemory("购物退货受阻", first.id), createMemory("下周一参加物理考试", second.id)],
        mood: { score: -2, summary: "退货受阻后感到委屈", meaningful: true, evidenceMessageIds: [first.id] },
      },
    };
    const firstCommit = await commitReflection(content);
    const replay = await commitReflection(content);
    expect(replay.receipt.replayed).toBe(true);
    expect(replay.mutations.map((mutation) => mutation.versionId)).toEqual(firstCommit.mutations.map((mutation) => mutation.versionId));
    const evidence = await getPool().query(`SELECT memory_version_id,message_id FROM memory_evidence WHERE user_id=$1`, [owner.userId]);
    expect(evidence.rows).toEqual(expect.arrayContaining([
      { memory_version_id: firstCommit.mutations[0]!.versionId, message_id: first.id },
      { memory_version_id: firstCommit.mutations[1]!.versionId, message_id: second.id },
    ]));
    expect(evidence.rows).toHaveLength(2);
    const mood = await getPool().query(`SELECT message_id,observed_at FROM mood_samples WHERE user_id=$1`, [owner.userId]);
    expect(mood.rows).toHaveLength(1);
    expect(mood.rows[0].message_id).toBe(first.id);
    expect(new Date(mood.rows[0].observed_at).toISOString()).toBe("2026-09-01T02:03:04.000Z");
    expect((await getBatchEvidence(owner.userId, owner.conversationId, sourceIds)).map((message) => message.id)).toEqual(sourceIds);
    await expect(getBatchEvidence(other.userId, owner.conversationId, sourceIds)).rejects.toThrow("memory_evidence_scope_invalid");
    await expect(commitReflection({ ...content, idempotencyKey: `${content.idempotencyKey}:bad-trigger`, reflection: { memories: [{ ...createMemory("错误触发证据", first.id), triggerMessageId: third.id }] } })).rejects.toThrow("memory_evidence_scope_invalid");
  });

  it("aggregates all 201 model calls independently from the 200-row history page", async () => {
    const owner = await fixture();
    const other = await fixture();
    for (let index = 0; index < 201; index += 1) {
      await recordModelRun({ ...owner, traceId: crypto.randomUUID(), role: "dialogue", adapterId: "test-gateway", inputTokens: 100,
        outputTokens: 20, cachedInputTokens: 10, reasoningTokens: 2, searchCalls: 1, estimatedCostCny: 0.01,
        durationMs: 1, finishReason: "completed" });
    }
    const data = await getModelCostData(owner.userId);
    expect(data.runs).toHaveLength(200);
    expect(data.totals).toMatchObject({ input_tokens: 20_100, output_tokens: 4_020, cached_input_tokens: 2_010, reasoning_tokens: 402, search_calls: 201 });
    expect(data.totals.total_cost).toBeCloseTo(2.01, 6);
    expect((await getModelCostData(other.userId)).totals.total_cost).toBe(0);
  }, 20_000);

  it("recovers an interrupted running job and replays its already committed operation once", async () => {
    const owner = await fixture();
    const source = await addMessage({ ...owner, role: "user", content: "我下周一要参加物理考试" });
    const jobId = await enqueueJob({ userId: owner.userId, type: "reflection", payload: { conversationId: owner.conversationId, sourceMessageIds: [source.id], sealed: true }, idempotencyKey: `job:${source.id}` });
    const first = await claimJob("memory");
    expect(first?.id).toBe(jobId);
    const operation = { ...owner, sourceMessageId: source.id, idempotencyKey: `reflection:${source.id}`, reflection: { memories: [createMemory("下周一参加物理考试", source.id)] } };
    const committed = await commitReflection(operation);
    expect(await recoverRunningJobs()).toBe(1);
    expect(await recoverRunningJobs()).toBe(0);
    expect((await claimJob("memory"))?.id).toBe(jobId);
    const repeated = await commitReflection(operation);
    expect(repeated.receipt.replayed).toBe(true);
    expect(repeated.mutations[0]!.versionId).toBe(committed.mutations[0]!.versionId);
    expect((await getPool().query(`SELECT id FROM memory_versions WHERE user_id=$1`, [owner.userId])).rows).toHaveLength(1);
    await completeJob(jobId);
    expect(await claimJob("memory")).toBeNull();
  });

  it("rejects a proposal generated across a UI withdrawal and keeps control history out of normal recall", async () => {
    const owner = await fixture();
    const other = await fixture();
    const source = await addMessage({ ...owner, role: "user", content: "我这周在准备物理考试" });
    const initial = await commitReflection({ ...owner, sourceMessageId: source.id, idempotencyKey: `initial:${source.id}`, reflection: { memories: [createMemory("这周准备物理考试", source.id)] } });
    const pending = await addMessage({ ...owner, role: "user", content: "考试具体安排在周一，我有点紧张" });
    const before = await getReflectionControlState(owner.userId, "物理考试", pending.createdAt);
    expect(before.withdrawals).toEqual([]);
    const target = initial.mutations[0]!;
    await withdrawMemory({ userId: owner.userId, memoryId: target.memoryId, versionId: target.versionId, idempotencyKey: `ui-withdraw:${target.versionId}` });
    const counts = await getPool().query(`SELECT
      (SELECT count(*) FROM memory_versions WHERE user_id=$1)::int AS versions,
      (SELECT count(*) FROM memory_events WHERE user_id=$1)::int AS events,
      (SELECT count(*) FROM mood_samples WHERE user_id=$1)::int AS moods,
      (SELECT count(*) FROM memory_operations WHERE user_id=$1)::int AS operations`, [owner.userId]);
    await expect(commitReflection({
      ...owner, sourceMessageId: pending.id, sourceMessageIds: [pending.id], expectedMutationCursor: before.mutationCursor,
      idempotencyKey: `stale-model-result:${pending.id}`,
      reflection: {
        memories: [createMemory("物理考试安排在周一", pending.id)],
        mood: { score: -2, summary: "担心周一的考试", meaningful: true, evidenceMessageIds: [pending.id] },
      },
    })).rejects.toThrow("memory_version_conflict");
    const afterCounts = await getPool().query(`SELECT
      (SELECT count(*) FROM memory_versions WHERE user_id=$1)::int AS versions,
      (SELECT count(*) FROM memory_events WHERE user_id=$1)::int AS events,
      (SELECT count(*) FROM mood_samples WHERE user_id=$1)::int AS moods,
      (SELECT count(*) FROM memory_operations WHERE user_id=$1)::int AS operations`, [owner.userId]);
    expect(afterCounts.rows).toEqual(counts.rows);
    const refreshed = await getReflectionControlState(owner.userId, "物理考试", pending.createdAt);
    expect(refreshed.mutationCursor).toBeGreaterThan(before.mutationCursor);
    expect(refreshed.withdrawals).toHaveLength(1);
    expect(refreshed.withdrawals[0]).toMatchObject({ memoryId: target.memoryId, versionId: target.versionId, content: "这周准备物理考试" });
    expect(new Date(refreshed.withdrawals[0].withdrawnAt).getTime()).toBeGreaterThanOrEqual(new Date(pending.createdAt).getTime());
    expect(await searchMemories(owner.userId, "物理考试", 8)).toEqual([]);
    expect(await getReflectionControlState(other.userId, "物理考试", pending.createdAt)).toEqual({ mutationCursor: 0, withdrawals: [] });
  });

  it("serves three common questions immediately and keeps only one planner per user", async () => {
    const owner = await fixture();
    await enqueueQuestionPlanning(owner.userId);
    expect(await jobs(owner.userId, "onboarding_plan")).toHaveLength(0);
    for (let step = 0; step < 3; step += 1) {
      const question = await getPreparedQuestion(owner.userId, step);
      expect(question).toEqual(questionBank[step]);
      expect(await getPreparedQuestion(owner.userId, step)).toEqual(question);
    }
    await addMessage({ ...owner, role: "user", content: "我是一名大学生", metadata: { kind: "onboarding-answer", questionId: questionBank[0]!.id } });
    await Promise.all(Array.from({ length: 6 }, () => enqueueQuestionPlanning(owner.userId)));
    const pending = await jobs(owner.userId, "onboarding_plan");
    expect(pending).toHaveLength(1);
    expect(pending[0].status).toBe("pending");
    expect((await claimJob("planning"))?.id).toBe(pending[0].id);
    await Promise.all(Array.from({ length: 6 }, () => enqueueQuestionPlanning(owner.userId)));
    const running = await jobs(owner.userId, "onboarding_plan");
    expect(running).toHaveLength(1);
    expect(running[0].status).toBe("running");
  });

  it("caps ready questions at two and defers late personalized results beyond an already displayed fallback", async () => {
    const owner = await fixture();
    const fallback = await getPreparedQuestion(owner.userId, 3);
    expect(fallback).toEqual(questionBank[3]);
    const candidates: QuestionDefinition[] = [
      { id: "custom-physics", category: "goal", text: "这周最想理解哪个物理概念？", options: ["力学", "电磁学"], priority: 90 },
      { id: "custom-study-rhythm", category: "expression", text: "你希望我们怎样安排复习对话？", options: ["先听困惑", "一起拆解"], priority: 80 },
      { id: "custom-reading", category: "interest", text: "课外最近最想读什么类型的书？", options: ["科普", "小说"], priority: 70 },
    ];
    await publishQuestionCandidates(owner.userId, candidates, "test-planner", 1);
    const ready = async () => (await getPool().query(`SELECT question,source_answer_count FROM onboarding_question_candidates WHERE user_id=$1 AND selected_at IS NULL`, [owner.userId])).rows;
    expect(await ready()).toHaveLength(2);
    expect((await ready()).map((row) => row.question.id).sort()).toEqual(candidates.slice(0, 2).map((candidate) => candidate.id).sort());
    expect((await ready()).every((row) => row.source_answer_count === 1)).toBe(true);
    expect(await getPreparedQuestion(owner.userId, 3)).toEqual(fallback);
    expect(await ready()).toHaveLength(2);
    await addMessage({ ...owner, role: "user", content: "想把物理课跟上", metadata: { kind: "onboarding-answer", questionId: fallback!.id } });
    const fourth = await getPreparedQuestion(owner.userId, 4);
    expect(candidates.slice(0, 2).map((candidate) => candidate.id)).toContain(fourth!.id);
    expect(await getPreparedQuestion(owner.userId, 4)).toEqual(fourth);
    expect(await ready()).toHaveLength(1);
    await publishQuestionCandidates(owner.userId, candidates.slice(2), "test-planner", 2);
    expect(await ready()).toHaveLength(2);
    await publishQuestionCandidates(owner.userId, candidates, "test-planner", 3);
    expect(await ready()).toHaveLength(2);
    expect(await getPreparedQuestion(owner.userId, 3)).toEqual(fallback);
    expect(await getPreparedQuestion(owner.userId, 4)).toEqual(fourth);
  });

  it("keeps a later forget batch behind an earlier retry delay without blocking other users or planning", async () => {
    const owner = await fixture();
    const other = await fixture();
    const earlier = await enqueueJob({ userId: owner.userId, type: "reflection", payload: { conversationId: owner.conversationId, sealed: true }, idempotencyKey: "earlier-sealed" });
    const forget = await enqueueJob({ userId: owner.userId, type: "reflection", payload: { conversationId: owner.conversationId, sealed: true, immediate: true, content: "请忘掉上海求职" }, idempotencyKey: "later-forget" });
    await getPool().query(`UPDATE jobs SET created_at=now()-interval '2 minutes',run_after=now()+interval '30 seconds',attempts=1 WHERE id=$1`, [earlier]);
    await getPool().query(`UPDATE jobs SET created_at=now()-interval '1 minute',run_after=now()-interval '1 second' WHERE id=$1`, [forget]);
    expect(await claimJob("memory")).toBeNull();
    const backoffDelay = await nextJobDelay("memory");
    expect(backoffDelay).toBeGreaterThan(0);
    expect(backoffDelay).toBeLessThanOrEqual(30_000);
    const independent = await enqueueJob({ userId: other.userId, type: "reflection", payload: { conversationId: other.conversationId, sealed: true }, idempotencyKey: "independent-user" });
    expect((await claimJob("memory"))?.id).toBe(independent);
    await completeJob(independent);
    const planning = await enqueueJob({ userId: owner.userId, type: "conversation_title", payload: { conversationId: owner.conversationId }, idempotencyKey: "independent-planning" });
    expect((await claimJob("planning"))?.id).toBe(planning);
    await completeJob(planning);
    expect(await nextJobDelay("memory")).toBeGreaterThan(0);
    await getPool().query(`UPDATE jobs SET run_after=now()-interval '1 second' WHERE id=$1`, [earlier]);
    expect((await claimJob("memory"))?.id).toBe(earlier);
    expect(await claimJob("memory")).toBeNull();
    expect(await nextJobDelay("memory")).toBeGreaterThan(0);
    await completeJob(earlier);
    expect((await claimJob("memory"))?.id).toBe(forget);
  });

  it("preserves asynchronous memory receipts at completion and targets the current retried reply", async () => {
    const owner = await fixture();
    const accepted = await submitTurn({ ...owner, content: "我明天要参加物理考试" });
    expect(await attachMemoryReceipt({ ...owner, sourceMessageId: accepted.userMessage.id, receipt: "已经整理这段新的认识。" })).toBe(accepted.assistant!.id);
    await finishReplyAttempt({ userId: owner.userId, messageId: accepted.assistant!.id, content: "先从最让你担心的部分说起。", metadata: { status: "completed", streaming: false } });
    const original = (await getPool().query(`SELECT metadata FROM messages WHERE id=$1`, [accepted.assistant!.id])).rows[0];
    expect(original.metadata).toMatchObject({ memoryReceipt: "已经整理这段新的认识。", status: "completed", traceId: accepted.traceId });
    const retry = await retryTurn(owner.userId, owner.conversationId, accepted.assistant!.id);
    const legacy = await addMessage({ ...owner, role: "assistant", content: "无明确回复关联的历史回答", metadata: { traceId: accepted.traceId, status: "completed" } });
    await getPool().query(`UPDATE messages SET created_at=(SELECT created_at FROM messages WHERE id=$2)+interval '1 microsecond' WHERE id=$1`, [legacy.id, accepted.userMessage.id]);
    expect(await attachMemoryReceipt({ ...owner, sourceMessageId: accepted.userMessage.id, receipt: "长期认识已更新。" })).toBe(retry.assistant.id);
    await finishReplyAttempt({ userId: owner.userId, messageId: retry.assistant.id, content: "我先听你把担心说完整。", metadata: { status: "completed", streaming: false } });
    const rows = (await getPool().query(`SELECT id,is_current_reply,metadata FROM messages WHERE id=ANY($1::uuid[])`, [[accepted.assistant!.id, retry.assistant.id, legacy.id]])).rows;
    expect(rows.find((row) => row.id === accepted.assistant!.id)).toMatchObject({ is_current_reply: false, metadata: { memoryReceipt: "已经整理这段新的认识。" } });
    expect(rows.find((row) => row.id === retry.assistant.id)).toMatchObject({ is_current_reply: true, metadata: { memoryReceipt: "长期认识已更新。", status: "completed", traceId: retry.traceId } });
    expect(rows.find((row) => row.id === legacy.id)?.metadata.memoryReceipt).toBeUndefined();
  });

  it("recovers an abandoned streaming reply without erasing its partial text and allows retry", async () => {
    const owner = await fixture();
    const accepted = await submitTurn({ ...owner, content: "我担心明天的组会汇报" });
    await finishReplyAttempt({ userId: owner.userId, messageId: accepted.assistant!.id, content: "这次汇报对你很重要，", metadata: { status: "streaming", streaming: true, memoryReceipt: "认识已整理。" } });
    expect(await recoverReplyAttempts()).toBe(1);
    expect(await recoverReplyAttempts()).toBe(0);
    const stored = (await getPool().query(`SELECT content,metadata FROM messages WHERE id=$1`, [accepted.assistant!.id])).rows[0];
    expect(stored).toMatchObject({ content: "这次汇报对你很重要，", metadata: { status: "interrupted", streaming: false, memoryReceipt: "认识已整理。", traceId: accepted.traceId } });
    const retried = await retryTurn(owner.userId, owner.conversationId, accepted.assistant!.id);
    expect(retried.userMessage.id).toBe(accepted.userMessage.id);
    expect(retried.assistant.id).not.toBe(accepted.assistant!.id);
  });

  it("does not expose withdrawn content to reflection while its memory layer is paused",async()=>{
    const owner=await fixture();
    const source=await addMessage({...owner,role:"user",content:"我正在处理一笔鞋子退货"});
    const committed=await commitReflection({userId:owner.userId,conversationId:owner.conversationId,sourceMessageId:source.id,
      reflection:{memories:[createMemory("正在处理一笔鞋子退货",source.id)],mood:null},idempotencyKey:`reflection:${source.id}:privacy`});
    await withdrawMemory({userId:owner.userId,memoryId:committed.mutations[0]!.memoryId,versionId:committed.mutations[0]!.versionId,idempotencyKey:`withdraw:${source.id}`});
    expect((await getReflectionControlState(owner.userId,"鞋子退货",source.createdAt)).withdrawals).toHaveLength(1);
    await updateSettings(owner.userId,{memoryEnabled:false});
    expect((await getReflectionControlState(owner.userId,"鞋子退货",source.createdAt)).withdrawals).toHaveLength(0);
  });
});
