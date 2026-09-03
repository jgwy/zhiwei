"use client";

import {
  ArrowUp,
  ArrowDown,
  Check,
  ChevronLeft,
  ChevronRight,
  Clipboard,
  Code2,
  Info,
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
import { isNearChatBottom } from "@/lib/chat-scroll";
import { Button } from "@/components/ui/button";
import { Onboarding } from "@/components/onboarding";
import { InsightPanel } from "@/components/insight-panel";
import { DeveloperPanel } from "@/components/developer-panel";

export function ZhiweiApp() {
  const [data, setData] = useState<BootstrapData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [insightOpen, setInsightOpen] = useState(true);
  const [mobileMenu, setMobileMenu] = useState<"conversations" | "insights" | null>(null);
  const [developerMode, setDeveloperMode] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [toastFading, setToastFading] = useState(false);
  const [receipts, setReceipts] = useState<Record<string, { count: number; open: boolean }>>({});
  const abortRef = useRef<AbortController | null>(null);
  const messageEndRef = useRef<HTMLDivElement | null>(null);
  const messageScrollRef = useRef<HTMLDivElement | null>(null);
  const aboutTriggerRef = useRef<HTMLButtonElement | null>(null);
  const mobileNavRef = useRef<HTMLButtonElement | null>(null);
  const followLatestRef = useRef(true);
  const forceScrollRef = useRef(false);
  const lastScrolledConversationRef = useRef<string | null>(null);
  const dataRef = useRef<BootstrapData | null>(null);
  const activeIdRef = useRef<string | null>(null);
  const pendingAssistantRef = useRef<{ conversationId: string; messageId: string } | null>(null);
  const toastTimerRef = useRef<number | null>(null);

  function showToast(message: string, duration = 3_500) {
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
    setToastFading(false);
    setToast(message);
    toastTimerRef.current = window.setTimeout(() => {
      setToastFading(true);
      toastTimerRef.current = window.setTimeout(() => {
        toastTimerRef.current = null;
        setToast(null);
        setToastFading(false);
      }, 240);
    }, Math.max(0, duration - 240));
  }

  useEffect(() => () => {
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
  }, []);

  async function load() {
    try {
      const response = await fetch("/api/bootstrap", { cache: "no-store" });
      if (!response.ok) throw new Error(await responseMessage(response, "知微没有成功启动，请稍后重试。"));
      const next = (await response.json()) as BootstrapData;
      setData((current) => {
        const pending = pendingAssistantRef.current;
        if (!current || !pending) return next;
        const currentConversation = current.conversations.find((conversation) => conversation.id === pending.conversationId);
        const pendingMessage = currentConversation?.messages.find((message) => message.id === pending.messageId)
          ?? currentConversation?.messages.find((message) => message.metadata?.streaming === true);
        const loadedConversation = next.conversations.find((conversation) => conversation.id === pending.conversationId);
        if (!pendingMessage || !loadedConversation) return next;
        const messages = loadedConversation.messages.some((message) => message.id === pendingMessage.id)
          ? loadedConversation.messages
          : [...loadedConversation.messages, pendingMessage];
        return {
          ...next,
          conversations: next.conversations.map((conversation) => conversation.id === pending.conversationId
            ? { ...conversation, messages }
            : conversation),
        };
      });
      setLoadError(null);
      setActiveId((current) => current ?? next.conversations[0]?.id ?? null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "知微没有成功启动，请稍后重试。");
    }
  }

  useEffect(() => { void load(); }, []);
  useEffect(() => { dataRef.current = data; }, [data]);
  useEffect(() => { activeIdRef.current = activeId; }, [activeId]);
  useEffect(() => {
    const pending = pendingAssistantRef.current;
    if (pending && pending.conversationId !== activeId) stopStreamingReply();
  }, [activeId]);
  const active = useMemo(
    () => data?.conversations.find((conversation) => conversation.id === activeId) ?? null,
    [data, activeId],
  );
  const lastMessage = active?.messages.at(-1);
  const messageScrollSignal = `${activeId ?? "none"}:${active?.messages.length ?? 0}:${lastMessage?.id ?? "none"}:${lastMessage?.content.length ?? 0}:${lastMessage?.metadata?.status ?? ""}`;

  useEffect(() => {
    const conversationChanged = lastScrolledConversationRef.current !== activeId;
    if (!conversationChanged && !forceScrollRef.current && !followLatestRef.current) return;

    lastScrolledConversationRef.current = activeId;
    forceScrollRef.current = false;
    const frame = window.requestAnimationFrame(() => {
      const container = messageScrollRef.current;
      if (!container) return;
      container.scrollTop = container.scrollHeight;
      followLatestRef.current = true;
      setShowJumpToLatest(false);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeId, messageScrollSignal]);
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
      showToast(event.payload.message ?? "知微又更了解你一点。");
      void load();
    });
    source.addEventListener("conversation.title.updated", (raw) => {
      const event = JSON.parse((raw as MessageEvent).data);
      setData((current) => current ? {
        ...current,
        conversations: current.conversations.map((conversation) => conversation.id === event.payload.conversationId
          ? { ...conversation, title: event.payload.title, titleSource: "model" }
          : conversation),
      } : current);
    });
    return () => source.close();
  }, [data?.onboarding.complete]);

  if (!data) return <div className="app-loading"><div className="loading-mark">知微</div><span>{loadError ?? "正在准备一段安静的对话…"}</span>{loadError ? <button onClick={() => void load()}>重新加载</button> : null}</div>;
  if (!data.onboarding.complete) return <Onboarding onboarding={data.onboarding} onComplete={async () => { await fetch("/api/onboarding/complete", { method: "POST" }); await load(); }} />;
  if (developerMode) return <DeveloperPanel onClose={() => setDeveloperMode(false)} />;

  async function createConversation() {
    const response = await fetch("/api/conversations", { method: "POST" });
    if (!response.ok) throw new Error(await responseMessage(response, "新的对话没有创建成功，请重试。"));
    const result = await response.json();
    await load();
    setActiveId(result.conversation.id);
    setMobileMenu(null);
  }

  async function renameConversation(conversation: ConversationView) {
    const title = window.prompt("给这段对话起个名字", conversation.title)?.trim();
    if (!title || title === conversation.title) return;
    const response = await fetch(`/api/conversations/${conversation.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title }),
    });
    if (!response.ok) {
      showToast(await responseMessage(response, "标题没有修改成功，请重试。"));
      return;
    }
    setData((current) => current ? { ...current, conversations: current.conversations.map((item) => item.id === conversation.id ? { ...item, title, titleSource: "manual", titleLocked: true } : item) } : current);
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
    pendingAssistantRef.current = { conversationId, messageId: assistantTemp.id };
    followLatestRef.current = true;
    forceScrollRef.current = true;
    setShowJumpToLatest(false);
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
      if (!response.ok) throw new Error(await responseMessage(response, "这句话没能送达，请再试一次。"));
      await readSseStream(response, (event) => {
        if (event.type === "message.started") {
          updateConversationMessages(conversationId!, (messages) => messages.map((message) => message.id === assistantTemp.id ? { ...message, id: event.messageId, metadata: { traceId: event.traceId, streaming: true } } : message));
          assistantTemp.id = event.messageId;
          pendingAssistantRef.current = { conversationId: conversationId!, messageId: event.messageId };
        }
        if (event.type === "text.delta") {
          updateConversationMessages(conversationId!, (messages) => messages.map((message) => message.id === assistantTemp.id ? { ...message, content: message.content + event.delta } : message));
        }
        if (event.type === "tool.started") {
          updateConversationMessages(conversationId!, (messages) => messages.map((message) => message.id === assistantTemp.id ? {
            ...message,
            metadata: { ...message.metadata, activeTool: event.name, toolStartedAt: Date.now() },
          } : message));
        }
        if (event.type === "tool.completed") {
          updateConversationMessages(conversationId!, (messages) => messages.map((message) => message.id === assistantTemp.id && message.metadata?.activeTool === event.name ? {
            ...message,
            metadata: { ...message.metadata, activeTool: null, toolStartedAt: null },
          } : message));
        }
        if (event.type === "message.completed") {
          updateConversationMessages(conversationId!, (messages) => messages.map((message) => message.id === event.messageId ? { ...message, metadata: { ...message.metadata, streaming: false, status: "completed", activeTool: null, toolStartedAt: null, sources: event.sources ?? [] } } : message));
          pendingAssistantRef.current = null;
        }
        if (event.type === "error") {
          updateConversationMessages(conversationId!, (messages) => messages.map((message) => message.id === assistantTemp.id ? { ...message, metadata: { ...message.metadata, streaming: false, status: abort.signal.aborted ? "stopped" : "interrupted", activeTool: null, toolStartedAt: null } } : message));
          throw new Error(event.message);
        }
      });
      window.setTimeout(() => void load(), 500);
    } catch (error) {
      if (!abort.signal.aborted) showToast(error instanceof Error ? error.message : "回复中断了，可以重试。");
    } finally {
      if (pendingAssistantRef.current?.conversationId === conversationId) {
        settlePendingAssistant(abort.signal.aborted ? "stopped" : "interrupted");
      }
      setStreaming(false);
      abortRef.current = null;
    }
  }

  function settlePendingAssistant(status: "stopped" | "interrupted") {
    const pending = pendingAssistantRef.current;
    if (!pending) return;
    updateConversationMessages(pending.conversationId, (messages) => messages.flatMap((message) => {
      if (message.id !== pending.messageId) return [message];
      if (!message.content) return [];
      return [{ ...message, metadata: { ...message.metadata, streaming: false, status, activeTool: null, toolStartedAt: null } }];
    }));
    pendingAssistantRef.current = null;
  }

  function stopStreamingReply() {
    abortRef.current?.abort();
    settlePendingAssistant("stopped");
    setStreaming(false);
  }

  function updateConversationMessages(conversationId: string, updater: (messages: ChatMessage[]) => ChatMessage[]) {
    setData((current) => current ? { ...current, conversations: current.conversations.map((conversation) => conversation.id === conversationId ? { ...conversation, messages: updater(conversation.messages) } : conversation) } : current);
  }

  async function feedback(messageId: string, value: "understood" | "not-me", reason?: string) {
    const response = await fetch("/api/feedback", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messageId, value, reason }) });
    if (!response.ok) throw new Error(await responseMessage(response, "这次反馈没有保存成功，请重试。"));
    showToast(value === "understood" ? "我记住这种相处方式了。" : "谢谢你纠正我，我会重新调整。", 2_800);
  }

  async function updateSettings(settings: Record<string, boolean>) {
    const response = await fetch("/api/settings", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(settings) });
    if (!response.ok) throw new Error(await responseMessage(response, "设置没有保存成功，请重试。"));
    setData((current) => current ? { ...current, user: { ...current.user, settings: { ...current.user.settings, ...settings } } } : current);
  }

  async function withdrawMemory(memoryId: string) {
    if (!window.confirm("撤回后，知微将不再使用这条认识。确定撤回吗？")) return;
    const response = await fetch(`/api/memories/${memoryId}/withdraw`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "用户在画像界面主动撤回" }),
    });
    if (!response.ok) throw new Error(await responseMessage(response, "这条认识没有撤回成功，请重试。"));
    showToast("这条认识已撤回，之后不会再用于回答。");
    await load();
  }

  async function updateMemory(memoryId: string, input: { content: string; category?: string; tier?: "short" | "long" }) {
    const response = await fetch(`/api/memories/${memoryId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!response.ok) throw new Error(await responseMessage(response, "这条认识没有修改成功，请重试。"));
    showToast("这条认识已更新，并标记为你确认的内容。");
    await load();
  }

  async function confirmMemory(memoryId: string) {
    const response = await fetch(`/api/memories/${memoryId}/confirm`, { method: "POST" });
    if (!response.ok) throw new Error(await responseMessage(response, "这条认识没有确认成功，请重试。"));
    showToast("已确认这条认识，之后会更稳定地用于回答。");
    await load();
  }

  async function deleteAllData(confirmation: string) {
    const response = await fetch("/api/user/data", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmation }),
    });
    if (!response.ok) throw new Error(await responseMessage(response, "数据删除没有完成；你的数据仍然保留。"));
    window.location.reload();
  }

  function startMemoryCorrection(content: string) {
    setInput(`我想修正你对我的这条认识：“${content}”。新的说法是：`);
    setMobileMenu(null);
    window.setTimeout(() => document.querySelector<HTMLTextAreaElement>(".chat-composer textarea")?.focus(), 50);
  }

  function handleMessageScroll() {
    const container = messageScrollRef.current;
    if (!container) return;
    const nearBottom = isNearChatBottom(container);
    followLatestRef.current = nearBottom;
    setShowJumpToLatest(!nearBottom);
  }

  function scrollToLatest() {
    const container = messageScrollRef.current;
    followLatestRef.current = true;
    forceScrollRef.current = false;
    setShowJumpToLatest(false);
    container?.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
  }

  function openAbout() {
    setMobileMenu(null);
    setAboutOpen(true);
  }

  function closeAbout() {
    setAboutOpen(false);
    window.requestAnimationFrame(() => {
      const returnTarget = window.innerWidth < 900 ? mobileNavRef.current : aboutTriggerRef.current;
      returnTarget?.focus();
    });
  }

  return (
    <main className={insightOpen ? "app-shell" : "app-shell insight-closed"}>
      <aside className={`conversation-sidebar ${mobileMenu === "conversations" ? "mobile-open" : ""}`}>
        <div className="sidebar-brand"><span>知微</span><button className="mobile-close" onClick={() => setMobileMenu(null)}><X size={18} /></button></div>
        <Button variant="secondary" className="new-chat-button" onClick={() => void createConversation()}><Plus size={17} /> 新的对话</Button>
        <nav className="conversation-list">
          {data.conversations.map((conversation) => <div className={conversation.id === activeId ? "conversation-row active" : "conversation-row"} key={conversation.id}><button className="conversation-open" onClick={() => { setActiveId(conversation.id); setMobileMenu(null); }}><MessageCircleMore size={16} /><span>{conversation.title}</span></button><button className="conversation-more" onClick={() => void renameConversation(conversation)} aria-label={`修改对话标题：${conversation.title}`}><MoreHorizontal size={15} /></button></div>)}
        </nav>
        <div className="sidebar-footer">
          <button ref={aboutTriggerRef} onClick={openAbout}><Info size={16} /><span>关于</span></button>
          {data.developerModeAvailable ? <button onClick={() => setDeveloperMode(true)}><Code2 size={16} /><span>开发者模式</span></button> : null}
          <div className="adapter-badge"><i />{data.modelModeLabel}</div>
        </div>
      </aside>

      <section className="chat-column">
        <header className="chat-header">
          <button ref={mobileNavRef} className="mobile-nav-button" onClick={() => setMobileMenu("conversations")}><Menu size={19} /></button>
          <div><strong>{active?.title ?? "新的对话"}</strong><span>相关的认识，会在你的授权下用于之后的对话</span></div>
          <button className="insight-toggle" onClick={() => { if (window.innerWidth < 900) setMobileMenu("insights"); else setInsightOpen(!insightOpen); }} aria-label="打开或收起洞察栏">{insightOpen ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}</button>
        </header>

        <div className="message-scroll" ref={messageScrollRef} onScroll={handleMessageScroll}>
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

        {showJumpToLatest ? <button className="jump-to-latest" onClick={scrollToLatest}><ArrowDown size={15} /><span>回到最新</span></button> : null}

        <div className="composer-wrap">
          <div className="chat-composer">
            <textarea value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void sendMessage(); } }} rows={1} placeholder="和知微说点什么…" aria-label="消息内容" />
            {streaming ? <Button size="icon" variant="primary" onClick={stopStreamingReply} aria-label="停止回复"><Square size={15} fill="currentColor" /></Button> : <Button size="icon" variant="primary" onClick={() => void sendMessage()} disabled={!input.trim()} aria-label="发送消息"><ArrowUp size={18} /></Button>}
          </div>
          <small>按 Enter 发送 · 按 Shift + Enter 换行</small>
        </div>
      </section>

      <div className={`insight-drawer ${mobileMenu === "insights" ? "mobile-open" : ""}`}>
        <button className="mobile-insight-close" onClick={() => setMobileMenu(null)}><ChevronLeft size={18} /> 返回对话</button>
        <InsightPanel
          data={data}
          onMemoryClick={startMemoryCorrection}
          onMemoryUpdate={updateMemory}
          onMemoryConfirm={confirmMemory}
          onSettings={(settings) => void updateSettings(settings)}
          onWithdraw={(memoryId) => void withdrawMemory(memoryId)}
          onDeleteAll={(confirmation) => void deleteAllData(confirmation)}
        />
      </div>
      {mobileMenu ? <button className="mobile-scrim" onClick={() => setMobileMenu(null)} aria-label="关闭面板" /> : null}
      {aboutOpen ? <AboutDialog onClose={closeAbout} /> : null}
      {toast ? <div className={`toast${toastFading ? " toast-fading" : ""}`} aria-live="polite"><Check size={16} />{toast}</div> : null}
    </main>
  );
}

