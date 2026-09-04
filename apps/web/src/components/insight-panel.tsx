"use client";

import dynamic from "next/dynamic";
import { BookOpenText, ChevronDown, ListTree, MessageSquareText, Undo2, X } from "lucide-react";
import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import type { BootstrapData } from "@/lib/client-types";
import { categoryLabel } from "@zhiwei/core/client";
import { resolveLongTermSummary, selectUserMemories, type ProfileView, type UserMemoryView } from "@/lib/memory-view";

const MoodChart = dynamic(() => import("./mood-chart").then((module) => module.MoodChart), {
  loading: () => <div style={{ height: 118 }} role="status" aria-label="正在加载心情曲线" />,
});

export const InsightPanel = memo(function InsightPanel({
  data,
  onMemoryCorrect,
  onWithdraw,
}: {
  data: BootstrapData;
  onMemoryCorrect: (content: string) => void;
  onWithdraw: (memoryId: string, versionId: string) => Promise<void>;
}) {
  const score = data.profile?.score ?? 0;
  const components = data.profile?.understanding;
  const settings = data.user.settings;
  const memoryPaused = settings.memoryEnabled === false || settings.longTermMemoryEnabled === false;
  const profileView = data.profile as ProfileView | null;
  const { longTerm, allRecent } = selectUserMemories(data.memories as UserMemoryView[]);
  const longTermSummary = resolveLongTermSummary(profileView);
  const profileUnsynced = longTermSummary.state !== "ready";
  const scoreReasons = (profileView?.scoreChangeReasons ?? []).map((reason) => reason.message).filter(Boolean);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [managerOpen, setManagerOpen] = useState(false);
  const [showAllRecent, setShowAllRecent] = useState(false);
  const [withdrawTarget, setWithdrawTarget] = useState<string | null>(null);
  const [busyVersion, setBusyVersion] = useState<string | null>(null);
  const [panelError, setPanelError] = useState<string | null>(null);
  const visibleRecent = showAllRecent ? allRecent : allRecent.slice(0, 6);

  async function withdraw(memory: UserMemoryView) {
    if (busyVersion) return;
    setBusyVersion(memory.versionId);
    setPanelError(null);
    try {
      await onWithdraw(memory.id, memory.versionId);
      setWithdrawTarget(null);
    } catch (error) {
      setPanelError(error instanceof Error ? error.message : "这条认识没有撤回成功，请重试。");
    } finally {
      setBusyVersion(null);
    }
  }

  function memoryActions(memory: UserMemoryView, closeManager = false) {
    const confirming = withdrawTarget === memory.versionId;
    const busy = busyVersion === memory.versionId;
    if (confirming) {
      return (
        <div className="memory-inline-confirm" role="group" aria-label={`确认撤回：${memory.content}`}>
          <span>撤回后，知微将不再使用这条认识。</span>
          <div>
            <button disabled={busy} onClick={() => setWithdrawTarget(null)}>继续保留</button>
            <button className="danger" disabled={Boolean(busyVersion)} onClick={() => void withdraw(memory)}>{busy ? "正在撤回…" : "确认撤回"}</button>
          </div>
        </div>
      );
    }
    return (
      <div className="memory-item-actions">
        <button onClick={() => { onMemoryCorrect(memory.content); if (closeManager) setManagerOpen(false); }} aria-label={`在对话中修正：${memory.content}`}><MessageSquareText size={13} />在对话中修正</button>
        <button className="withdraw" disabled={Boolean(busyVersion)} onClick={() => setWithdrawTarget(memory.versionId)} aria-label={`撤回：${memory.content}`}><Undo2 size={13} />撤回</button>
      </div>
    );
  }

  return (
    <aside className="insight-panel">
      <div className="insight-heading">
        <h2>关于你</h2>
      </div>

      <section className={`score-card ${memoryPaused ? "score-card-paused" : ""}`}>
        <div className="score-ring" style={{ "--score": `${score * 3.6}deg` } as React.CSSProperties}>
          <div><strong>{score}%</strong><span>了解度</span></div>
        </div>
        <div className="score-copy">
          <strong>{score < 20 ? "我们刚刚认识" : score < 55 ? "正在形成默契" : "我已经记住不少"}</strong>
          {memoryPaused ? <span className="score-pause-note">长期认识已暂停更新，当前分数会为你保留。</span> : profileUnsynced ? <span className="score-pause-note">长期认识尚未同步，当前分数暂时保留。</span> : <span>会随理解、纠正和时间变化而升降，最高 95%。</span>}
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

      {scoreReasons.length ? <div className="score-reasons"><strong>最近变化</strong><ul>{scoreReasons.slice(0, 2).map((reason) => <li key={reason}>{reason}</li>)}</ul></div> : null}

      <section className="insight-section">
        <div className="section-title"><h3>最近的状态</h3><span>{data.mood.length ? `${data.mood.length} 天` : "还没有记录"}</span></div>
        <div className="mood-chart" aria-label="最近心情曲线">
          {data.mood.length ? (
            <MoodChart mood={data.mood} />
          ) : <div className="empty-chart"><span>—</span><p>聊到明确感受时，曲线会慢慢出现。</p></div>}
        </div>
      </section>

      <section className="insight-section long-term-preview-section">
        <div className="section-title"><h3>关于你的长期认识</h3>{memoryPaused ? <span>已暂停使用</span> : <span>{longTerm.length} 条具体认识</span>}</div>
        <div className={`long-term-preview long-term-preview-${longTermSummary.state}`}>
          <p>{longTermSummary.text}</p>
          {"note" in longTermSummary ? <small className="long-term-sync-note">{longTermSummary.note}</small> : null}
          <div>
            <button onClick={() => setSummaryOpen(true)}><BookOpenText size={13} />查看全文</button>
            <button onClick={() => setManagerOpen(true)}><ListTree size={13} />管理具体认识</button>
          </div>
        </div>
      </section>

      <section className="insight-section recent-memory-section">
        <div className="section-title"><h3>近期认识</h3><span>{showAllRecent ? `全部 ${allRecent.length} 条` : `最新 ${Math.min(allRecent.length, 6)} 条`}</span></div>
        {visibleRecent.length ? (
          <div className="recent-memory-list">
            {visibleRecent.map((memory) => (
              <details className="recent-memory-item" key={memory.versionId}>
                <summary>
                  <span className="recent-memory-meta"><strong>{categoryLabel(memory.category)}</strong><small>{formatMemoryDate(memory.createdAt)}</small></span>
                  <span className="recent-memory-preview">{memory.content}</span>
                  <ChevronDown size={14} />
                </summary>
                <div className="recent-memory-body"><p>{memory.content}</p>{memoryActions(memory)}</div>
              </details>
            ))}
          </div>
        ) : <p className="memory-empty-state">还没有近期认识。聊到正在发生的事时，这里会慢慢出现。</p>}
        {allRecent.length > 6 ? <button className="recent-memory-more" onClick={() => setShowAllRecent((current) => !current)}>{showAllRecent ? "收起" : `查看全部 ${allRecent.length} 条`}</button> : null}
      </section>

      {panelError ? <p className="memory-panel-error" role="alert">{panelError}</p> : null}

      {summaryOpen ? (
        <MemoryDialog id="long-term-summary-title" title="关于你的长期认识" onClose={() => setSummaryOpen(false)}>
          <div className={`long-term-full long-term-full-${longTermSummary.state}`}><p>{longTermSummary.text}</p>{"note" in longTermSummary ? <small className="long-term-sync-note">{longTermSummary.note}</small> : null}</div>
        </MemoryDialog>
      ) : null}

      {managerOpen ? (
        <MemoryDialog id="memory-manager-title" title="管理具体认识" onClose={() => { setManagerOpen(false); setWithdrawTarget(null); }}>
          <p className="memory-manager-intro">这里列出当前生效的长期认识。需要改正时，知微会回到对话里听你重新说明。</p>
          {longTerm.length ? (
            <div className="managed-memory-list">
              {longTerm.map((memory) => (
                <article className="managed-memory-card" key={memory.versionId} data-version-id={memory.versionId}>
                  <header><span>{categoryLabel(memory.category)}</span><small>{formatMemoryDate(memory.createdAt)}</small></header>
                  <p>{memory.content}</p>
                  {memoryActions(memory, true)}
                </article>
              ))}
            </div>
          ) : <p className="memory-empty-state">还没有具体的长期认识。</p>}
          {panelError ? <p className="memory-panel-error" role="alert">{panelError}</p> : null}
        </MemoryDialog>
      ) : null}
    </aside>
  );
});

function MemoryDialog({ id, title, onClose, children }: { id: string; title: string; onClose: () => void; children: ReactNode }) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.showModal();
    return () => { if (dialog.open) dialog.close(); };
  }, []);
  return (
    <dialog ref={dialogRef} className="memory-dialog" aria-labelledby={id} onCancel={(event) => { event.preventDefault(); onClose(); }} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="memory-dialog-panel">
        <header><h2 id={id}>{title}</h2><button onClick={onClose} aria-label={`关闭${title}`}><X size={19} /></button></header>
        <div className="memory-dialog-scroll">{children}</div>
      </section>
    </dialog>
  );
}

const memoryDateFormatter = new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" });
function formatMemoryDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "近期";
  return memoryDateFormatter.format(date);
}
