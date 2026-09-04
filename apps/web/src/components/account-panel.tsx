"use client";

import { KeyRound, RotateCcw, ShieldCheck, X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";

export function AccountPanel({ account, disabled = false, restoreOnly = false, onUpdated }: {
  account?: { username: string } | null;
  disabled?: boolean;
  restoreOnly?: boolean;
  onUpdated: () => Promise<void>;
}) {
  const [mode, setMode] = useState<"bind" | "restore" | null>(null);
  const [notice, setNotice] = useState("");
  return (
    <section className={`account-panel ${restoreOnly ? "account-panel-compact" : ""}`} aria-label="账号与数据恢复">
      {!restoreOnly ? <>
        <h3><ShieldCheck size={17} />账号与数据</h3>
        <p>{account ? <>已绑定 <strong>{account.username}</strong>，之后的聊天会继续保存在此账号下。</> : "设置账号和密码，换设备时也能找回与知微的对话。"}</p>
      </> : null}
      <div className="account-actions">
        {!restoreOnly ? <button className="account-bind" disabled={disabled || Boolean(account)} onClick={(event) => { event.currentTarget.focus(); setNotice(""); setMode("bind"); }}><KeyRound size={16} />{account ? "已绑定账号" : "绑定账号"}</button> : null}
        <button disabled={disabled} onClick={(event) => { event.currentTarget.focus(); setNotice(""); setMode("restore"); }}><RotateCcw size={16} />恢复账号数据</button>
      </div>
      {disabled ? <small>请等当前回复结束后再操作。</small> : null}
      {notice ? <p role="status" className="account-notice">{notice}</p> : null}
      {mode ? <AccountDialog mode={mode} onClose={() => setMode(null)} onSuccess={async () => {
        setNotice(mode === "bind" ? "账号已绑定，请妥善保存账号和密码。" : "账号数据已恢复，当前游客聊天已完整保留。");
        setMode(null);
        await onUpdated();
      }} /> : null}
    </section>
  );
}

function AccountDialog({ mode, onClose, onSuccess }: {
  mode: "bind" | "restore";
  onClose: () => void;
  onSuccess: () => Promise<void>;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const submittingRef = useRef(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const binding = mode === "bind";
  const title = binding ? "绑定账号" : "恢复账号数据";
  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    dialog?.querySelector<HTMLInputElement>("#account-username")?.focus();
    return () => dialog?.close();
  }, []);

  function close() {
    // Close before unmounting so the native dialog can restore focus to its trigger.
    dialogRef.current?.close();
    onClose();
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submittingRef.current) return;
    setError("");
    if (binding && password !== confirmation) { setError("两次输入的密码不一致，请重新确认。"); return; }
    submittingRef.current = true;
    setBusy(true);
    try {
      const response = await fetch(`/api/account/${mode}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "账号操作暂时没有完成，请重试。");
      setPassword("");
      setConfirmation("");
      const channel = new BroadcastChannel("zhiwei-account");
      channel.postMessage("updated");
      channel.close();
      await onSuccess();
    } catch (cause) {
      setError(cause instanceof Error && !/fetch|JSON|network/i.test(cause.message) ? cause.message : "网络连接中断，请重试。原有聊天不会被清除。");
    } finally { submittingRef.current = false; setBusy(false); }
  }

  return <dialog ref={dialogRef} className="memory-dialog account-dialog" aria-labelledby="account-dialog-title" onCancel={(event) => { event.preventDefault(); if (!busy) close(); }} onClick={(event) => { if (!busy && event.target === event.currentTarget) close(); }}>
    <section className="memory-dialog-panel">
      <header><h2 id="account-dialog-title">{title}</h2><button disabled={busy} onClick={close} aria-label={`关闭${title}`}><X size={19} /></button></header>
      <div className="memory-dialog-scroll">
        <p className="account-explanation">{binding ? "绑定后，当前对话、记忆和画像都归入这个账号。以后在新设备输入账号和密码，就能恢复。" : "验证后，历史会话、记忆和画像会加入当前空间；正在聊的游客对话和原消息完整保留，不会被覆盖或拼接。恢复也会将当前游客数据纳入这个账号。"}</p>
        {!binding ? <p className="account-explanation">任一侧已关闭的授权保持关闭，可稍后在设置中调整。画像会重新整理，相处方式先沿用原账号；合并后不提供拆分入口。</p> : null}
        <form onSubmit={(event) => void submit(event)} className="account-form">
          <label htmlFor="account-username">账号</label>
          <input id="account-username" name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} minLength={3} maxLength={32} required disabled={busy} value={username} onChange={(event) => setUsername(event.target.value)} aria-describedby="account-username-hint" />
          <small id="account-username-hint">3–32 位中文、字母、数字、下划线或短横线；英文字母不区分大小写。</small>
          <label htmlFor="account-password">密码</label>
          <input id="account-password" name="password" type="password" autoComplete={binding ? "new-password" : "current-password"} minLength={10} maxLength={128} required disabled={busy} value={password} onChange={(event) => setPassword(event.target.value)} aria-describedby="account-password-hint" />
          <small id="account-password-hint">10–128 位，请使用与其他网站不同的密码。</small>
          {binding ? <><label htmlFor="account-confirmation">确认密码</label><input id="account-confirmation" name="password-confirmation" type="password" autoComplete="new-password" minLength={10} maxLength={128} required disabled={busy} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></> : null}
          <p className="account-password-note">暂不提供忘记密码找回，请妥善保存。密码不会发给知微或用于生成记忆。</p>
          {error ? <p className="account-error" role="alert">{error}</p> : null}
          <button className="account-submit" type="submit" disabled={busy}>{busy ? (binding ? "正在绑定…" : "正在恢复…") : (binding ? "确认绑定" : "恢复并保留游客聊天")}</button>
        </form>
      </div>
    </section>
  </dialog>;
}
