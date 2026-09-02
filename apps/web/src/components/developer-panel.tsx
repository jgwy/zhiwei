"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, CheckCircle2, Clock3, Database, FlaskConical, GitBranch, RefreshCw, ScrollText, ShieldCheck, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";

type DeveloperData = {
  traces: any[];
  memories: any[];
  profiles: any[];
  skills: any[];
  mcpCalls: any[];
  modelRuns: any[];
  foundationSkills: any[];
  competition: { runs: any[]; risks: any[]; withdrawals: any[] };
};

export function DeveloperPanel({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<"trace" | "memory" | "skills" | "competition">("trace");
  const [data, setData] = useState<DeveloperData | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [labPrompt, setLabPrompt] = useState("请为高中生写一段关于太阳耀斑与空间天气的课程讲稿开场，要求准确、自然，不要模板腔。");
  const [labRunning, setLabRunning] = useState(false);

  async function load() {
    const response = await fetch("/api/dev/data", { cache: "no-store" });
    setData(await response.json());
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
        <button className={tab === "trace" ? "active" : ""} onClick={() => setTab("trace")}><ScrollText size={17} />运行 Trace</button>
        <button className={tab === "memory" ? "active" : ""} onClick={() => setTab("memory")}><Database size={17} />记忆与画像</button>
        <button className={tab === "skills" ? "active" : ""} onClick={() => setTab("skills")}><GitBranch size={17} />Skill 演化</button>
        <button className={tab === "competition" ? "active" : ""} onClick={() => setTab("competition")}><FlaskConical size={17} />比赛实验室</button>
      </nav>
      <main className="developer-content">
        {!data ? <div className="loading-state">正在读取运行证据…</div> : null}
        {data && tab === "trace" ? (
          <section>
            <div className="dev-section-heading"><div><h1>每一次回答是怎么产生的</h1><p>先看阶段、耗时与版本；需要时再展开完整上下文和模型输出。</p></div><span>{data.traces.length} 个事件</span></div>
            <div className="trace-list">
              {groupedTraces.map(([traceId, events]) => (
                <article className="trace-card" key={traceId}>
                  <header><div><CheckCircle2 size={17} /><strong>{traceId.slice(0, 18)}</strong></div><span>{events.length} stages</span></header>
                  <div className="trace-timeline">
                    {events.map((event) => (
                      <button key={event.id} onClick={() => setExpanded(expanded === event.id ? null : event.id)}>
                        <i />
                        <span><strong>{event.stage}</strong><small><Clock3 size={12} />{event.duration_ms ?? 0} ms · {new Date(event.created_at).toLocaleTimeString("zh-CN")}</small></span>
                        {expanded === event.id ? <pre>{JSON.stringify(event.payload, null, 2)}</pre> : null}
                      </button>
                    ))}
                  </div>
                </article>
              ))}
            </div>
            {data.mcpCalls.length ? <details className="mcp-log"><summary>Memory MCP 调用（{data.mcpCalls.length}）</summary><pre>{JSON.stringify(data.mcpCalls, null, 2)}</pre></details> : null}
            {data.modelRuns.length ? <details className="mcp-log"><summary>模型运行与预算（{data.modelRuns.length}）</summary><pre>{JSON.stringify(data.modelRuns, null, 2)}</pre></details> : null}
          </section>
        ) : null}
        {data && tab === "memory" ? (
          <section>
            <div className="dev-section-heading"><div><h1>证据如何变成理解</h1><p>用户界面保持自然，这里保留 evidence、版本、置信度和了解度计算。</p></div><span>{data.memories.length} 个版本</span></div>
            <div className="dev-grid">
              <div className="dev-column"><h2>Memory 版本</h2>{data.memories.map((memory) => <article className="data-card" key={memory.id}><header><span className={memory.is_active ? "status-active" : "status-old"}>{memory.is_active ? "ACTIVE" : "SUPERSEDED"}</span><small>{memory.tier} · {memory.category}</small></header><p>{memory.content}</p><footer>confidence {Number(memory.confidence).toFixed(2)} · evidence {memory.evidence_ids?.length ?? 0}</footer><details><summary>查看原始记录</summary><pre>{JSON.stringify(memory, null, 2)}</pre></details></article>)}</div>
              <div className="dev-column"><h2>画像快照</h2>{data.profiles.map((profile) => <article className="data-card" key={profile.id}><header><strong>{profile.understanding_score}%</strong><small>{new Date(profile.created_at).toLocaleString("zh-CN")}</small></header><p>{profile.summary}</p><pre>{JSON.stringify({ weights: profile.dimension_weights, components: profile.understanding_components }, null, 2)}</pre></article>)}</div>
            </div>
          </section>
        ) : null}
        {data && tab === "skills" ? (
          <section>
            <div className="dev-section-heading"><div><h1>固定能力与个体演化</h1><p>基底 Skill 只读并带哈希；个人 Skill 每次重写完整对象，旧版永久保留。</p></div><span>{data.skills.length} 个个人版本</span></div>
            <div className="foundation-grid">{data.foundationSkills.map((skill) => <details className="foundation-card" key={skill.name}><summary><span><strong>{skill.name}</strong><small>v{skill.version} · {skill.sha256.slice(0, 12)}</small></span><CheckCircle2 size={16} /></summary><pre>{skill.content}</pre></details>)}</div>
            <div className="skill-timeline">
              {data.skills.map((skill) => (
                <article className={skill.is_active ? "skill-card active" : "skill-card"} key={skill.id}>
                  <header><div><span>v{skill.version}</span>{skill.is_active ? <em>当前版本</em> : null}</div><small>{new Date(skill.created_at).toLocaleString("zh-CN")}</small></header>
                  <h3>{skill.trigger_reason}</h3><p>{skill.expected_effect}</p>
                  <details><summary>查看完整 Skill JSON</summary><pre>{JSON.stringify(skill.content, null, 2)}</pre></details>
                  {!skill.is_active ? <Button size="sm" onClick={async () => { await fetch(`/api/dev/skills/${skill.id}/restore`, { method: "POST" }); await load(); }}>恢复为新的当前版本</Button> : null}
                </article>
              ))}
            </div>
          </section>
        ) : null}
        {data && tab === "competition" ? (
          <section>
            <div className="dev-section-heading"><div><h1>从“会回答”到“有温度”</h1><p>同一输入依次运行直接回答、固定 Skills＋画像和个体 Skill 演化版本；结果仅用于观察，不设置门槛。</p></div><span>{data.competition.runs.length} 次实验</span></div>
            <div className="lab-runner">
              <label htmlFor="lab-prompt">同题对照输入</label>
              <textarea id="lab-prompt" value={labPrompt} onChange={(event) => setLabPrompt(event.target.value)} rows={3} />
              <Button variant="primary" onClick={() => void runLab()} disabled={labRunning || !labPrompt.trim()}><FlaskConical size={15} />{labRunning ? "正在生成三组结果…" : "运行三阶段消融"}</Button>
              <small>当前使用 ScriptedAdapter。Qwen 与联网搜索尚未接入，未核对主张会明确标记。</small>
            </div>
            <div className="benchmark-list">
              {data.competition.runs.map((run) => (
                <article className="benchmark-run" key={run.id}>
                  <header><div><strong>{run.scenario}</strong><span>{new Date(run.created_at).toLocaleString("zh-CN")}</span></div><small>{run.adapter_id}</small></header>
                  <p className="benchmark-prompt">{run.prompt}</p>
                  <div className="benchmark-grid">
                    {run.outputs.map((output: any) => (
                      <section key={output.id} className={run.preferred_mode === output.mode ? "benchmark-output preferred" : "benchmark-output"}>
                        <header><strong>{output.mode === "direct" ? "01 直接回答" : output.mode === "profile" ? "02 固定Skills＋画像" : "03 Personal Skill"}</strong><span>{output.latency_ms}ms</span></header>
                        <p>{output.content}</p>
                        <div className="claim-list">{(output.claims ?? []).map((claim: any, index: number) => <div key={index} className={`claim ${claim.status}`}><ShieldCheck size={13} /><span>{claim.status === "supported" ? "有来源" : claim.status === "uncertain" ? "不确定" : "需复核"}</span>{claim.sourceUrl ? <a href={claim.sourceUrl} target="_blank" rel="noreferrer">来源</a> : null}</div>)}</div>
                        <button className="preference-button" onClick={() => void prefer(run.id, output.mode)}>选择这一版</button>
                      </section>
                    ))}
                  </div>
                </article>
              ))}
            </div>
            <div className="competition-evidence-grid">
              <section><h2><ShieldCheck size={16} />风险 Trace</h2>{data.competition.risks.length ? data.competition.risks.map((risk) => <pre key={risk.id}>{JSON.stringify(risk, null, 2)}</pre>) : <p>尚无风险事件。</p>}</section>
              <section><h2><Undo2 size={16} />撤回审计</h2>{data.competition.withdrawals.length ? data.competition.withdrawals.map((item) => <pre key={item.id}>{JSON.stringify(item, null, 2)}</pre>) : <p>尚无撤回记录。</p>}</section>
            </div>
          </section>
        ) : null}
      </main>
    </div>
  );
}
