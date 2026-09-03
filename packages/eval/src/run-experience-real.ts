import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { closePool, getPool } from "@zhiwei/core";

type Check = { name: string; passed: boolean; detail?: unknown };
type Turn = { input: string; output: string; assistantId?: string; userMessageId?: string; firstDeltaMs?: number; completedMs?: number; deltaCount: number; stopped: boolean; terminal: string; sources: Array<{ title: string; url: string }> };
type Scenario = { id: string; name: string; messages: string[]; stopAt?: number; retryAt?: number; emotionOff?: boolean };
type State = { memories: Array<{ memoryId: string; content: string; category: string; tier: string }>; counts: Record<string, number>; userMessages: number; reflectionJobs: number; titleJobs: number; score: number | null; jobs: Array<{ type: string; status: string; sourceIds: string[]; sealed: boolean; runAfter: string }> };
type Session = { index: number; cookie: string; userId: string; conversationId: string; checks: Check[]; turns: Turn[]; onboardingLatencyMs: number[] };

export const experienceScenarios: Scenario[] = [
  { id: "vague-to-specific", name: "模糊烦恼不派生，购物细化保留单根", messages: ["最近有点烦", "生活琐事让我烦", "也说不清具体是什么，就是有点烦", "主要是上周买的鞋鞋底开胶，商家拒绝退货", "为了这双鞋的退货，我已经和客服沟通三次，还是没有结果", "我现在只是为同一笔买鞋退货的事情烦恼"] },
  { id: "independent-events", name: "独立问题分别保留", messages: ["我的实验报告周五要交，数据还没整理完", "另一件事是室友晚上打游戏，我睡不好", "实验报告和室友夜间游戏是两件独立的事，我想分开梳理"] },
  { id: "retry", name: "最新重生成复用用户证据", retryAt: 2, messages: ["这周的毕业论文进度让我焦虑", "主要担心文献综述写得没有重点", "我想先说明卡在哪，再一起梳理"] },
  { id: "stop", name: "停止保留部分正文与用户批次", stopAt: 0, messages: ["我最近一上课头就晕，又害怕大学物理跟不上。请详细陪我梳理这两层担心", "我最担心的是头晕让我漏掉推导过程", "明天会去校医院看看，课程方面想先补这一章"] },
  { id: "three-turn-batch", name: "三轮合批不逐句反思", messages: ["我下周第一次做组会汇报", "最担心老师突然问到我没查清楚的数据", "我想先把知道和不知道的边界说明白"] },
  { id: "withdraw-relearn", name: "未入库时忘记，后续新证据重新学习", messages: ["我准备去上海找工作", "请忘掉刚才上海找工作的事情，之后别再提它", "请重新记住，我现在已经确定会去上海找工作"] },
  { id: "sources", name: "科学事实与可打开的来源", messages: ["太阳耀斑为什么会影响短波通信？请核实事实并给出来源", "我主要想分清电磁辐射和高能粒子的影响是不是一回事", "请用高中物理基础能理解的方式说明类比的边界"] },
  { id: "emotion-off", name: "关闭情绪记录不影响具体事项", emotionOff: true, messages: ["明天要汇报实验结果，我非常紧张", "担心一紧张就忘记说明实验的误差范围", "准备今晚把误差这一页再练两遍"] },
  { id: "exception", name: "临时例外不改写长期偏好", messages: ["请记住，我做重要决定通常喜欢先收集足够信息", "今晚这件小事我想凭直觉定，因为一小时后就截止", "这只是今晚时间紧的一次例外，不代表我的长期决策习惯改变"] },
  { id: "personal-style", name: "具体偏好与慢增长", messages: ["请记住，我希望回复可以具体一点，不要每句话都追问", "我说学习上的烦恼时，希望先理解我卡在哪，而不是马上列清单", "我最近在读电磁学教材，具体卡在高斯定律适用的对称条件"] },
];

export function realExperienceBudget(raw = "5"): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error("REAL_TEST_BUDGET_CNY 必须为正数。");
  return Math.min(5, value);
}

