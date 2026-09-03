"use client";

import { LineChart, Line, ResponsiveContainer, YAxis, Tooltip } from "recharts";
import { Check, ChevronRight, Pencil, Settings2, ShieldCheck, Undo2, Trash2, X } from "lucide-react";
import { useState } from "react";
import type { BootstrapData } from "@/lib/client-types";
import { categoryLabel, memoryKindLabel } from "@zhiwei/core/client";
import { Toggle } from "@/components/ui/toggle";

export function InsightPanel({
  data,
  onMemoryClick,
  onMemoryUpdate,
  onMemoryConfirm,
  onSettings,
  onWithdraw,
  onDeleteAll,
}: {
  data: BootstrapData;
  onMemoryClick: (content: string) => void;
  onMemoryUpdate: (memoryId: string, input: { content: string; category?: string; tier?: "short" | "long" }) => Promise<void>;
  onMemoryConfirm: (memoryId: string) => Promise<void>;
  onSettings: (settings: Record<string, boolean>) => void;
  onWithdraw: (memoryId: string) => void;
  onDeleteAll: (confirmation: string) => void;
}) {
  const score = data.profile?.score ?? 0;
  const components = data.profile?.understanding;
  const settings = data.user.settings;
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [savingId, setSavingId] = useState<string | null>(null);

  function beginEdit(memory: BootstrapData["memories"][number]) {
    setEditingId(memory.id);
    setDraft(memory.content);
  }

  async function saveEdit(memory: BootstrapData["memories"][number]) {
    if (!draft.trim() || savingId) return;
    setSavingId(memory.id);
    try {
      await onMemoryUpdate(memory.id, { content: draft.trim(), category: memory.category, tier: memory.tier });
      setEditingId(null);
    } finally {
      setSavingId(null);
    }
  }
  const pendingMemories = data.memories.filter((memory) => memory.status === "pending");
  const activeMemories = data.memories.filter((memory) => memory.status !== "pending");

  function renderMemory(memory: BootstrapData["memories"][number]) {
    const lifetime = memory.tier === "long" ? "长期 · 跨对话" : "短期 · 当前对话";
    const source = memory.status === "pending"
      ? "等待你确认"
      : memory.sourceType === "explicit"
        ? "用户明确提供"
        : memory.sourceType === "confirmed"
          ? "用户已确认"
          : memory.sourceType === "system"
            ? "系统记录"
            : "对话推断";
    return (
      <div className={`memory-row ${memory.status === "pending" ? "memory-pending" : ""}`} key={memory.versionId}>
        {editingId === memory.id ? (
          <div className="memory-editor">
            <textarea value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={600} rows={3} aria-label="编辑记忆内容" />
            <div className="memory-editor-actions">
              <button onClick={() => void saveEdit(memory)} disabled={!draft.trim() || savingId === memory.id} title="保存修改"><Check size={14} /> 保存</button>
              <button onClick={() => setEditingId(null)} disabled={savingId === memory.id} title="取消编辑"><X size={14} /> 取消</button>
            </div>
          </div>
        ) : (
          <>
            <button onClick={() => onMemoryClick(memory.content)}>
              <span>
                <small>{categoryLabel(memory.category)} · {memoryKindLabel(memory.kind)} · {lifetime} · {source}</small>
                {memory.content}
              </span>
              <ChevronRight size={15} />
            </button>
            <div className="memory-actions">
              {memory.status === "pending" || memory.sourceType === "inferred" ? <button className="memory-action-button" onClick={() => void onMemoryConfirm(memory.id)} aria-label={`确认记忆：${memory.content}`} title="确认后加入长期记忆"><ShieldCheck size={13} /></button> : null}
              <button className="memory-action-button" onClick={() => beginEdit(memory)} aria-label={`编辑记忆：${memory.content}`} title="编辑这条认识"><Pencil size={13} /></button>
              <button className="withdraw-button" onClick={() => onWithdraw(memory.id)} aria-label={`撤回记忆：${memory.content}`} title="撤回这条认识"><Undo2 size={13} /></button>
            </div>
          </>
        )}
      </div>
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

      <section className="insight-section">
        <div className="section-title"><h3>知微眼中的你</h3><span>{activeMemories.length} 条生效</span></div>
        <p className="profile-summary">{data.profile?.summary ?? "我们还在初识阶段。等你多说一点，我会在这里形成一段会持续更新的理解。"}</p>
        {pendingMemories.length ? (
          <div className="memory-candidate-box">
            <div><strong>待确认</strong><span>{pendingMemories.length} 条 · 确认前不会用于回答</span></div>
            <div className="memory-list">{pendingMemories.slice(0, 6).map(renderMemory)}</div>
          </div>
        ) : null}
        <p className="memory-guide">短期记忆只延续当前对话并在 7 天内过期；长期记忆用于跨对话的稳定画像、学习进度和概念误区。</p>
        <div className="memory-list">{activeMemories.slice(0, 8).map(renderMemory)}</div>
      </section>

      <section className="insight-section settings-section" id="memory-settings">
        <div className="section-title"><h3>授权范围</h3></div>
        {([
          ["shortTermMemoryEnabled", "短期上下文", "仅延续当前对话，最长保留 7 天"],
          ["longTermMemoryEnabled", "长期记忆", "跨对话使用已确认的稳定认识"],
          ["emotionTrackingEnabled", "情绪趋势", "关闭后不再生成新的心情样本"],
          ["skillEvolutionEnabled", "相处方式学习", "关闭后保持目前学到的相处方式"],
          ["returnNotesEnabled", "站内回访", "关闭后不再展示未完话题提醒"],
        ] as const).map(([key, label, description]) => (
          <div className="setting-row" key={key}>
            <span><strong>{label}</strong><small>{description}</small></span>
            <Toggle
              label={label}
              checked={settings[key] !== false}
              onChange={(checked) => onSettings({ [key]: checked })}
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
