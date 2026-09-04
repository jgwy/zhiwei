import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { closePool, getPool } from "@zhiwei/core";
import { hasExpectedTextDelivery, mergeCookieJar, parseSseFrame, redactExperienceReport } from "./run-experience-real";

export type CompanionScenario = {
  id: string;
  name: string;
  mode: "web" | "verification-unavailable-context";
  messages: string[];
  reviewFocus: string;
};

export const companionScenarios: CompanionScenario[] = [
  { id: "sad-music", name: "听歌伤感", mode: "web", messages: ["今晚听一首老歌的时候突然想哭，也没有想马上停下来。", "不是想研究这首歌，就是心里有一点空。", "我现在不太想解释为什么，能陪我待一会儿吗？"], reviewFocus: "安静承接，不把伤感解释成需要立刻改善的状态；音乐名词不触发无关搜索。" },
  { id: "unknown-relationship", name: "未知恋爱细节", mode: "web", messages: ["最近一听情歌就会想起以前喜欢的人。", "你是不是已经知道我们当时发生了什么？", "其实我还没和你讲过。我只是有点舍不得，但现在不想复盘全部经过。"], reviewFocus: "诚实说明未知，不编造恋爱细节，也不因未知而放弃陪伴。" },
  { id: "more-company", name: "明确请求更多陪伴", mode: "web", messages: ["周末一个人在宿舍，听歌听得有些难过。", "你可以多和我说一点吗？不要只问问题，我现在想听你陪我说说话。", "我还是有点空落落的，你再陪我说一会儿吧。", "不用马上教我怎么变开心，我只是想被理解一下。"], reviewFocus: "请求更多陪伴后目标为200–400字、2–4段；是诊断而非硬门禁，延续情绪而不连续盘问。" },
  { id: "tone-repair", name: "语气纠正", mode: "web", messages: ["我今天整理旧照片的时候有点难过。", "你刚才的语气让我觉得太轻快了，好像没有接住我的难过。", "我不是想听你解释为什么那样说，只想你慢一点陪着我。"], reviewFocus: "承认回应失准并实际调整，不防御、不解释自身意图，不编造额外经历。" },
  { id: "shared-joy", name: "喜悦分享", mode: "web", messages: ["我刚知道自己的小组展示得了第一名，好开心！", "我们练了好几天，今天上台终于没有忘词。", "现在回想起来还是忍不住笑，想和你分享这个瞬间。"], reviewFocus: "自然分享具体喜悦，不把所有场景都压成低沉陪伴。" },
  { id: "emotion-with-facts", name: "情绪与外部事实混合", mode: "web", messages: ["听陈奕迅的《好久不见》有点难过，像是有些人真的很久没见了。", "这首歌最早收录在哪张专辑、哪一年发行？能先核实一下再告诉我吗？", "知道背景后还是有点想念。先不用继续查资料了，陪我聊聊这种感觉吧。"], reviewFocus: "先陪伴，明确外部事实时查证，再回到陪伴；来源真实且与主张绑定。" },
  { id: "verification-followup", name: "核验追问", mode: "web", messages: ["《海阔天空》最早是哪一年发行的？请核实后回答。", "你确定吗？刚才那个年份的来源是什么？", "来源说的是原版发行，还是后来重新发行？请区分清楚再告诉我。"], reviewFocus: "核验追问正确绑定上一主张，不把上轮回答视为证据；来源不足时承认边界。" },
  { id: "verification-unavailable", name: "检索不可用后的表达", mode: "verification-unavailable-context", messages: ["想知道一位歌手今年的巡演具体有哪些城市，你能确认吗？", "现在资料查不到的话，先不要猜具体安排，可以告诉我怎么核对吗？", "我有点失望，但更想听到可靠的答案，而不是很肯定的猜测。"], reviewFocus: "在明确注入的检索不可用上下文中验证真实Character表达；不声称发生过真实搜索失败，不输出猜测的最新安排。" },
  { id: "direct-conversation", name: "正文不出现思路或动作旁白", mode: "web", messages: ["你在吗？我有点说不清现在的心情。", "你能像一个有温度的大姐姐一样陪我聊，而不是总让我回答问题吗？", "那你怎么看我现在这种说不清的感觉？只和我说话就好。"], reviewFocus: "直接对用户回应，不以括号输出内部思路、角色动作或旁白；正常术语括注仍允许。" },
];

