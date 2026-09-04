"use client";

import { useEffect, useState } from "react";

export function WaitingReply({ phase, stage, startedAt }: { phase?: string; stage?: string; startedAt?: string }) {
  const searchStartedAt = stage === "search" && startedAt ? Date.parse(startedAt) : NaN;
  return (
    <span className="waiting-reply" role="status">
      <span className="typing" aria-hidden="true"><i /><i /><i /></span>
      {Number.isFinite(searchStartedAt)
        ? <SearchElapsed key={searchStartedAt} startedAt={searchStartedAt} />
        : <ReplyWait key={stage} phase={phase} />}
    </span>
  );
}

function SearchElapsed({ startedAt }: { startedAt: number }) {
  const elapsedSeconds = () => Math.max(0, Math.floor((Date.now() - startedAt) / 1_000));
  const [seconds, setSeconds] = useState(elapsedSeconds);
  useEffect(() => {
    const timer = setInterval(() => setSeconds(elapsedSeconds()), 1_000);
    return () => clearInterval(timer);
  }, [startedAt]);
  return <span>正在查找资料 · 已用 {seconds} 秒</span>;
}

function ReplyWait({ phase }: { phase?: string }) {
  const [delayStage, setDelayStage] = useState(0);
  useEffect(() => {
    const preparing = setTimeout(() => setDelayStage(1), 6_000);
    const longer = setTimeout(() => setDelayStage(2), 15_000);
    return () => { clearTimeout(preparing); clearTimeout(longer); };
  }, []);
  return <span>{delayStage === 2 ? "这次需要多一点时间，你可以继续等，也可以停止回复。" : phase ?? (delayStage === 1 ? "知微正在整理回应，再等一小会儿…" : "")}</span>;
}
