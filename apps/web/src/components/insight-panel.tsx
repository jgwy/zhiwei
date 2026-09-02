"use client";

import { LineChart, Line, ResponsiveContainer, YAxis, Tooltip } from "recharts";
import { ChevronRight, Settings2, Undo2, Trash2 } from "lucide-react";
import { useState } from "react";
import type { BootstrapData } from "@/lib/client-types";
import { categoryLabel } from "@zhiwei/core/client";
import { Toggle } from "@/components/ui/toggle";

export function InsightPanel({
  data,
  onMemoryClick,
  onSettings,
  onWithdraw,
  onDeleteAll,
}: {
  data: BootstrapData;
  onMemoryClick: (content: string) => void;
  onSettings: (settings: Record<string, boolean>) => void;
  onWithdraw: (memoryId: string) => void;
  onDeleteAll: (confirmation: string) => void;
}) {
  const score = data.profile?.score ?? 0;
  const components = data.profile?.understanding;
  const settings = data.user.settings;
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
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
                <Line type="monotone" dataKey="score" stroke="#222" strokeWidth={2.2} dot={{ r: 3, fill: "white", strokeWidth: 2 }} activeDot={{ r: 4 }} />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className="empty-chart"><span>—</span><p>聊到明确感受时，曲线会慢慢出现。</p></div>
          )}
        </div>
      </section>

      <section className="insight-section">
        <div className="section-title"><h3>知微眼中的你</h3><span>{data.memories.length} 条认识</span></div>
        <p className="profile-summary">{data.profile?.summary ?? "我们还在初识阶段。等你多说一点，我会在这里形成一段会持续更新的理解。"}</p>
        <div className="memory-list">
          {data.memories.slice(0, 6).map((memory) => (
            <div className="memory-row" key={memory.versionId}>
              <button onClick={() => onMemoryClick(memory.content)}>
                <span><small>{categoryLabel(memory.category)}</small>{memory.content}</span>
                <ChevronRight size={15} />
              </button>
              <button className="withdraw-button" onClick={() => onWithdraw(memory.id)} aria-label={`撤回记忆：${memory.content}`} title="撤回这条认识">
                <Undo2 size={13} />
              </button>
            </div>
          ))}
        </div>
      </section>

      <section className="insight-section settings-section" id="memory-settings">
        <div className="section-title"><h3>授权范围</h3></div>
        {([
          ["memoryEnabled", "长期记忆", "关闭后不再记录或使用画像"],
          ["emotionTrackingEnabled", "情绪趋势", "关闭后不再生成新的心情样本"],
          ["skillEvolutionEnabled", "相处方式学习", "关闭后个人 Skill 保持当前版本"],
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
          <small>输入“删除知微中的全部数据”后，将清除当前匿名档案的对话、画像、Memory、Skill 与 Trace。</small>
          <input value={deleteConfirmation} onChange={(event) => setDeleteConfirmation(event.target.value)} placeholder="删除知微中的全部数据" />
          <button disabled={deleteConfirmation !== "删除知微中的全部数据"} onClick={() => onDeleteAll(deleteConfirmation)}>永久删除当前档案</button>
        </div>
      </section>
    </aside>
  );
}