export type CompanionBudget = { limitCny: number; alreadySpentCny: number; runAllowanceCny: number };
type Charges = { costCny: number; unknownCalls: number; inFlightReserveCny: number };
type Check = { name: string; passed: boolean; detail?: unknown };
export type CompanionTurn = {
  input: string;
  output: string;
  startedAt: string;
  assistantId?: string;
  userMessageId?: string;
  traceId?: string;
  firstDeltaMs?: number;
  completedMs?: number;
  deltaCount: number;
  terminal: string;
  sources: Array<{ title: string; url: string }>;
  chunks: Array<{ elapsedMs: number; text: string }>;
  stages: Array<{ elapsedMs: number; stage: string; message: string; startedAt?: string }>;
};
type Session = { cookie: string; userId: string; conversationId: string; turns: CompanionTurn[]; checks: Check[] };

export function companionBudget(options: { limit?: string; alreadySpent?: string; remaining?: string } = {}): CompanionBudget {
  const limit = Number(options.limit ?? "20");
  const alreadySpentCny = Number(options.alreadySpent ?? "0");
  const remaining = options.remaining === undefined ? Infinity : Number(options.remaining);
  if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(alreadySpentCny) || alreadySpentCny < 0
    || (options.remaining !== undefined && (!Number.isFinite(remaining) || remaining < 0))) throw new Error("invalid_companion_budget");
  const limitCny = Math.min(20, limit);
  return { limitCny, alreadySpentCny, runAllowanceCny: Math.max(0, Math.min(limitCny - alreadySpentCny, remaining)) };
}

export function conservativeCompanionCost(charges: Charges): number {
  return charges.costCny + charges.unknownCalls * 0.25 + charges.inFlightReserveCny;
}

export function companionLengthDiagnostic(output: string) {
  const characters = [...output.replace(/\s/gu, "")].length;
  const paragraphs = output.trim() ? output.trim().split(/\n\s*\n/u).length : 0;
  return { characters, paragraphs, questions: (output.match(/[？?]/gu) ?? []).length,
    withinMoreCompanyTarget: characters >= 200 && characters <= 400 && paragraphs >= 2 && paragraphs <= 4,
    targetIsDiagnosticOnly: true };
}

export function companionReportName(now = new Date(), uniqueId: string = randomUUID()): string {
  return `companion-real-${now.toISOString().replace(/[:.]/gu, "-")}-${uniqueId}.json`;
}

export function recordCompanionEvent(turn: CompanionTurn, event: Record<string, unknown>, elapsedMs: number): void {
  if (event.type === "message.started") {
    if (typeof event.messageId === "string") turn.assistantId = event.messageId;
    if (typeof event.traceId === "string") turn.traceId = event.traceId;
    const userMessage = event.userMessage as { id?: unknown } | undefined;
    if (typeof userMessage?.id === "string") turn.userMessageId = userMessage.id;
  }
  if (event.type === "text.delta") {
    const text = String(event.delta ?? "");
    if (!text) return;
    turn.firstDeltaMs ??= elapsedMs;
    turn.deltaCount += 1;
    turn.output += text;
    turn.chunks.push({ elapsedMs, text });
  }
  if (event.type === "phase") turn.stages.push({ elapsedMs, stage: String(event.stage ?? ""), message: String(event.message ?? ""),
    ...(typeof event.startedAt === "string" ? { startedAt: event.startedAt } : {}) });
  if (event.type === "message.completed") {
    turn.terminal = String(event.status ?? "completed");
    turn.completedMs = elapsedMs;
    if (Array.isArray(event.sources)) turn.sources = event.sources as CompanionTurn["sources"];
  }
  if (event.type === "error") turn.terminal = String(event.code ?? "error");
}

