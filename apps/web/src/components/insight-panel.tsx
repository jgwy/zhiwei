"use client";

import { LineChart, Line, ResponsiveContainer, YAxis, Tooltip } from "recharts";
import { Check, MessageSquareText, Settings2, Trash2, Undo2, X } from "lucide-react";
import { useState } from "react";
import type { BootstrapData } from "@/lib/client-types";
import { categoryLabel } from "@zhiwei/core/client";
import { Toggle } from "@/components/ui/toggle";
import { groupVisibleMemories, isMemorySettingEnabled } from "@/lib/memory-view";

type MemoryView = BootstrapData["memories"][number];
type MemoryAction = "confirm" | "reject" | "withdraw";

export function InsightPanel({
  data,
  activeConversationId,
  onMemoryCorrect,
  onMemoryConfirm,
  onMemoryReject,
  onSettings,
  onWithdraw,
  onDeleteAll,
}: {
  data: BootstrapData;
  activeConversationId: string | null;
  onMemoryCorrect: (content: string) => void;
  onMemoryConfirm: (memoryId: string, versionId: string) => Promise<void>;
  onMemoryReject: (memoryId: string, versionId: string) => Promise<void>;
  onSettings: (settings: Record<string, boolean>) => Promise<void>;
  onWithdraw: (memoryId: string, versionId: string) => Promise<void>;
  onDeleteAll: (confirmation: string) => void;
}) {
  const score = data.profile?.score ?? 0;
  const components = data.profile?.understanding;
  const settings = data.user.settings;
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [busySetting, setBusySetting] = useState<string | null>(null);
  const [withdrawTarget, setWithdrawTarget] = useState<string | null>(null);
  const [panelError, setPanelError] = useState<string | null>(null);

  const { pending: pendingMemories, active: activeMemories, longTerm: longTermMemories, shortTerm: shortTermMemories } = groupVisibleMemories(data.memories, activeConversationId);

  async function runMemoryAction(memory: MemoryView, action: MemoryAction) {
    const actionKey = `${action}:${memory.versionId}`;
    if (busyAction) return false;
    setBusyAction(actionKey);
    setPanelError(null);
    try {
      if (action === "confirm") await onMemoryConfirm(memory.id, memory.versionId);
      if (action === "reject") await onMemoryReject(memory.id, memory.versionId);
      if (action === "withdraw") await onWithdraw(memory.id, memory.versionId);
      return true;
    } catch (error) {
      setPanelError(error instanceof Error ? error.message : "这次操作没有完成，请重试。");
      return false;
    } finally {
      setBusyAction(null);
    }
  }

  async function updateSetting(key: string, checked: boolean) {
    if (busySetting) return;
    setBusySetting(key);
    setPanelError(null);
    try {
      await onSettings({ [key]: checked });
    } catch (error) {
      setPanelError(error instanceof Error ? error.message : "设置没有保存成功，请重试。");
    } finally {
      setBusySetting(null);
    }
  }

  function renderMemory(memory: MemoryView, state: "pending" | "active") {
    const isBusy = busyAction?.endsWith(memory.versionId) ?? false;
    const source = state === "pending" ? "待你确认" : "已生效";
    const scope = memory.scope === "conversation" ? "当前对话" : "跨对话";
    const lifetime = memory.tier === "short" ? shortTermLifetime(memory.validUntil) : scope;

    return (
      <article className={`memory-card memory-card-${state}`} key={memory.versionId} aria-busy={isBusy} data-memory-id={memory.id} data-version-id={memory.versionId}>
        <div className="memory-card-meta">
          <span>{categoryLabel(memory.category)}</span>
          <small>{source} · {lifetime}</small>
        </div>
        <p>{memory.content}</p>

        {state === "pending" ? (
          <div className="memory-card-actions">
            <button className="memory-confirm-button" disabled={Boolean(busyAction)} onClick={() => void runMemoryAction(memory, "confirm")} aria-label={`确认这条认识：${memory.content}`}>
              <Check size={13} />{isBusy && busyAction?.startsWith("confirm") ? "正在确认…" : "确认"}
            </button>
            <button disabled={Boolean(busyAction)} onClick={() => void runMemoryAction(memory, "reject")} aria-label={`拒绝这条认识：${memory.content}`}>
              <X size={13} />{isBusy && busyAction?.startsWith("reject") ? "正在处理…" : "不像我"}
            </button>
          </div>
        ) : withdrawTarget === memory.versionId ? (
          <div className="memory-withdraw-confirm" role="group" aria-label="确认撤回这条认识">
            <span>撤回后，知微将不再使用这一版本。</span>
            <div>
              <button disabled={isBusy} onClick={() => setWithdrawTarget(null)} aria-label={`继续保留这条认识：${memory.content}`}>继续保留</button>
              <button className="memory-withdraw-button" disabled={Boolean(busyAction)} onClick={() => void runMemoryAction(memory, "withdraw").then((done) => { if (done) setWithdrawTarget(null); })} aria-label={`确认撤回这条认识：${memory.content}`}>
                {isBusy ? "正在撤回…" : "确认撤回"}
              </button>
            </div>
          </div>
        ) : (
          <div className="memory-card-actions">
            <button onClick={() => onMemoryCorrect(memory.content)} aria-label={`在对话中修正这条认识：${memory.content}`}><MessageSquareText size={13} />在对话中修正</button>
            <button className="memory-withdraw-trigger" disabled={Boolean(busyAction)} onClick={() => setWithdrawTarget(memory.versionId)} aria-label={`准备撤回这条认识：${memory.content}`}><Undo2 size={13} />撤回</button>
          </div>
        )}
      </article>
    );
  }

  function renderMemoryGroup(title: string, description: string, memories: MemoryView[]) {
    return (
      <section className="memory-tier-group">
        <header>
          <div><strong>{title}</strong><span>{description}</span></div>
          <em>{memories.length} 条</em>
        </header>
        {memories.length ? <div className="memory-card-list">{memories.map((memory) => renderMemory(memory, "active"))}</div> : <p className="memory-empty">还没有这类记忆。</p>}
      </section>
    );
  }

  return (
    <aside className="insight-panel">
      <div className="insight-heading">
        <h2>关于你</h2>
        <button className="icon-plain" aria-label="画像设置" onClick={() => document.getElementById("memory-settings")?.scrollIntoView({ behavior: "smooth" })}>
          <Settings2 size={17} />
        </button>
      </div>

      <section className="score-card">
        <div className="score-ring" style={{ "--score": `${score * 3.6}deg` } as React.CSSProperties}>
          <div><strong>{score}%</strong><span>了解度</span></div>
        </div>
        <div className="score-copy">
          <strong>{score < 20 ? "我们刚刚认识" : score < 55 ? "正在形成默契" : "我已经记住不少"}</strong>
          <span>会随理解、纠正和时间变化而升降，最高 95%。</span>
        </div>
      </section>

      {components ? (
        <div className="score-breakdown">
          {[
            ["画像覆盖", components.coverage],
            ["理解稳定", components.validation],
            ["对话贴合", components.personalization],
            ["保持更新", components.temporal],
          ].map(([label, value]) => (
            <div key={label as string}>
              <span>{label as string}</span>
              <div><i style={{ width: `${Math.round((value as number) * 100)}%` }} /></div>
              <em>{Math.round((value as number) * 100)}</em>
            </div>
          ))}
        </div>
      ) : null}

      <section className="insight-section">
        <div className="section-title"><h3>最近的状态</h3><span>{data.mood.length ? `${data.mood.length} 天` : "还没有记录"}</span></div>
        <div className="mood-chart" aria-label="最近心情曲线">
          {data.mood.length ? (
            <ResponsiveContainer width="100%" height={118}>
              <LineChart data={data.mood} margin={{ top: 14, right: 8, bottom: 4, left: 8 }}>
                <YAxis domain={[-5, 5]} hide />
                <Tooltip
                  contentStyle={{ borderRadius: 12, border: "1px solid #e8e8e8", boxShadow: "0 10px 30px rgba(0,0,0,.08)", fontSize: 12 }}
                  labelFormatter={(value) => new Date(String(value ?? "")).toLocaleDateString("zh-CN", { month: "short", day: "numeric" })}
                />
                <Line name="心情值" type="monotone" dataKey="score" stroke="#222" strokeWidth={2.2} dot={{ r: 3, fill: "white", strokeWidth: 2 }} activeDot={{ r: 4 }} />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className="empty-chart"><span>—</span><p>聊到明确感受时，曲线会慢慢出现。</p></div>
          )}
        </div>
      </section>

      <section className="insight-section memory-section">
        <div className="section-title"><h3>知微眼中的你</h3><span>{activeMemories.length} 条生效</span></div>
        <p className="profile-summary">{data.profile?.summary ?? "我们还在初识阶段。等你多说一点，我会在这里形成一段会持续更新的理解。"}</p>

        {pendingMemories.length ? (
          <section className="memory-candidate-box" aria-labelledby="memory-candidate-title">
            <header><div><strong id="memory-candidate-title">待你确认</strong><span>这些是知微新形成的认识，确认前不会用于之后的回答。</span></div><em>{pendingMemories.length} 条</em></header>
            <div className="memory-card-list">{pendingMemories.map((memory) => renderMemory(memory, "pending"))}</div>
          </section>
        ) : null}

        {panelError ? <p className="memory-panel-error" role="alert">{panelError}</p> : null}

        <div className="memory-tier-list">
          {renderMemoryGroup("长期记忆", "在你的授权下跨对话使用", longTermMemories)}
          {renderMemoryGroup("短期记忆", "服务当前对话，到期自动失效", shortTermMemories)}
        </div>
      </section>

      <section className="insight-section settings-section" id="memory-settings">
        <div className="section-title"><h3>授权范围</h3></div>
        {([
          ["shortTermMemoryEnabled", "短期记忆", "仅服务当前对话，并按有效期自动失效"],
          ["longTermMemoryEnabled", "长期记忆", "跨对话使用已生效的认识"],
          ["emotionTrackingEnabled", "情绪趋势", "关闭后不再生成新的心情样本"],
          ["skillEvolutionEnabled", "相处方式学习", "关闭后保持目前学到的相处方式"],
          ["returnNotesEnabled", "站内回访", "关闭后不再展示未完话题提醒"],
        ] as const).map(([key, label, description]) => (
          <div className="setting-row" key={key}>
            <span><strong>{label}</strong><small>{description}</small></span>
            <Toggle
              label={label}
              checked={key === "shortTermMemoryEnabled" || key === "longTermMemoryEnabled" ? isMemorySettingEnabled(settings, key) : settings[key] !== false}
              disabled={Boolean(busySetting)}
              onChange={(checked) => void updateSetting(key, checked)}
            />
          </div>
        ))}
        <div className="delete-data-box">
          <strong><Trash2 size={14} /> 删除全部数据</strong>
          <small>输入“删除知微中的全部数据”后，将清除这份知微档案的对话、画像、记忆、相处方式和运行记录。</small>
          <input value={deleteConfirmation} onChange={(event) => setDeleteConfirmation(event.target.value)} placeholder="删除知微中的全部数据" />
          <button disabled={deleteConfirmation !== "删除知微中的全部数据"} onClick={() => onDeleteAll(deleteConfirmation)}>永久删除全部数据</button>
        </div>
      </section>
    </aside>
  );
}

function shortTermLifetime(validUntil: string | null) {
  if (!validUntil) return "当前对话";
  const date = new Date(validUntil);
  if (Number.isNaN(date.getTime())) return "到期自动失效";
  return `有效至${new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(date)}`;
}