const ABOUT_LOGOS = [
  { src: "/about/seu-emblem.png", alt: "东南大学校徽", kind: "round" },
  { src: "/about/seu-chem.png", alt: "东南大学化学化工学院院徽", kind: "round" },
  { src: "/about/seu-cs.png", alt: "东南大学计算机学院院徽", kind: "cs" },
  { src: "/about/seu-science-park.png", alt: "东南大学国家大学科技园", kind: "park" },
  { src: "/about/aliyun-cloud.png", alt: "阿里云", kind: "wordmark" },
] as const;

const PROJECT_MEMBERS = [
  { name: "刘欣颖", university: "东南大学" },
  { name: "李煜", university: "东南大学" },
  { name: "许益嘉", university: "东南大学" },
  { name: "孙浩宸", university: "东南大学" },
  { name: "沈嘉栩", university: "东南大学" },
  { name: "刘一民", university: "华中科技大学" },
  { name: "张子阅", university: "东南大学" },
  { name: "胡鼎", university: "东南大学" },
] as const;

function AboutDialog({ onClose }: { onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className="about-dialog"
      aria-labelledby="about-title"
      aria-describedby="about-description"
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <article className="about-dialog-panel">
        <header className="about-dialog-toolbar">
          <span>关于知微</span>
          <button onClick={onClose} aria-label="关闭关于知微"><X size={19} /></button>
        </header>

        <div className="about-dialog-scroll">
          <div className="about-logo-strip" role="group" aria-label="项目相关单位标识">
            {ABOUT_LOGOS.map((logo) => (
              <div className={`about-logo about-logo-${logo.kind}`} key={logo.src}>
                <img src={logo.src} alt={logo.alt} />
              </div>
            ))}
          </div>

          <div className="about-hero">
            <h2 id="about-title">知微</h2>
            <p>真切地陪伴你的数字分身</p>
          </div>

          <section className="about-project">
            <h3>项目简介</h3>
            <p id="about-description">知微是一款面向长期陪伴场景的数字分身应用。它以对话为入口，在用户可知、可控、可撤回的前提下，持续理解个人经历、偏好与情绪变化，将分散的信息沉淀为可追溯、可演化的长期记忆，并据此提供连贯、自然、有温度的个性化回应。项目融合大模型、多层记忆与技能演化机制，致力于让人工智能从“回答一次问题”走向“长期理解一个人”，探索可信、可持续的人机陪伴新形态。</p>
          </section>

          <div className="about-team">
            <section>
              <h3>团队负责人、主要开发者</h3>
              <p><span>东南大学化学化工学院</span><strong>张正明</strong></p>
            </section>

            <section>
              <h3>指导老师</h3>
              <p><span>东南大学计算机学院</span><strong>教授 冯磊</strong></p>
              <p><span>东南大学化学化工学院</span><strong>教授 梁爽</strong></p>
            </section>

            <section className="about-members-section">
              <h3>项目组成员</h3>
              <ul className="about-members">
                {PROJECT_MEMBERS.map((member) => (
                  <li key={member.name}><strong>{member.name}</strong><small>（{member.university}）</small></li>
                ))}
              </ul>
            </section>
          </div>

          <footer className="about-version">版本 1.0beta</footer>
        </div>
      </article>
    </dialog>
  );
}