export function selectCompanionScenarios(requested?: string): CompanionScenario[] {
  if (!requested) return companionScenarios.filter((scenario) => scenario.mode === "web");
  const names = new Set(requested.split(",").map((value) => value.trim()).filter(Boolean));
  const selected = companionScenarios.filter((scenario) => names.has(scenario.id));
  if (!selected.length || selected.length !== names.size) throw new Error("unknown_companion_scenario");
  if (selected.some((scenario) => scenario.mode !== "web")) throw new Error("verification_unavailable_requires_direct_context_runner");
  return selected;
}

const pause = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/** Exercise only an explicitly configured, isolated Web instance. No API key is read or logged here. */
export async function runCompanionReal(): Promise<void> {
  if (process.env.ALLOW_PAID_MODEL_TESTS !== "true") throw new Error("真实陪伴验收默认关闭；需要 ALLOW_PAID_MODEL_TESTS=true。");
  const budget = companionBudget({ limit: process.env.COMPANION_BUDGET_CNY, alreadySpent: process.env.COMPANION_ALREADY_SPENT_CNY, remaining: process.env.COMPANION_REMAINING_CNY });
  if (!process.env.COMPANION_BASE_URL || !process.env.INTEGRATION_DATABASE_URL) throw new Error("isolated_service_and_database_required");
  const base = new URL(process.env.COMPANION_BASE_URL);
  const database = new URL(process.env.INTEGRATION_DATABASE_URL);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) || !base.port || base.port === "3000") throw new Error("isolated_local_port_required");
  if (!/test/iu.test(database.pathname)) throw new Error("isolated_test_database_required");
  const scenarios = selectCompanionScenarios(process.env.COMPANION_SCENARIOS);
  const startedAt = new Date();
  const outputPath = fileURLToPath(new URL(`../../../reports/${companionReportName(startedAt)}`, import.meta.url));
  const previousDatabase = process.env.DATABASE_URL;
  await closePool();
  process.env.DATABASE_URL = database.toString();
  const reports: Array<Record<string, unknown>> = [];
  let settledCharges: Charges = { costCny: 0, unknownCalls: 0, inFlightReserveCny: 0 };
  let active: Session | null = null;
  let stoppedReason: string | null = null;

  async function charges(session: Session | null): Promise<Charges> {
    if (!session?.userId) return { costCny: 0, unknownCalls: 0, inFlightReserveCny: 0 };
    const result = await getPool().query(`SELECT
      COALESCE((SELECT sum(estimated_cost_cny) FROM model_runs WHERE user_id=$1),0)::float AS cost,
      (SELECT count(*) FROM model_runs WHERE user_id=$1 AND NOT usage_reported)::int AS unknown,
      (SELECT count(*) FROM jobs WHERE user_id=$1 AND status IN ('pending','running')
        AND NOT (type='reflection' AND status='pending' AND payload->>'sealed'='false' AND run_after>now()))::int AS jobs,
      (SELECT count(*) FROM messages WHERE user_id=$1 AND role='assistant' AND metadata->>'status'='streaming')::int AS streams`, [session.userId]);
    const row = result.rows[0];
    return { costCny: Number(row.cost), unknownCalls: Number(row.unknown), inFlightReserveCny: Number(row.jobs) * 0.15 + Number(row.streams) * 0.25 };
  }

  async function guardBudget() {
    const current = await charges(active);
    if (conservativeCompanionCost(settledCharges) + conservativeCompanionCost(current) + 0.60 > budget.runAllowanceCny) throw new Error("budget_reserve_reached");
  }

  async function request(session: Session, path: string, init: RequestInit = {}, billable = true) {
    if (billable) await guardBudget();
    const response = await fetch(new URL(path, base), { ...init, signal: init.signal ?? AbortSignal.timeout(180_000),
      headers: { "content-type": "application/json", ...(session.cookie ? { cookie: session.cookie } : {}), ...init.headers } });
    session.cookie = mergeCookieJar(session.cookie, response.headers.getSetCookie());
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as { code?: string };
      throw new Error(`http_${response.status}:${payload.code ?? "request_failed"}`);
    }
    return response;
  }

  async function json(session: Session, path: string, method = "GET", body?: unknown, billable = true) {
    return (await request(session, path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, billable)).json();
  }

  async function settle(session: Session) {
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      if (!(await charges(session)).inFlightReserveCny) return;
      await pause(750);
    }
    throw new Error("background_settle_timeout");
  }

  async function initialize(): Promise<Session> {
    const session: Session = { cookie: "", userId: "", conversationId: "", turns: [], checks: [] };
    active = session;
    const landing = await request(session, "/", {}, false);
    await landing.body?.cancel();
    const bootstrap = await json(session, "/api/bootstrap");
    session.userId = String(bootstrap.user.id);
    if (!(await getPool().query("SELECT id FROM users WHERE id=$1 AND NOT onboarding_complete", [session.userId])).rowCount) throw new Error("web_database_identity_mismatch");
    if (["scripted", "replay", "fault"].includes(bootstrap.adapter)) throw new Error("real_provider_required");
    let question = bootstrap.onboarding.question;
    for (const answer of ["我是一名大学生", "暂时还没有明确想说的事情", "先自然聊天就好"]) {
      const result = await json(session, "/api/onboarding/answer", "POST", { questionId: question.id, answer });
      question = result.question;
    }
    const result = await json(session, "/api/onboarding/complete", "POST", {});
    session.conversationId = String(result.conversationId);
    await settle(session);
    return session;
  }

  async function send(session: Session, content: string): Promise<void> {
    const started = Date.now();
    const turn: CompanionTurn = { input: content, output: "", startedAt: new Date(started).toISOString(), deltaCount: 0, terminal: "missing", sources: [], chunks: [], stages: [] };
    session.turns.push(turn);
    const response = await request(session, `/api/conversations/${session.conversationId}/messages`, {
      method: "POST", body: JSON.stringify({ content, clientRequestId: randomUUID() }),
    });
    if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) throw new Error("expected_sse");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    try {
      for (;;) {
        const chunk = await reader.read();
        buffered += decoder.decode(chunk.value, { stream: !chunk.done });
        const frames = buffered.split(/\r?\n\r?\n/u);
        buffered = frames.pop()!;
        if (chunk.done && buffered.trim()) { frames.push(buffered); buffered = ""; }
        for (const frame of frames) {
          const event = parseSseFrame(frame);
          if (event) recordCompanionEvent(turn, event, Date.now() - started);
        }
        if (chunk.done) break;
      }
    } finally { reader.releaseLock(); }
    session.checks.push({ name: `第${session.turns.length}轮正常完成`, passed: turn.terminal === "completed", detail: { terminal: turn.terminal } });
    session.checks.push({ name: `第${session.turns.length}轮真流式`, passed: hasExpectedTextDelivery(turn), detail: { deltaCount: turn.deltaCount, firstDeltaMs: turn.firstDeltaMs, completedMs: turn.completedMs } });
  }

  try {
    await getPool().query("SELECT 1");
    for (const scenario of scenarios) {
      await guardBudget();
      let error: string | null = null;
      try {
        const session = await initialize();
        for (const content of scenario.messages) { await send(session, content); await settle(session); }
      } catch (cause) { error = safeCompanionError(cause); }
      finally {
        const session = active as Session | null;
        if (session?.userId) {
          await settle(session).catch((cause) => { error ??= safeCompanionError(cause); });
          const current = await charges(session);
          const [modelUsage, traces] = await Promise.all([
            getPool().query(`SELECT trace_id AS "traceId",role AS task,model_name AS model,input_tokens AS "inputTokens",output_tokens AS "outputTokens",
              cached_input_tokens AS "cachedInputTokens",reasoning_tokens AS "reasoningTokens",search_calls AS "searchCalls",
              estimated_cost_cny::float AS "estimatedCostCny",usage_reported AS "usageReported",first_token_ms AS "providerFirstTokenMs",
              first_delta_ms AS "firstDeltaMs",duration_ms AS "durationMs",finish_reason AS "finishReason",attempts,created_at AS "createdAt"
              FROM model_runs WHERE user_id=$1 ORDER BY created_at,id`, [session.userId]),
            getPool().query(`SELECT trace_id AS "traceId",stage,payload,created_at AS "createdAt" FROM trace_events WHERE user_id=$1
              AND (stage LIKE 'dialogue.%' OR stage LIKE 'fact.%' OR stage LIKE 'science.%') ORDER BY created_at,id`, [session.userId]),
          ]);
          for (const [index, turn] of session.turns.entries()) session.checks.push({ name: `第${index + 1}轮保留实际请求Prompt`,
            passed: traces.rows.some((trace) => trace.stage === "dialogue.request" && trace.traceId === turn.traceId), detail: { traceId: turn.traceId } });
          settledCharges = { costCny: settledCharges.costCny + current.costCny, unknownCalls: settledCharges.unknownCalls + current.unknownCalls,
            inFlightReserveCny: settledCharges.inFlightReserveCny + current.inFlightReserveCny };
          const report = { id: scenario.id, name: scenario.name, mode: scenario.mode, reviewFocus: scenario.reviewFocus,
            turns: session.turns.map((turn) => ({ ...turn, diagnostics: companionLengthDiagnostic(turn.output) })), checks: session.checks,
            modelUsage: modelUsage.rows, traces: traces.rows, usageBasedEstimatedCostCny: current.costCny, unreportedUsageCalls: current.unknownCalls, error };
          reports.push(report);
          try {
            await json(session, "/api/user/data", "DELETE", { confirmation: "删除知微中的全部数据" }, false);
            const cleaned = !(await getPool().query("SELECT id FROM users WHERE id=$1", [session.userId])).rowCount;
            session.checks.push({ name: "本组测试用户已清理", passed: cleaned });
            if (!cleaned) error ??= "test_user_cleanup_failed";
          } catch { error ??= "test_user_cleanup_failed"; }
          report.error = error;
          active = null;
        }
      }
      process.stdout.write(JSON.stringify({ scenario: scenario.id, completedScenarios: reports.length, costCny: settledCharges.costCny,
        conservativeCumulativeCny: budget.alreadySpentCny + conservativeCompanionCost(settledCharges), error }) + "\n");
      if (error) { stoppedReason = error; break; }
    }
  } catch (cause) { stoppedReason = safeCompanionError(cause); }
  finally {
    const report = { schemaVersion: "companion-real-v1", liveModel: true, syntheticOnly: true, qualityIsManualReview: true,
      startedAt: startedAt.toISOString(), completedAt: new Date().toISOString(), budget,
      usageBasedEstimatedCostCny: settledCharges.costCny, unreportedUsageCalls: settledCharges.unknownCalls,
      unknownUsageReserveCny: settledCharges.unknownCalls * 0.25, unsettledReserveCny: settledCharges.inFlightReserveCny,
      conservativeCumulativeCny: budget.alreadySpentCny + conservativeCompanionCost(settledCharges),
      costNotice: "费用按真实usage估算，不等同于阿里云账单；未返回usage及未完成调用另留保守预算。",
      separatelyRequiredScenario: companionScenarios.find((scenario) => scenario.mode !== "web"), stoppedReason, scenarios: reports };
    await mkdir(fileURLToPath(new URL("../../../reports/", import.meta.url)), { recursive: true });
    await writeFile(outputPath, JSON.stringify(redactExperienceReport(report), null, 2) + "\n", { flag: "wx" });
    await closePool();
    if (previousDatabase === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previousDatabase;
    process.stdout.write(JSON.stringify({ reportPath: outputPath, completedScenarios: reports.length, usageBasedEstimatedCostCny: settledCharges.costCny,
      conservativeCumulativeCny: budget.alreadySpentCny + conservativeCompanionCost(settledCharges), stoppedReason }) + "\n");
    if (stoppedReason || reports.some((report) => (report.checks as Check[]).some((check) => !check.passed))) process.exitCode = 1;
  }
}

function safeCompanionError(error: unknown): string {
  if (error instanceof Error && /^[a-z_0-9:]+$/u.test(error.message)) return error.message;
  return error instanceof Error && error.name === "TimeoutError" ? "request_timeout" : "run_failed";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCompanionReal().catch((error) => { process.stderr.write(`${safeCompanionError(error)}\n`); process.exitCode = 1; });
}
