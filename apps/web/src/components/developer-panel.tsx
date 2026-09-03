"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, CheckCircle2, Clock3, Coins, Database, FlaskConical, GitBranch, RefreshCw, ScrollText, ShieldCheck, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { categoryLabel } from "@zhiwei/core/client";

type DeveloperData = {
  traces: any[];
  memories: any[];
  profiles: any[];
  skills: any[];
  mcpCalls: any[];
  modelRuns: any[];
  foundationSkills: any[];
  competition: { runs: any[]; risks: any[]; withdrawals: any[]; conversations: any[] };
};

type ModelCostData = {
  totals: {
    total_cost: number | string;
    input_tokens: number | string;
    output_tokens: number | string;
    cached_input_tokens: number | string;
    reasoning_tokens: number | string;
    search_calls: number | string;
  };
  runs: any[];
  pricing: any[];
  searchPricing: { turboPerCallCny: number; maxPerCallCny: number };
  disclaimer: string;
};

const taskLabels: Record<string, string> = {
  dialogue: "陪伴回复",
  reflection: "对话反思",
  "skill-evolution": "个人技能演化",
  "question-planner": "访谈问题规划",
  "return-note": "温和回访",
  "conversation-title": "对话标题",
  "profile-synthesis": "画像整理",
  "session-summary": "会话摘要",
  "fact-routing": "事实核验判断",
  "fact-brief": "事实简报",
  embedding: "记忆向量",
};

const statusLabels: Record<string, string> = {
  running: "进行中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已停止",
};

function numberValue(value: number | string | null | undefined) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatTokens(value: number | string | null | undefined) {
  return new Intl.NumberFormat("zh-CN").format(numberValue(value));
}

function formatCost(value: number | string | null | undefined) {
  return `¥${numberValue(value).toFixed(6)}`;
}

function memoryStatus(memory: any) {
  if (memory.status === "withdrawn") return { className: "status-withdrawn", label: "已撤回" };
  if (memory.status === "pending") return { className: "status-pending", label: "待确认" };
  if (memory.is_active || memory.status === "active") return { className: "status-active", label: "当前" };
  return { className: "status-old", label: "已替代" };
}

