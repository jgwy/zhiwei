"use client";

import {
  ArrowUp,
  Check,
  ChevronLeft,
  ChevronRight,
  Clipboard,
  Code2,
  Menu,
  MessageCircleMore,
  MoreHorizontal,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  RotateCcw,
  Square,
  ThumbsDown,
  ThumbsUp,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatMessage } from "@zhiwei/core/client";
import type { BootstrapData, ConversationView } from "@/lib/client-types";
import { readSseStream, formatTime } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Onboarding } from "@/components/onboarding";
import { InsightPanel } from "@/components/insight-panel";
import { DeveloperPanel } from "@/components/developer-panel";

export function ZhiweiApp() {
  const [data, setData] = useState<BootstrapData | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [insightOpen, setInsightOpen] = useState(true);
  const [mobileMenu, setMobileMenu] = useState<"conversations" | "insights" | null>(null);
  const [developerMode, setDeveloperMode] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [receipts, setReceipts] = useState<Record<string, { count: number; open: boolean }>>({});
  const abortRef = useRef<AbortController | null>(null);
  const messageEndRef = useRef<HTMLDivElement | null>(null);
  const dataRef = useRef<BootstrapData | null>(null);
  const activeIdRef = useRef<string | null>(null);

  async function load() {
    const response = await fetch("/api/bootstrap", { cache: "no-store" });
    if (!response.ok) throw new Error("知微没有成功启动，请稍后重试。 ");
    const next = (await response.json()) as BootstrapData;
    setData(next);
    setActiveId((current) => current ?? next.conversations[0]?.id ?? null);
  }

  useEffect(() => { void load(); }, []);
  useEffect(() => { dataRef.current = data; }, [data]);
  useEffect(() => { activeIdRef.current = activeId; }, [activeId]);
  useEffect(() => { messageEndRef.current?.scrollIntoView({ behavior: streaming ? "auto" : "smooth" }); }, [data, streaming]);
  useEffect(() => {
    if (!data?.onboarding.complete || process.env.NEXT_PUBLIC_ACTIVITY_STREAM === "false") return;
    const source = new EventSource("/api/activity/stream");
    source.addEventListener("memory.updated", (raw) => {
      const event = JSON.parse((raw as MessageEvent).data);
      const active = dataRef.current?.conversations.find(
        (item) => item.id === activeIdRef.current,
      );
      const lastAssistant = [...(active?.messages ?? [])].reverse().find((message) => message.role === "assistant");
      if (lastAssistant && event.payload.memoryCount > 0) {
        setReceipts((current) => ({ ...current, [lastAssistant.id]: { count: event.payload.memoryCount, open: false } }));
      }
      void load();
    });
    source.addEventListener("skill.evolved", (raw) => {
      const event = JSON.parse((raw as MessageEvent).data);
      setToast(event.payload.message ?? "知微又更了解你一点。");
      window.setTimeout(() => setToast(null), 3_500);
      void load();
    });
    return () => source.close();
  }, [data?.onboarding.complete]);

  const active = useMemo(
    () => data?.conversations.find((conversation) => conversation.id === activeId) ?? null,
    [data, activeId],
  );

  if (!data) return <div className="app-loading"><div className="loading-mark">知微</div><span>正在准备一段安静的对话…</span></div>;
  if (!data.onboarding.complete) return <Onboarding onboarding={data.onboarding} onComplete={async () => { await fetch("/api/onboarding/complete", { method: "POST" }); await load(); }} />;
  if (developerMode) return <DeveloperPanel onClose={() => setDeveloperMode(false)} />;

  async function createConversation() {
    const response = await fetch("/api/conversations", { method: "POST" });
    const result = await response.json();
    await load();
    setActiveId(result.conversation.id);
    setMobileMenu(null);
  }

  async function sendMessage(content = input) {
    const text = content.trim();
    if (!text || streaming) return;
    let conversationId = activeId;
    if (!conversationId) {
      const created = await fetch("/api/conversations", { method: "POST" }).then((response) => response.json());
      conversationId = created.conversation.id;
      setActiveId(conversationId);
    }
    if (!conversationId) throw new Error("无法创建新的对话");
    const userMessage: ChatMessage = { id: crypto.randomUUID(), role: "user", content: text, createdAt: new Date().toISOString() };
    const assistantTemp: ChatMessage = { id: crypto.randomUUID(), role: "assistant", content: "", createdAt: new Date().toISOString(), metadata: { streaming: true } };
    updateConversationMessages(conversationId, (messages) => [...messages, userMessage, assistantTemp]);
    setInput("");
    setStreaming(true);
    const abort = new AbortController();
    abortRef.current = abort;
    try {
      const response = await fetch(`/api/conversations/${conversationId}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: text }),
        signal: abort.signal,
      });
      if (!response.ok) throw new Error("这句话没能送达，请再试一次。 ");
      await readSseStream(response, (event) => {
        if (event.type === "message.started") {
          updateConversationMessages(conversationId!, (messages) => messages.map((message) => message.id === assistantTemp.id ? { ...message, id: event.messageId, metadata: { traceId: event.traceId, streaming: true } } : message));
          assistantTemp.id = event.messageId;
        }
        if (event.type === "text.delta") {
          updateConversationMessages(conversationId!, (messages) => messages.map((message) => message.id === assistantTemp.id ? { ...message, content: message.content + event.delta } : message));
        }
        if (event.type === "message.completed") {
          updateConversationMessages(conversationId!, (messages) => messages.map((message) => message.id === event.messageId ? { ...message, metadata: { ...message.metadata, streaming: false } } : message));
        }
        if (event.type === "error") throw new Error(event.message);
      });
      window.setTimeout(() => void load(), 500);
    } catch (error) {
      if (!abort.signal.aborted) setToast(error instanceof Error ? error.message : "回复中断了");
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }

  function updateConversationMessages(conversationId: string, updater: (messages: ChatMessage[]) => ChatMessage[]) {
    setData((current) => current ? { ...current, conversations: current.conversations.map((conversation) => conversation.id === conversationId ? { ...conversation, messages: updater(conversation.messages) } : conversation) } : current);
  }

  async function feedback(messageId: string, value: "understood" | "not-me", reason?: string) {
    await fetch("/api/feedback", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messageId, value, reason }) });
    setToast(value === "understood" ? "我记住这种相处方式了。" : "谢谢你纠正我，我会重新调整。 ");
    window.setTimeout(() => setToast(null), 2_800);
  }

  async function updateSettings(settings: Record<string, boolean>) {
    await fetch("/api/settings", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(settings) });
    setData((current) => current ? { ...current, user: { ...current.user, settings: { ...current.user.settings, ...settings } } } : current);
  }

  async function withdrawMemory(memoryId: string) {
    const response = await fetch(`/api/memories/${memoryId}/withdraw`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "用户在画像界面主动撤回" }),
    });
    if (!response.ok) throw new Error("这条记忆没有撤回成功");
    setToast("这条认识已撤回，之后不会再用于回答。");
    await load();
  }

  async function deleteAllData(confirmation: string) {
    const response = await fetch("/api/user/data", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmation }),
    });
    if (!response.ok) throw new Error("数据删除没有完成");
    window.location.reload();
  }

  function startMemoryCorrection(content: string) {
    setInput(`我想修正你对我的这条认识：“${content}”。新的说法是：`);
    setMobileMenu(null);
    window.setTimeout(() => document.querySelector<HTMLTextAreaElement>(".chat-composer textarea")?.focus(), 50);
  }

  return (
    <main className={insightOpen ? "app-shell" : "app-shell insight-closed"}>
      <aside className={`conversation-sidebar ${mobileMenu === "conversations" ? "mobile-open" : ""}`}>
        <div className="sidebar-brand"><span>知微</span><button className="mobile-close" onClick={() => setMobileMenu(null)}><X size={18} /></button></div>
        <Button variant="secondary" className="new-chat-button" onClick={() => void createConversation()}><Plus size={17} /> 新的对话</Button>
        <nav className="conversation-list">
          {data.conversations.map((conversation) => <button key={conversation.id} className={conversation.id === activeId ? "active" : ""} onClick={() => { setActiveId(conversation.id); setMobileMenu(null); }}><MessageCircleMore size={16} /><span>{conversation.title}</span><MoreHorizontal size={15} /></button>)}
        </nav>
        <div className="sidebar-footer">
          {data.developerModeAvailable ? <button onClick={() => setDeveloperMode(true)}><Code2 size={16} /><span>开发者模式</span></button> : null}
          <div className="adapter-badge"><i />{data.adapter === "scripted" ? "仿真模式" : data.adapter}</div>
        </div>
      </aside>

      <section className="chat-column">
        <header className="chat-header">
          <button className="mobile-nav-button" onClick={() => setMobileMenu("conversations")}><Menu size={19} /></button>
          <div><strong>{active?.title ?? "新的对话"}</strong><span>知微会记住真正重要的部分</span></div>
          <button className="insight-toggle" onClick={() => { if (window.innerWidth < 900) setMobileMenu("insights"); else setInsightOpen(!insightOpen); }} aria-label="打开或收起洞察栏">{insightOpen ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}</button>
        </header>

        <div className="message-scroll">
          {data.returnNote ? <button className="return-note" onClick={() => setInput(data.returnNote!.content)}><span>上次说到这里</span><p>{data.returnNote.content}</p><ChevronRight size={17} /></button> : null}
          {!active?.messages.length ? (
            <div className="empty-conversation"><div className="empty-word">知微</div><h1>现在，你想从哪里聊起？</h1><p>可以是一件具体的事，也可以只是此刻说不清楚的心情。</p><div>{["最近脑子有点乱", "我有件事拿不定主意", "只是想找个人说说话"].map((prompt) => <button key={prompt} onClick={() => setInput(prompt)}>{prompt}</button>)}</div></div>
          ) : (
            <div className="messages">
              {active.messages.map((message, index) => (
                <Message
                  key={message.id}
                  message={message}
                  receipt={receipts[message.id]}
                  onToggleReceipt={() => setReceipts((current) => {
                    const existing = current[message.id];
                    return existing
                      ? { ...current, [message.id]: { ...existing, open: !existing.open } }
                      : current;
                  })}
                  onFeedback={feedback}
                  onRetry={message.role === "assistant" ? () => { const previous = [...active.messages.slice(0, index)].reverse().find((item) => item.role === "user"); if (previous) void sendMessage(previous.content); } : undefined}
                />
              ))}
              <div ref={messageEndRef} />
            </div>
          )}
        </div>

        <div className="composer-wrap">
          <div className="chat-composer">
            <textarea value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void sendMessage(); } }} rows={1} placeholder="和知微说点什么…" aria-label="消息内容" />
            {streaming ? <Button size="icon" variant="primary" onClick={() => abortRef.current?.abort()} aria-label="停止回复"><Square size={15} fill="currentColor" /></Button> : <Button size="icon" variant="primary" onClick={() => void sendMessage()} disabled={!input.trim()} aria-label="发送消息"><ArrowUp size={18} /></Button>}
          </div>
          <small>Enter 发送 · Shift + Enter 换行</small>
        </div>
      </section>

      <div className={`insight-drawer ${mobileMenu === "insights" ? "mobile-open" : ""}`}>
        <button className="mobile-insight-close" onClick={() => setMobileMenu(null)}><ChevronLeft size={18} /> 返回对话</button>
        <InsightPanel
          data={data}
          onMemoryClick={startMemoryCorrection}
          onSettings={(settings) => void updateSettings(settings)}
          onWithdraw={(memoryId) => void withdrawMemory(memoryId)}
          onDeleteAll={(confirmation) => void deleteAllData(confirmation)}
        />
      </div>
      {mobileMenu ? <button className="mobile-scrim" onClick={() => setMobileMenu(null)} aria-label="关闭面板" /> : null}
      {toast ? <div className="toast"><Check size={16} />{toast}</div> : null}
    </main>
  );
}

function Message({ message, receipt, onToggleReceipt, onFeedback, onRetry }: { message: ChatMessage; receipt?: { count: number; open: boolean }; onToggleReceipt: () => void; onFeedback: (id: string, value: "understood" | "not-me", reason?: string) => Promise<void>; onRetry?: () => void }) {
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const assistant = message.role === "assistant";
  return (
    <article className={assistant ? "message assistant" : "message user"}>
      <div className="message-content">{message.content || (message.metadata?.streaming ? <span className="typing"><i /><i /><i /></span> : null)}</div>
      <footer>
        <time>{formatTime(message.createdAt)}</time>
        {assistant && message.content ? <div className="message-actions"><button onClick={() => navigator.clipboard.writeText(message.content)} aria-label="复制"><Clipboard size={14} /></button><button onClick={() => void onFeedback(message.id, "understood")} aria-label="有被懂到"><ThumbsUp size={14} /></button><button onClick={() => setFeedbackOpen(!feedbackOpen)} aria-label="不太像我"><ThumbsDown size={14} /></button>{onRetry ? <button onClick={onRetry} aria-label="重试"><RotateCcw size={14} /></button> : null}</div> : null}
      </footer>
      {feedbackOpen ? <div className="feedback-reasons"><span>哪里不太像你？</span>{["语气不对", "记错了", "建议不贴合", "太像模板"].map((reason) => <button key={reason} onClick={() => { void onFeedback(message.id, "not-me", reason); setFeedbackOpen(false); }}>{reason}</button>)}</div> : null}
      {assistant && receipt ? <button className="memory-receipt" onClick={onToggleReceipt}><SparkleDot />知微更新了 {receipt.count} 条认识 <ChevronRight size={13} className={receipt.open ? "rotated" : ""} /></button> : null}
      {assistant && receipt?.open ? <div className="receipt-detail">这些认识已经进入“关于你”，会在以后相关的对话中使用。若有不对，点开画像里的对应内容告诉我新的说法。</div> : null}
    </article>
  );
}

function SparkleDot() { return <span className="sparkle-dot" />; }