/** Node fetch does not maintain a cookie jar; keep only response cookie name/value pairs. */
export function mergeCookieJar(current: string, setCookies: string[]): string {
  const values = new Map(current.split(/;\s*/u).filter(Boolean).map((part) => {
    const split = part.indexOf("="); return [part.slice(0, split), part.slice(split + 1)];
  }));
  for (const cookie of setCookies) {
    const pair = cookie.split(";", 1)[0]!;
    const split = pair.indexOf("=");
    if (split > 0) values.set(pair.slice(0, split), pair.slice(split + 1));
  }
  return [...values].map(([key, value]) => `${key}=${value}`).join("; ");
}

export function parseSseFrame(frame: string): Record<string, any> | null {
  const data = frame.split(/\r?\n/u).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
  return data ? JSON.parse(data) : null;
}

export function redactExperienceReport<T>(value: T): T {
  const aliases = new Map<string, string>();
  const sanitize = (entry: unknown): unknown => {
    if (typeof entry === "string") return entry
      .replace(/\bsk-[A-Za-z0-9._-]+/gu, "[已移除密钥]")
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu, (id) => {
        if (!aliases.has(id)) aliases.set(id, `record-${aliases.size + 1}`);
        return aliases.get(id)!;
      });
    if (Array.isArray(entry)) return entry.map(sanitize);
    if (entry && typeof entry === "object") return Object.fromEntries(Object.entries(entry)
      .filter(([key]) => !/cookie|authorization|api.?key|secret|reasoning_content/iu.test(key)).map(([key, item]) => [key, sanitize(item)]));
    return entry;
  };
  return sanitize(value) as T;
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runExperienceReal(): Promise<void> {
  if (process.env.ALLOW_PAID_MODEL_TESTS !== "true") throw new Error("真实验收默认关闭；需要 ALLOW_PAID_MODEL_TESTS=true。");
  const budget = realExperienceBudget(process.env.REAL_TEST_BUDGET_CNY);
  if (!process.env.EXPERIENCE_BASE_URL || !process.env.INTEGRATION_DATABASE_URL) throw new Error("请提供临时 Web 地址与独立测试数据库。");
  const base = new URL(process.env.EXPERIENCE_BASE_URL);
  const database = new URL(process.env.INTEGRATION_DATABASE_URL);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) || !base.port || base.port === "3000") throw new Error("真实验收只连接独立端口的本机测试服务，不使用主站 3000。");
  if (!/test/iu.test(database.pathname)) throw new Error("真实验收必须使用库名含 test 的独立数据库。");
  await closePool();
  const originalDatabase = process.env.DATABASE_URL;
  process.env.DATABASE_URL = database.toString();
  const startedAt = new Date().toISOString();
  const requestedScenarios=process.env.EXPERIENCE_SCENARIOS?.split(",").filter(Boolean);
  const scenarios=requestedScenarios?.length ? experienceScenarios.filter(scenario=>requestedScenarios.includes(scenario.id)) : experienceScenarios;
  if(!scenarios.length)throw new Error("unknown_scenario");
  const reports: Array<Record<string, unknown>> = [];
  let settledCost = 0;
  let settledUnknownCalls = 0;
  let active: Session | null = null;
  let stoppedReason: string | null = null;

  async function charges(session: Session | null) {
    if (!session?.userId) return { cost: 0, unknown: 0, inFlight: 0 };
    const result = await getPool().query(`SELECT
      COALESCE((SELECT sum(estimated_cost_cny) FROM model_runs WHERE user_id=$1),0)::float AS cost,
      (SELECT count(*) FROM model_runs WHERE user_id=$1 AND NOT usage_reported)::int AS unknown,
      (SELECT count(*) FROM jobs WHERE user_id=$1 AND status IN ('pending','running')
        AND NOT (type='reflection' AND status='pending' AND payload->>'sealed'='false' AND run_after>now()))::int AS jobs,
      (SELECT count(*) FROM messages WHERE user_id=$1 AND role='assistant' AND metadata->>'status'='streaming')::int AS streams`, [session.userId]);
    const row = result.rows[0];
    return { cost: Number(row.cost), unknown: Number(row.unknown), inFlight: Number(row.jobs) * 0.15 + Number(row.streams) * 0.25 };
  }

  async function guardBudget(nextRequestReserve = 0.45) {
    const current = await charges(active);
    const committed = settledCost + current.cost + (settledUnknownCalls + current.unknown) * 0.25 + current.inFlight;
    if (committed + nextRequestReserve > budget) throw new Error("budget_reserve_reached");
  }

  async function request(session: Session, path: string, init: RequestInit = {}, billable = true): Promise<Response> {
    if (billable) await guardBudget();
    const response = await fetch(new URL(path, base), {
      ...init, signal: init.signal ?? AbortSignal.timeout(120_000),
      headers: { "content-type": "application/json", ...(session.cookie ? { cookie: session.cookie } : {}), ...init.headers },
    });
    session.cookie = mergeCookieJar(session.cookie, response.headers.getSetCookie());
    if (!response.ok) {
      const error = await response.json().catch(() => ({})) as { code?: string };
      throw new Error(`http_${response.status}:${error.code ?? "request_failed"}`);
    }
    return response;
  }

  async function json(session: Session, path: string, method = "GET", body?: unknown, billable = true): Promise<any> {
    return (await request(session, path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, billable)).json();
  }

  function check(session: Session, name: string, passed: boolean, detail?: unknown) {
    session.checks.push({ name, passed, ...(detail === undefined ? {} : { detail }) });
  }

  async function settled(session: Session, timeoutMs = 180_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const count = await charges(session);
      if (!count.inFlight) return;
      await pause(750);
    }
    throw new Error("background_settle_timeout");
  }

  async function state(session: Session): Promise<State> {
    const [memories, counts, jobs] = await Promise.all([
      getPool().query(`SELECT memory_id AS "memoryId",content,category,tier FROM memory_versions WHERE user_id=$1 AND is_active AND status='active' ORDER BY created_at,id`, [session.userId]),
      getPool().query(`SELECT
        (SELECT count(*) FROM memory_versions WHERE user_id=$1)::int AS memories,
        (SELECT count(*) FROM mood_samples WHERE user_id=$1)::int AS moods,
        (SELECT count(*) FROM profile_snapshots WHERE user_id=$1)::int AS profiles,
        (SELECT count(*) FROM conversation_summaries WHERE user_id=$1)::int AS summaries,
        (SELECT count(*) FROM return_notes WHERE user_id=$1)::int AS returns,
        (SELECT count(*) FROM personal_skill_versions WHERE user_id=$1)::int AS skills,
        (SELECT count(*) FROM messages WHERE user_id=$1 AND role='user')::int AS users,
        (SELECT count(*) FROM jobs WHERE user_id=$1 AND type='reflection')::int AS reflections,
        (SELECT count(*) FROM jobs WHERE user_id=$1 AND type='conversation_title')::int AS titles,
        (SELECT understanding_score FROM profile_snapshots WHERE user_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1) AS score`, [session.userId]),
      getPool().query(`SELECT type,status,payload->'sourceMessageIds' AS "sourceIds",COALESCE((payload->>'sealed')::boolean,false) AS sealed,run_after AS "runAfter" FROM jobs WHERE user_id=$1 AND payload->>'conversationId'=$2 ORDER BY created_at,id`, [session.userId, session.conversationId]),
    ]);
    const row = counts.rows[0];
    return { memories: memories.rows, counts: { memories: row.memories, moods: row.moods, profiles: row.profiles, summaries: row.summaries, returns: row.returns, skills: row.skills }, userMessages: row.users, reflectionJobs: row.reflections, titleJobs: row.titles, score: row.score, jobs: jobs.rows };
  }

  async function send(session: Session, content: string, options: { stop?: boolean; retryId?: string } = {}): Promise<Turn> {
    const started = Date.now();
    const controller = new AbortController();
    const turn: Turn = { input: content, output: "", deltaCount: 0, stopped: false, terminal: "missing", sources: [] };
    const path = `/api/conversations/${session.conversationId}/messages${options.retryId ? `/${options.retryId}/retry` : ""}`;
    const response = await request(session, path, {
      method: "POST", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(180_000)]),
      body: JSON.stringify(options.retryId ? {} : { content, clientRequestId: crypto.randomUUID() }),
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
        for (const frame of frames) {
          const event = parseSseFrame(frame);
          if (event?.type === "message.started") { turn.assistantId = event.messageId; turn.userMessageId = event.userMessage?.id; }
          if (event?.type === "text.delta") {
            turn.firstDeltaMs ??= Date.now() - started;
            turn.deltaCount += 1; turn.output += String(event.delta ?? "");
          }
          if (event?.type === "message.completed") { turn.terminal = "completed"; turn.completedMs = Date.now() - started; turn.sources = event.sources ?? []; }
          if (event?.type === "error") turn.terminal = String(event.code ?? "error");
          if (options.stop && turn.output.length >= 24) {
            turn.stopped = true; turn.terminal = "client_stopped";
            controller.abort(); await reader.cancel().catch(() => undefined); return turn;
          }
        }
        if (chunk.done) break;
      }
      return turn;
    } finally { reader.releaseLock(); }
  }

  async function initialize(index: number): Promise<Session> {
    const session: Session = { index, cookie: "", userId: "", conversationId: "", checks: [], turns: [], onboardingLatencyMs: [] };
    active = session;
    // Match the browser flow: the landing response establishes the HttpOnly identity.
    const landing=await request(session,"/",{},false);
    await landing.body?.cancel();
    const bootstrap = await json(session, "/api/bootstrap");
    session.userId = bootstrap.user.id;
    const matching = await getPool().query(`SELECT id FROM users WHERE id=$1 AND NOT onboarding_complete`, [session.userId]);
    if (!matching.rowCount) throw new Error("web_database_identity_mismatch");
    if (["scripted", "replay", "fault"].includes(bootstrap.adapter)) throw new Error("real_provider_required");
    const questions = ["current-stage", "current-focus", "conversation-style"];
    const answers = ["我是一名大学生", "暂时还没有明确想说的事情", "先自然聊天就好"];
    let question = bootstrap.onboarding.question;
    for (let step = 0; step < 3; step += 1) {
      check(session, `通用初识第${step + 1}题`, question?.id === questions[step]);
      const started = Date.now();
      const result = await json(session, "/api/onboarding/answer", "POST", { questionId: question.id, answer: answers[step] });
      session.onboardingLatencyMs.push(Date.now() - started); question = result.question;
    }
    const complete = await json(session, "/api/onboarding/complete", "POST", {});
    session.conversationId = complete.conversationId;
    await settled(session);
    return session;
  }

  try {
    await getPool().query("SELECT 1");
    for (const [index, scenario] of scenarios.entries()) {
      await guardBudget();
      let session: Session | null = null;
      let baseline: State | null = null;
      let final: State | null = null;
      let groupError: string | null = null;
      try {
        session = await initialize(index + 1);
        if (scenario.emotionOff) await json(session, "/api/settings", "PATCH", { emotionTrackingEnabled: false });
        await settled(session); baseline = await state(session);
        for (const [turnIndex, content] of scenario.messages.entries()) {
          const turn = await send(session, content, { stop: scenario.stopAt === turnIndex });
          session.turns.push(turn);
          await settled(session);
          const snapshot = await state(session);
          check(session, `第${turnIndex + 1}轮终态`, turn.stopped || turn.terminal === "completed", { terminal: turn.terminal });
          if(/记住|记错|忘掉|忘记|不再引用|修正/u.test(content)) check(session,"记忆控制指令不提前宣称完成",!/(?:已经|我已|已替你|已为你|这就).{0,12}(?:记住|忘掉|忘记|撤回|更新|修正)|(?:记住|忘掉|忘记|撤回|更新|修正)(?:好了|了)/u.test(turn.output),{output:turn.output});
          if (!turn.stopped) check(session, `第${turnIndex + 1}轮增量输出`, turn.deltaCount >= 2 && turn.firstDeltaMs !== undefined && turn.completedMs !== undefined && turn.firstDeltaMs <= turn.completedMs, { deltas: turn.deltaCount, firstDeltaMs: turn.firstDeltaMs, completedMs: turn.completedMs });
          if (scenario.id === "vague-to-specific" && turnIndex === 2) check(session, "三条模糊烦恼不生成衍生记录", JSON.stringify(snapshot.counts) === JSON.stringify(baseline.counts), { before: baseline.counts, after: snapshot.counts });
          if (scenario.id === "three-turn-batch") {
            const batch = snapshot.jobs.find((job) => job.type === "reflection");
            check(session, `第${turnIndex + 1}条批次长度`, batch?.sourceIds?.length === turnIndex + 1, batch);
            check(session, `第${turnIndex + 1}条调度状态`, turnIndex < 2 ? batch?.status === "pending" && !batch.sealed && new Date(batch.runAfter).getTime() > Date.now() : batch?.status === "completed" && batch.sealed, batch);
          }
          if (scenario.id === "withdraw-relearn" && turnIndex === 1) check(session, "积压证据忘记后不复活", snapshot.memories.every((memory) => !/上海/u.test(memory.content)));
          if (turn.stopped) {
            const stored = await getPool().query(`SELECT content,metadata FROM messages WHERE id=$1 AND user_id=$2`, [turn.assistantId, session.userId]);
            check(session, "停止保留部分正文", Boolean(stored.rows[0]?.content) && stored.rows[0]?.metadata.status === "stopped");
          }
          if (scenario.retryAt === turnIndex) {
            const retry = await send(session, content, { retryId: turn.assistantId }); session.turns.push(retry);
            await settled(session); const retried = await state(session);
            check(session, "重生成不重复用户证据或Reflection/标题任务", snapshot.userMessages === retried.userMessages && snapshot.reflectionJobs === retried.reflectionJobs && snapshot.titleJobs === retried.titleJobs);
            check(session, "重生成新尝试复用源消息", retry.userMessageId === turn.userMessageId && retry.assistantId !== turn.assistantId && retry.terminal === "completed");
          }
        }
        final = await state(session);
        if (scenario.id === "vague-to-specific") check(session, "同一购物问题只有一个活动根", final.memories.filter((memory) => /鞋|退货|购物/u.test(memory.content)).length === 1, final.memories);
        if (scenario.id === "independent-events") check(session, "实验报告和室友问题分别记录", final.memories.some((memory) => /实验报告/u.test(memory.content)) && final.memories.some((memory) => /室友/u.test(memory.content)), final.memories);
        if (scenario.id === "withdraw-relearn") check(session, "后来的明确新证据允许重学", final.memories.some((memory) => /上海/u.test(memory.content)), final.memories);
        if (scenario.emotionOff) check(session, "关闭情绪后无新情绪样本或情绪记忆", final.counts.moods === baseline.counts.moods && !final.memories.some((memory) => memory.category === "emotion"));
        if (scenario.id === "exception") check(session, "临时例外没有替代长期信息收集习惯", final.memories.some((memory) => memory.tier === "long" && /收集|信息/u.test(memory.content)), final.memories);
        if (scenario.id === "sources") {
          const source = session.turns.flatMap((turn) => turn.sources).find((item) => /^https:\/\//u.test(item.url));
          check(session, "事实回答携带真实来源", Boolean(source));
          if (source) {
            const reachable = await fetch(source.url, { method: "GET", signal: AbortSignal.timeout(15_000) }).then(async (response) => { await response.body?.cancel(); return response.ok; }).catch(() => false);
            check(session, "来源可以打开", reachable, { url: source.url });
          }
        }
        check(session, "单次会话了解度不过快增长", final.score === null || final.score <= 25, { score: final.score });
        const failures = await getPool().query(`SELECT type,last_error FROM jobs WHERE user_id=$1 AND status='failed'`, [session.userId]);
        check(session, "立即后台任务无技术失败", failures.rows.length === 0, failures.rows.map((job) => ({ type: job.type })));
      } catch (error) { groupError = safeRunError(error); }
      finally {
        session ??= active;
        if (session?.userId) {
          await settled(session).catch((error) => { groupError ??= safeRunError(error); });
          const current = await charges(session);
          const usage = await getPool().query(`SELECT role AS task,model_name AS model,count(*)::int AS calls,
            sum(input_tokens)::int AS "inputTokens",sum(output_tokens)::int AS "outputTokens",
            sum(cached_input_tokens)::int AS "cachedInputTokens",sum(reasoning_tokens)::int AS "reasoningTokens",
            sum(search_calls)::int AS "searchCalls",sum(estimated_cost_cny)::float AS "estimatedCostCny",
            count(*) FILTER(WHERE NOT usage_reported)::int AS "unreportedCalls",
            avg(first_token_ms)::float AS "averageProviderFirstTokenMs",avg(first_delta_ms)::float AS "averageFirstDeltaMs",
            avg(duration_ms)::float AS "averageDurationMs"
            FROM model_runs WHERE user_id=$1 GROUP BY role,model_name ORDER BY role,model_name`, [session.userId]);
          settledCost += current.cost; settledUnknownCalls += current.unknown;
          reports.push({ id: scenario.id, name: scenario.name, syntheticUser: `用户${index + 1}`, onboardingLatencyMs: session.onboardingLatencyMs, turns: session.turns, checks: session.checks, baseline, final, modelUsage: usage.rows, usageBasedEstimatedCostCny: current.cost, unreportedUsageCalls: current.unknown, error: groupError });
          await json(session, "/api/user/data", "DELETE", { confirmation: "删除知微中的全部数据" }, false);
          check(session, "测试用户已清理", !(await getPool().query(`SELECT id FROM users WHERE id=$1`, [session.userId])).rowCount);
          active = null;
        }
      }
      process.stdout.write(JSON.stringify({ scenario: scenario.id, checks: session?.checks.length ?? 0, failedChecks: session?.checks.filter((item) => !item.passed).length ?? 0, costCny: settledCost, unknownUsageReserveCny: settledUnknownCalls * 0.25, error: groupError }) + "\n");
      if (groupError) { stoppedReason = groupError; break; }
    }
  } catch (error) { stoppedReason = safeRunError(error); }
  finally {
    const reportName=requestedScenarios?.length?"experience-real-targeted.json":"experience-real.json";
    const outputPath = fileURLToPath(new URL(`../../../reports/${reportName}`, import.meta.url));
    await mkdir(fileURLToPath(new URL("../../../reports/", import.meta.url)), { recursive: true });
    const report = { schemaVersion: "experience-real-v1", liveModel: true, syntheticOnly: true, startedAt, completedAt: new Date().toISOString(), budgetCny: budget,
      usageBasedEstimatedCostCny: settledCost, unreportedUsageCalls: settledUnknownCalls, unknownUsageReserveCny: settledUnknownCalls * 0.25,
      costNotice: "按真实usage估算，非阿里云账单；缺失usage的调用另留保守预算。", stoppedReason, scenarios: reports };
    await writeFile(outputPath, JSON.stringify(redactExperienceReport(report), null, 2) + "\n");
    await closePool();
    if (originalDatabase === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = originalDatabase;
    process.stdout.write(JSON.stringify({ completedScenarios: reports.length, costCny: settledCost, unknownUsageReserveCny: settledUnknownCalls * 0.25, stoppedReason }) + "\n");
    if (stoppedReason || reports.some((report) => (report.checks as Check[]).some((item) => !item.passed))) process.exitCode = 1;
  }
}

function safeRunError(error: unknown): string {
  const message = error instanceof Error ? error.message : "unknown_failure";
  return /^[a-z_0-9:]+$/u.test(message) ? message : error instanceof Error && error.name === "TimeoutError" ? "request_timeout" : "run_failed";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runExperienceReal().catch((error) => { process.stderr.write(`${safeRunError(error)}\n`); process.exitCode = 1; });
}