export function DeveloperPanel({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<"trace" | "memory" | "skills" | "competition" | "costs">("trace");
  const [data, setData] = useState<DeveloperData | null>(null);
  const [costData, setCostData] = useState<ModelCostData | null>(null);
  const [costError, setCostError] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [labPrompt, setLabPrompt] = useState("请为高中生写一段关于太阳耀斑与空间天气的课程讲稿开场，要求准确、自然，不要模板腔。");
  const [labRunning, setLabRunning] = useState(false);

  async function load() {
    const [dataResponse, costResponse] = await Promise.all([
      fetch("/api/dev/data", { cache: "no-store" }),
      fetch("/api/dev/model-costs", { cache: "no-store" }),
    ]);
    if (dataResponse.ok) setData(await dataResponse.json());
    if (costResponse.ok) {
      setCostData(await costResponse.json());
      setCostError("");
    } else {
      const payload = await costResponse.json().catch(() => null);
      setCostError(payload?.error ?? "模型费用记录暂时无法读取，请稍后重试。");
    }
  }
  useEffect(() => { void load(); }, []);

  async function runLab() {
    setLabRunning(true);
    try {
      await fetch("/api/dev/competition/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: labPrompt, scenario: "太阳耀斑课程讲稿" }),
      });
      await load();
    } finally {
      setLabRunning(false);
    }
  }

  async function prefer(runId: string, preferredMode: string) {
    await fetch("/api/dev/competition/preference", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId, preferredMode }),
    });
    await load();
  }

  const groupedTraces = useMemo(() => {
    const groups = new Map<string, any[]>();
    for (const trace of data?.traces ?? []) {
      const list = groups.get(trace.trace_id) ?? [];
      list.push(trace);
      groups.set(trace.trace_id, list);
    }
    return [...groups.entries()];
  }, [data]);

  return (
    <div className="developer-shell">
      <header className="developer-header">
        <button className="back-button" onClick={onClose}><ArrowLeft size={18} /> 返回知微</button>
        <div><strong>开发者模式</strong><span>当前匿名档案 · 只读证据视图</span></div>
        <Button variant="ghost" size="sm" onClick={() => void load()}><RefreshCw size={15} /> 刷新</Button>
      </header>
      <nav className="developer-tabs">
        <button className={tab === "trace" ? "active" : ""} onClick={() => setTab("trace")}><ScrollText size={17} />运行追踪（Trace）</button>
        <button className={tab === "memory" ? "active" : ""} onClick={() => setTab("memory")}><Database size={17} />记忆与画像</button>
        <button className={tab === "skills" ? "active" : ""} onClick={() => setTab("skills")}><GitBranch size={17} />个人技能演化</button>
        <button className={tab === "competition" ? "active" : ""} onClick={() => setTab("competition")}><FlaskConical size={17} />比赛实验室</button>
        <button className={tab === "costs" ? "active" : ""} onClick={() => setTab("costs")}><Coins size={17} />模型与费用</button>
      </nav>
      <main className="developer-content">
        {!data ? <div className="loading-state">正在读取运行证据…</div> : null}
        {data && tab === "trace" ? (
          <section>
            <div className="dev-section-heading"><div><h1>每一次回答是怎么产生的</h1><p>先看阶段、耗时与版本；需要时再展开完整上下文和模型输出。</p></div><span>{data.traces.length} 个事件</span></div>
            <div className="trace-list">
              {groupedTraces.map(([traceId, events]) => (
                <article className="trace-card" key={traceId}>
                  <header><div><CheckCircle2 size={17} /><strong>{traceId.slice(0, 18)}</strong></div><span>{events.length} 个阶段</span></header>
                  <div className="trace-timeline">
                    {events.map((event) => (
                      <button key={event.id} onClick={() => setExpanded(expanded === event.id ? null : event.id)}>
                        <i />
                        <span><strong>{event.stage}</strong><small><Clock3 size={12} />{event.duration_ms ?? 0} 毫秒 · {new Date(event.created_at).toLocaleTimeString("zh-CN")}</small></span>
                        {expanded === event.id ? <pre>{JSON.stringify(event.payload, null, 2)}</pre> : null}
                      </button>
                    ))}
                  </div>
                </article>
              ))}
            </div>
            {data.mcpCalls.length ? <details className="mcp-log"><summary>记忆 MCP 调用（{data.mcpCalls.length}）</summary><pre>{JSON.stringify(data.mcpCalls, null, 2)}</pre></details> : null}
            {data.modelRuns.length ? <details className="mcp-log"><summary>模型运行与预算（{data.modelRuns.length}）</summary><pre>{JSON.stringify(data.modelRuns, null, 2)}</pre></details> : null}
          </section>
        ) : null}
        {data && tab === "memory" ? (
          <section>
            <div className="dev-section-heading"><div><h1>证据如何变成理解</h1><p>用户界面保持自然，这里保留证据来源、版本、置信度和了解度计算。</p></div><span>{data.memories.length} 个版本</span></div>
            <div className="dev-grid">
              <div className="dev-column"><h2>记忆版本</h2>{data.memories.map((memory) => { const state = memoryStatus(memory); return <article className="data-card" key={memory.id}><header><span className={state.className}>{state.label}</span><small>{memory.tier === "long" ? "长期" : "短期"} · {categoryLabel(memory.category)}</small></header><p>{memory.content}</p><footer>置信度 {Number(memory.confidence).toFixed(2)} · 证据 {memory.evidence_ids?.length ?? 0} 条</footer><details><summary>查看原始记录</summary><pre>{JSON.stringify(memory, null, 2)}</pre></details></article>; })}</div>
              <div className="dev-column"><h2>画像快照</h2>{data.profiles.map((profile) => <article className="data-card" key={profile.id}><header><strong>{profile.understanding_score}%</strong><small>{new Date(profile.created_at).toLocaleString("zh-CN")}</small></header><p>{profile.summary}</p><pre>{JSON.stringify({ weights: profile.dimension_weights, components: profile.understanding_components }, null, 2)}</pre></article>)}</div>
            </div>
          </section>
        ) : null}
        {data && tab === "skills" ? (
          <section>
            <div className="dev-section-heading"><div><h1>固定能力与个体演化</h1><p>基底技能只读并带哈希；个人技能每次重写完整对象，旧版永久保留。</p></div><span>{data.skills.length} 个个人版本</span></div>
            <div className="foundation-grid">{data.foundationSkills.map((skill) => <details className="foundation-card" key={skill.name}><summary><span><strong>{skill.name}</strong><small>v{skill.version} · {skill.sha256.slice(0, 12)}</small></span><CheckCircle2 size={16} /></summary><pre>{skill.content}</pre></details>)}</div>
            <div className="skill-timeline">
              {data.skills.map((skill) => (
                <article className={skill.is_active ? "skill-card active" : "skill-card"} key={skill.id}>
                  <header><div><span>v{skill.version}</span>{skill.is_active ? <em>当前版本</em> : null}</div><small>{new Date(skill.created_at).toLocaleString("zh-CN")}</small></header>
                  <h3>{skill.trigger_reason}</h3><p>{skill.expected_effect}</p>
                  <details><summary>查看完整个人技能 JSON</summary><pre>{JSON.stringify(skill.content, null, 2)}</pre></details>
                  {!skill.is_active ? <Button size="sm" onClick={async () => { await fetch(`/api/dev/skills/${skill.id}/restore`, { method: "POST" }); await load(); }}>恢复为新的当前版本</Button> : null}
                </article>
              ))}
            </div>
          </section>
        ) : null}
        {data && tab === "competition" ? (
          <section>
            <div className="dev-section-heading"><div><h1>从“会回答”到“有温度”</h1><p>同一输入依次运行直接回答、固定技能＋画像和个人技能演化版本；结果仅用于观察，不设置门槛。</p></div><span>{data.competition.runs.length} 次实验</span></div>
            <div className="lab-runner">
              <label htmlFor="lab-prompt">同题对照输入</label>
              <textarea id="lab-prompt" value={labPrompt} onChange={(event) => setLabPrompt(event.target.value)} rows={3} />
              <Button variant="primary" onClick={() => void runLab()} disabled={labRunning || !labPrompt.trim()}><FlaskConical size={15} />{labRunning ? "正在生成三组结果…" : "运行三阶段消融"}</Button>
              <small>实验会沿用当前服务端模型配置；每次结果会保留模型路由与事实来源，未核对的主张会明确标记。</small>
            </div>
            <div className="benchmark-list">
              {data.competition.runs.map((run) => (
                <article className="benchmark-run" key={run.id}>
                  <header><div><strong>{run.scenario}</strong><span>{new Date(run.created_at).toLocaleString("zh-CN")}</span></div><small>{run.adapter_id}</small></header>
                  <p className="benchmark-prompt">{run.prompt}</p>
                  <div className="benchmark-grid">
                    {run.outputs.map((output: any) => (
                      <section key={output.id} className={run.preferred_mode === output.mode ? "benchmark-output preferred" : "benchmark-output"}>
                        <header><strong>{output.mode === "direct" ? "01 直接回答" : output.mode === "profile" ? "02 固定技能＋画像" : "03 个人技能"}</strong><span>{output.latency_ms} 毫秒</span></header>
                        <p>{output.content}</p>
                        <div className="claim-list">{(output.claims ?? []).map((claim: any, index: number) => <div key={index} className={`claim ${claim.status}`}><ShieldCheck size={13} /><span>{claim.status === "supported" ? "有来源" : claim.status === "uncertain" ? "不确定" : "需复核"}</span>{claim.sourceUrl ? <a href={claim.sourceUrl} target="_blank" rel="noreferrer">来源</a> : null}</div>)}</div>
                        <button className="preference-button" onClick={() => void prefer(run.id, output.mode)}>选择这一版</button>
                      </section>
                    ))}
                  </div>
                </article>
              ))}
            </div>
            <section className="live-conversation-evidence">
              <h2>真实模型多轮会话</h2>
              <p>以下记录来自当前匿名测试档案，可与运行追踪、记忆版本和费用明细交叉核对。</p>
              {data.competition.conversations.map((conversation) => (
                <details className="live-conversation-card" key={conversation.id}>
                  <summary><span><strong>{conversation.title}</strong><small>{conversation.messages.length} 条消息</small></span><CheckCircle2 size={15} /></summary>
                  <div>{conversation.messages.map((message: any) => <p key={message.id}><strong>{message.role === "user" ? "用户" : "知微"}</strong>{message.content}</p>)}</div>
                </details>
              ))}
            </section>
            <div className="competition-evidence-grid">
              <section><h2><ShieldCheck size={16} />风险追踪</h2>{data.competition.risks.length ? data.competition.risks.map((risk) => <pre key={risk.id}>{JSON.stringify(risk, null, 2)}</pre>) : <p>尚无风险事件。</p>}</section>
              <section><h2><Undo2 size={16} />撤回审计</h2>{data.competition.withdrawals.length ? data.competition.withdrawals.map((item) => <pre key={item.id}>{JSON.stringify(item, null, 2)}</pre>) : <p>尚无撤回记录。</p>}</section>
            </div>
          </section>
        ) : null}
        {tab === "costs" ? (
          <section>
            <div className="dev-section-heading"><div><h1>模型与费用</h1><p>查看当前匿名档案产生的模型调用、用量与价格依据。</p></div><span>{costData?.runs.length ?? 0} 次调用</span></div>
            {costError ? <div className="dev-error" role="alert">{costError}</div> : null}
            {!costData && !costError ? <div className="loading-state">正在读取模型费用…</div> : null}
            {costData ? (
              <>
                <div className="cost-summary-grid">
                  <article><span>费用估算</span><strong>{formatCost(costData.totals.total_cost)}</strong></article>
                  <article><span>输入 Token</span><strong>{formatTokens(costData.totals.input_tokens)}</strong><small>缓存输入 {formatTokens(costData.totals.cached_input_tokens)}</small></article>
                  <article><span>输出 Token</span><strong>{formatTokens(costData.totals.output_tokens)}</strong><small>思考 {formatTokens(costData.totals.reasoning_tokens)}</small></article>
                  <article><span>联网搜索</span><strong>{formatTokens(costData.totals.search_calls)} 次</strong><small>turbo ¥{costData.searchPricing.turboPerCallCny.toFixed(3)} / max ¥{costData.searchPricing.maxPerCallCny.toFixed(3)}</small></article>
                </div>
                <p className="cost-disclaimer">{costData.disclaimer}</p>
                <div className="model-cost-layout">
                  <section className="model-run-list">
                    <h2>逐次调用</h2>
                    {costData.runs.length ? costData.runs.map((run) => (
                      <article className="model-run-card" key={run.id}>
                        <header><div><strong>{taskLabels[run.role] ?? run.role}</strong><span>{run.model_name ?? run.adapter_id}{run.transport && run.transport !== "unknown" ? ` · ${run.transport}` : ""}</span></div><em className={`run-status ${run.status ?? "completed"}`}>{statusLabels[run.status ?? "completed"] ?? run.status}</em></header>
                        <dl>
                          <div><dt>{run.status === "running" ? "预计输入" : "输入"}</dt><dd>{formatTokens(run.status === "running" ? run.estimated_input_tokens : run.input_tokens)}</dd></div>
                          <div><dt>{run.status === "running" ? "预计输出" : "输出"}</dt><dd>{formatTokens(run.status === "running" ? run.estimated_output_tokens : run.output_tokens)}</dd></div>
                          <div><dt>缓存输入</dt><dd>{formatTokens(run.cached_input_tokens)}</dd></div>
                          <div><dt>思考</dt><dd>{formatTokens(run.reasoning_tokens)}</dd></div>
                          <div><dt>搜索</dt><dd>{formatTokens(run.search_calls)} 次</dd></div>
                          <div><dt>费用</dt><dd>{formatCost(run.estimated_cost_cny)}</dd></div>
                          <div><dt>首字延迟</dt><dd>{run.first_token_ms == null ? "—" : `${run.first_token_ms} 毫秒`}</dd></div>
                          <div><dt>总耗时</dt><dd>{formatTokens(run.duration_ms)} 毫秒</dd></div>
                        </dl>
                        <footer><span>{new Date(run.created_at).toLocaleString("zh-CN")}</span><span>{run.thinking ? "已开启思考" : "未开启思考"}{run.retries ? ` · 重试 ${run.retries} 次` : ""}</span></footer>
                        <details><summary>查看原始调用记录</summary><pre>{JSON.stringify(run, null, 2)}</pre></details>
                      </article>
                    )) : <div className="empty-cost-state">还没有模型调用记录。完成一次访谈或聊天后，这里会显示真实用量。</div>}
                  </section>
                  <aside className="pricing-list">
                    <h2>价格快照</h2>
                    {costData.pricing.length ? costData.pricing.map((item) => (
                      <details className="pricing-card" key={item.id}>
                        <summary><span><strong>{item.model_name}</strong><small>{new Date(item.fetched_at).toLocaleString("zh-CN")}</small></span><em>{item.context_window ? `${formatTokens(item.context_window)} 上下文` : "查看价格"}</em></summary>
                        <pre>{JSON.stringify({ provider: item.provider, prices: item.prices, capabilities: item.capabilities }, null, 2)}</pre>
                      </details>
                    )) : <div className="empty-cost-state">尚无价格快照。真实模型模式会每 24 小时尝试更新一次。</div>}
                  </aside>
                </div>
              </>
            ) : null}
          </section>
        ) : null}
      </main>
    </div>
  );
}
