"use client";

import { ArrowRight, Check, Info, Sparkles } from "lucide-react";
import { useRef, useState } from "react";
import { shouldSubmitOnEnter } from "@/lib/keyboard";
import type { BootstrapData } from "@/lib/client-types";
import { Button } from "@/components/ui/button";
import { AccountPanel } from "./account-panel";

export function Onboarding({
  onboarding,
  onComplete,
  onAccountRestored,
}: {
  onboarding: BootstrapData["onboarding"];
  onComplete: () => Promise<void>;
  onAccountRestored: () => Promise<void>;
}) {
  const [current, setCurrent] = useState(onboarding);
  const [answer, setAnswer] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [showInfo, setShowInfo] = useState(current.answeredCount === 0);
  const [error, setError] = useState("");
  const composingRef = useRef(false);

  async function responseError(response: Response, fallback: string) {
    const payload = await response.json().catch(() => null);
    return typeof payload?.error === "string" && payload.error.trim() ? payload.error : fallback;
  }

  async function submit(value = answer) {
    if (!current.question || !value.trim() || submitting) return;
    setSubmitting(true);
    setError("");
    try {
      const response = await fetch("/api/onboarding/answer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ questionId: current.question.id, answer: value.trim() }),
      });
      if (!response.ok) throw new Error(await responseError(response, "这句话没有保存成功，请再试一次。"));
      const next = await response.json();
      setCurrent((previous) => ({ ...previous, ...next }));
      setAnswer("");
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : "这句话没有保存成功，请再试一次。");
    } finally {
      setSubmitting(false);
    }
  }

  async function complete() {
    if (submitting) return;
    setSubmitting(true);
    setError("");
    try {
      await onComplete();
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : "暂时无法开始聊天，请稍后再试。");
      setSubmitting(false);
    }
  }

  if (showInfo) {
    return (
      <main className="onboarding-shell">
        <section className="onboarding-card intro-card">
          <div className="brand-word">知微</div>
          <h1>先让我认识一下此刻的你</h1>
          <p className="intro-copy">
            不用一次说完，也没有标准答案。回答三题后就可以开始聊天，剩下的我们以后慢慢认识。
          </p>
          <div className="privacy-notes">
            <div><Sparkles size={18} /><span><strong>什么时候记住</strong>　知微会在后台分批整理具体、有用的新认识；你也可以明确告诉她记住或忘记。</span></div>
            <div><Check size={18} /><span><strong>什么时候使用</strong>　只在未来确实相关的对话里使用，不会塞入全部历史。</span></div>
            <div><Info size={18} /><span><strong>怎么修改</strong>　在右侧“关于你”中点选内容，回到聊天告诉知微新的说法；授权可在设置里直接关闭。</span></div>
          </div>
          <Button variant="primary" onClick={() => setShowInfo(false)}>
            开始认识 <ArrowRight size={17} />
          </Button>
          <AccountPanel restoreOnly onUpdated={onAccountRestored} />
        </section>
      </main>
    );
  }

  return (
    <main className="onboarding-shell">
      <section className="onboarding-card question-card">
        <header className="question-progress">
          <span>知微</span>
          <span>{Math.max(1, current.answeredCount + 1)} · 想答多少都可以</span>
        </header>
        <div className="progress-line"><span style={{ width: `${Math.min(100, (current.answeredCount / 3) * 100)}%` }} /></div>
        <h1>{current.question?.text ?? "已经认识了不少，要开始聊天吗？"}</h1>
        {current.question?.options?.length ? (
          <div className="option-chips">
            {current.question.options.map((option) => (
              <button key={option} onClick={() => void submit(option)} disabled={submitting}>
                {option}
              </button>
            ))}
          </div>
        ) : null}
        {current.question ? (
          <div className="onboarding-input-wrap">
            <textarea
              value={answer}
              onChange={(event) => setAnswer(event.target.value)}
              onCompositionStart={() => { composingRef.current = true; }}
              onCompositionEnd={() => { composingRef.current = false; }}
              onKeyDown={(event) => {
                if (shouldSubmitOnEnter(event, composingRef.current)) {
                  event.preventDefault();
                  void submit();
                }
              }}
              rows={3}
              autoFocus
              placeholder="按你舒服的方式说就好…"
            />
            <Button variant="primary" size="icon" onClick={() => void submit()} disabled={!answer.trim() || submitting} aria-label="提交回答">
              <ArrowRight size={18} />
            </Button>
          </div>
        ) : null}
        {error ? <p className="onboarding-error" role="alert">{error}</p> : null}
        <footer className="onboarding-footer">
          <span>{current.answeredCount < 3 ? `再回答 ${3 - current.answeredCount} 题即可开始聊天` : "已经可以开始聊天"}</span>
          {current.canFinish ? (
            <button className="text-button" onClick={() => void complete()} disabled={submitting}>
              {submitting ? "正在准备对话…" : "先聊到这里，开始聊天"}
            </button>
          ) : null}
        </footer>
      </section>
    </main>
  );
}