function Message({ message, receipt, onToggleReceipt, onFeedback, onRetry }: { message: ChatMessage; receipt?: { count: number; open: boolean }; onToggleReceipt: () => void; onFeedback: (id: string, value: "understood" | "not-me", reason?: string) => Promise<void>; onRetry?: () => void }) {
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const assistant = message.role === "assistant";
  const activeTool = typeof message.metadata?.activeTool === "string" ? message.metadata.activeTool : null;
  const toolStartedAt = typeof message.metadata?.toolStartedAt === "number" ? message.metadata.toolStartedAt : null;
  const elapsedSeconds = useElapsedSeconds(activeTool === "web_search" ? toolStartedAt : null);
  const waitingLabel = activeTool === "web_search"
    ? `联网搜索中 ${elapsedSeconds}秒`
    : activeTool === "check_claims" ? "来源核验中" : "正在思考";
  return (
    <article className={assistant ? "message assistant" : "message user"}>
      <div className="message-content">{message.content || (message.metadata?.streaming ? <span className="thinking-status" role="status" aria-label={waitingLabel}><img src="/about/aliyun-cloud.png" alt="" />{activeTool === "web_search" ? <span>联网搜索中 {elapsedSeconds}秒</span> : activeTool === "check_claims" ? <span>来源核验中</span> : null}</span> : null)}</div>
      {message.metadata?.status === "interrupted" ? <div className="message-status">回复中断了，可以重试。</div> : null}
      {Array.isArray(message.metadata?.sources) && message.metadata.sources.length ? <details className="message-sources"><summary>查看事实来源（{message.metadata.sources.length}）</summary>{message.metadata.sources.map((source: any) => <a key={source.url} href={source.url} target="_blank" rel="noreferrer"><span>{source.title}</span>{source.siteName ? <small>{source.siteName}</small> : null}</a>)}</details> : null}
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

function useElapsedSeconds(startedAt: number | null) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === null) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  return startedAt === null ? 0 : Math.max(0, Math.floor((now - startedAt) / 1_000));
}

function SparkleDot() { return <span className="sparkle-dot" />; }

async function responseMessage(response: Response, fallback: string) {
  try {
    const body = await response.json();
    return typeof body.error === "string" ? body.error : fallback;
  } catch {
    return fallback;
  }
}
