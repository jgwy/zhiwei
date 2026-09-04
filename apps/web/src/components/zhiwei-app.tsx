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
  Pencil,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  RotateCcw,
  Settings2,
  Square,
  ThumbsDown,
  ThumbsUp,
  X,
} from "lucide-react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from "react";
import dynamic from "next/dynamic";
import type { ChatMessage } from "@zhiwei/core/client";
import type { BootstrapData, ConversationMeta, MessagePage } from "@/lib/client-types";
import { readSseStream, formatTime } from "@/lib/utils";
import { isNearChatBottom } from "@/lib/chat-scroll";
import { resolveProfileReceiptMessageId } from "@/lib/profile-receipt";
import { cacheConversation, mergeInflightTurn, prependMessagePage, type ConversationCache, type InflightTurn } from "@/lib/conversation-cache";
import { createTextFrameBuffer } from "@/lib/text-frame-buffer";
import { shouldSubmitOnEnter } from "@/lib/keyboard";
import { browserTimeZone } from "@/lib/mood-date";
import { Button } from "@/components/ui/button";
import { Onboarding } from "@/components/onboarding";
import { InsightPanel } from "@/components/insight-panel";
import { SettingsPanel } from "@/components/settings-panel";
import { useToast } from "@/components/use-toast";
import { WaitingReply } from "@/components/waiting-reply";

const DeveloperPanel = dynamic(() => import("@/components/developer-panel").then((module) => module.DeveloperPanel), {
  loading: () => <div className="app-loading">正在打开开发者模式…</div>,
});
const EMPTY_PAGE: MessagePage = { messages: [], hasMore: false, nextCursor: null };

export function ZhiweiApp() {
  const [data, setData] = useState<BootstrapData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draft, setDraft] = useState({ value: "", revision: 0 });
  const draftValueRef = useRef("");
  const [streaming, setStreaming] = useState(false);
  const [pages, setPages] = useState<ConversationCache>(() => new Map());
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [loadingConversation, setLoadingConversation] = useState(false);
  const [insightOpen, setInsightOpen] = useState(true);
  const [mobileMenu, setMobileMenu] = useState<"conversations" | "insights" | null>(null);
  const [developerMode, setDeveloperMode] = useState(false);
  const [settingsMode, setSettingsMode] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<ConversationMeta | null>(null);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const { toast, showToast } = useToast();
  const [receipts, setReceipts] = useState<Record<string, string>>({});
  const abortRef = useRef<AbortController | null>(null);
  const messageScrollRef = useRef<HTMLDivElement | null>(null);
  const aboutTriggerRef = useRef<HTMLButtonElement | null>(null);
  const settingsTriggerRef = useRef<HTMLButtonElement | null>(null);
  const mobileNavRef = useRef<HTMLButtonElement | null>(null);
  const followLatestRef = useRef(true);
  const forceScrollRef = useRef(false);
  const lastScrolledConversationRef = useRef<string | null>(null);
  const dataRef = useRef<BootstrapData | null>(null);
  const loadSequenceRef = useRef(0);
  const pagesRef = useRef<ConversationCache>(new Map());
  const activeIdRef = useRef<string | null>(null);
  const inflightRef = useRef<InflightTurn | null>(null);
  const pageRequestsRef = useRef(new Map<string, Promise<void>>());
  const historyLoadingRef = useRef(false);
  const prependAnchorRef = useRef<{ conversationId: string; height: number; top: number } | null>(null);
  const insightRequestRef = useRef({ memories: 0, profile: 0, mood: 0 });

  function setInput(value: string) { draftValueRef.current = value; setDraft((current) => ({ value, revision: current.revision + 1 })); }

  function storePage(id: string, page: MessagePage) {
    pagesRef.current = cacheConversation(pagesRef.current, id, page, activeIdRef.current, inflightRef.current?.conversationId);
    setPages(pagesRef.current);
  }

  async function load(conversationId = activeIdRef.current) {
    const sequence = ++loadSequenceRef.current;
    try {
      const query = new URLSearchParams({ timeZone: browserTimeZone() });
      if (conversationId) query.set("conversationId", conversationId);
      const response = await fetch(`/api/bootstrap?${query}`, { cache: "no-store" });
      if (!response.ok) throw new Error(await responseMessage(response, "知微没有成功启动，请稍后重试。"));
      const next = (await response.json()) as BootstrapData;
      if (sequence !== loadSequenceRef.current) return;
      const { messagePage, ...metadata } = next;
      const snapshot = { ...metadata, messagePage: EMPTY_PAGE };
      setData(snapshot);
      dataRef.current = snapshot;
      setLoadError(null);
      const selected = next.activeConversationId;
      if (selected) storePage(selected, mergeInflightTurn(messagePage, inflightRef.current?.conversationId === selected ? inflightRef.current : null));
      activeIdRef.current = selected;
      setActiveId(selected);
    } catch (error) {
      if (sequence !== loadSequenceRef.current) return;
      setLoadError(error instanceof Error ? error.message : "知微没有成功启动，请稍后重试。");
    }
  }

  useEffect(() => { void load(); }, []);
  useEffect(() => {
    const channel = new BroadcastChannel("zhiwei-account");
    channel.onmessage = () => { void load(); };
    return () => channel.close();
  }, []);
  useEffect(() => { dataRef.current = data; }, [data]);
  const active = useMemo(
    () => {
      const meta = data?.conversations.find((conversation) => conversation.id === activeId);
      return meta ? { ...meta, ...(pages.get(meta.id) ?? EMPTY_PAGE) } : null;
    },
    [data?.conversations, activeId, pages],
  );
  const lastMessage = active?.messages.at(-1);
  const messageScrollSignal = `${activeId ?? "none"}:${active?.messages.length ?? 0}:${lastMessage?.id ?? "none"}:${lastMessage?.content.length ?? 0}:${lastMessage?.metadata?.status ?? ""}`;

  useLayoutEffect(() => {
    const anchor = prependAnchorRef.current;
    const container = messageScrollRef.current;
    if (!anchor || !container || anchor.conversationId !== activeId) return;
    container.scrollTop = anchor.top + container.scrollHeight - anchor.height;
    prependAnchorRef.current = null;
  }, [pages, activeId]);

  useEffect(() => {
    if (!data?.onboarding.complete || !activeId || loadingConversation) return;
    const candidates = data.conversations.filter((item) => item.id !== activeId).slice(0, 2);
    let cancelled = false;
    const prefetch = () => {
      for (const conversation of candidates) {
        if (!cancelled && !pagesRef.current.has(conversation.id)) void fetchConversationPage(conversation.id, true);
      }
    };
    const idle = window.requestIdleCallback?.(prefetch, { timeout: 2_000 });
    const timer = idle === undefined ? window.setTimeout(prefetch, 800) : undefined;
    return () => { cancelled = true; if (idle !== undefined) window.cancelIdleCallback(idle); window.clearTimeout(timer); };
  }, [data?.conversations, data?.onboarding.complete, activeId, loadingConversation]);

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
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pending = new Set<"memories" | "profile" | "mood">();
    const refresh = (...resources: Array<"memories" | "profile" | "mood">) => {
      for (const resource of resources) pending.add(resource);
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        const batch = [...pending];
        pending.clear();
        void refreshInsights(batch);
      }, 150);
    };
    source.addEventListener("memory.updated", () => refresh("memories", "profile", "mood"));
    source.addEventListener("mood.updated", () => refresh("mood"));
    source.addEventListener("account.restored", () => { void load(); });
    source.addEventListener("profile.updated", (raw) => {
      const event = JSON.parse((raw as MessageEvent).data);
      const payload = event.payload ?? {};
      const conversations = (dataRef.current?.conversations ?? []).map((conversation) => ({ ...conversation, messages: pagesRef.current.get(conversation.id)?.messages ?? [] }));
      const messageId = resolveProfileReceiptMessageId(conversations, payload);
      if (messageId) {
        const receipt = typeof payload.receipt === "string" ? payload.receipt : "知微重新整理了对你的长期认识。";
        setReceipts((current) => ({ ...current, [messageId]: receipt }));
      }
      if (payload.profile) {
        ++insightRequestRef.current.profile;
        setData((current) => current ? { ...current, profile: payload.profile } : current);
      }
      else refresh("profile");
    });
    source.addEventListener("skill.evolved", (raw) => {
      const event = JSON.parse((raw as MessageEvent).data);
      showToast(event.payload.message ?? "知微又更了解你一点。");
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
    return () => { source.close(); clearTimeout(timer); };
  }, [data?.onboarding.complete, data?.user.id, showToast]);

  const actionRef = useRef({ feedback, retryMessage, sendMessage, startMemoryCorrection, withdrawMemory });
  actionRef.current = { feedback, retryMessage, sendMessage, startMemoryCorrection, withdrawMemory };
  const handleFeedback = useCallback((...args: Parameters<typeof feedback>) => actionRef.current.feedback(...args), []);
  const handleRetry = useCallback((id: string) => { void actionRef.current.retryMessage(id); }, []);
  const handleSend = useCallback((content: string) => { void actionRef.current.sendMessage(content); }, []);
  const handleStop = useCallback(() => abortRef.current?.abort(), []);
  const handleMemoryCorrection = useCallback((content: string) => actionRef.current.startMemoryCorrection(content), []);
  const handleWithdraw = useCallback((memoryId: string, versionId: string) => actionRef.current.withdrawMemory(memoryId, versionId), []);
  const handleDraftChange = useCallback((content: string) => { draftValueRef.current = content; }, []);
  useEffect(() => () => abortRef.current?.abort(), []);

  if (!data) return <InitialLoading error={loadError} onRetry={() => void load()} />;
  if (!data.onboarding.complete) return <Onboarding onboarding={data.onboarding} onAccountRestored={() => load()} onComplete={async () => {
    const response = await fetch("/api/onboarding/complete", { method: "POST" });
    if (!response.ok) throw new Error(await responseMessage(response, "暂时无法开始聊天，请稍后再试。"));
    await load();
  }} />;
  if (settingsMode) return <><SettingsPanel settings={data.user.settings} onClose={closeSettings} onSettings={updateSettings} onDeleteAll={deleteAllData} /><ToastNotice toast={toast} /></>;
  if (developerMode) return <><DeveloperPanel onClose={() => setDeveloperMode(false)} /><ToastNotice toast={toast} /></>;

  async function refreshInsights(resources: Array<"memories" | "profile" | "mood"> = ["memories", "profile", "mood"]) {
    try {
      const results = await Promise.all(resources.map(async (resource) => {
        const sequence = ++insightRequestRef.current[resource];
        const query = resource === "mood" ? `?${new URLSearchParams({ timeZone: browserTimeZone() })}` : "";
        const response = await fetch(`/api/${resource}${query}`, { cache: "no-store" });
        if (!response.ok) throw new Error(await responseMessage(response, "新的认识暂时没有加载成功。"));
        return { resource, sequence, payload: await response.json() };
      }));
      setData((current) => current ? { ...current, ...Object.assign({}, ...results.filter((result) => insightRequestRef.current[result.resource] === result.sequence).map((result) => result.payload)) } : current);
    } catch (error) { showToast(error instanceof Error ? error.message : "新的认识暂时没有加载成功。"); }
  }

  async function fetchConversationPage(id: string, prefetch = false) {
    const pending = pageRequestsRef.current.get(id);
    if (pending) return pending;
    const atRequest = pagesRef.current.get(id);
    const request = (async () => {
      try {
        const response = await fetch(`/api/conversations/${id}/messages`, { cache: "no-store" });
        if (!response.ok) throw new Error(await responseMessage(response, "对话暂时没有加载成功，请重试。"));
        let page = await response.json() as MessagePage;
        const current = pagesRef.current.get(id);
        if (current && current !== atRequest) {
          const messages = new Map(page.messages.map((message) => [message.id, message]));
          for (const message of current.messages) messages.set(message.id, message);
          page = { ...page, messages: [...messages.values()] };
        }
        storePage(id, mergeInflightTurn(page, inflightRef.current?.conversationId === id ? inflightRef.current : null));
      } catch (error) {
        if (!prefetch) showToast(error instanceof Error ? error.message : "对话暂时没有加载成功，请重试。");
      }
    })();
    pageRequestsRef.current.set(id, request);
    try { await request; } finally { pageRequestsRef.current.delete(id); }
  }

  async function selectConversation(id: string) {
    ++loadSequenceRef.current;
    activeIdRef.current = id;
    setActiveId(id);
    setMobileMenu(null);
    followLatestRef.current = true;
    forceScrollRef.current = true;
    const cached = pagesRef.current.get(id);
    if (cached) { storePage(id, cached); setLoadingConversation(false); return; }
    setLoadingConversation(true);
    await fetchConversationPage(id);
    if (activeIdRef.current === id) setLoadingConversation(false);
  }

  async function loadOlderMessages() {
    const id = activeIdRef.current;
    const current = id ? pagesRef.current.get(id) : null;
    if (!id || !current?.hasMore || !current.nextCursor || historyLoadingRef.current) return;
    historyLoadingRef.current = true;
    setLoadingHistory(true);
    try {
      const response = await fetch(`/api/conversations/${id}/messages?before=${encodeURIComponent(current.nextCursor)}`, { cache: "no-store" });
      if (!response.ok) throw new Error(await responseMessage(response, "更早的消息没有加载成功，请重试。"));
      const older = await response.json() as MessagePage;
      const container = messageScrollRef.current;
      if (id === activeIdRef.current && container) {
        followLatestRef.current = false;
        prependAnchorRef.current = { conversationId: id, height: container.scrollHeight, top: container.scrollTop };
      }
      storePage(id, prependMessagePage(pagesRef.current.get(id) ?? current, older));
    } catch (error) { showToast(error instanceof Error ? error.message : "更早的消息没有加载成功，请重试。"); }
    finally { historyLoadingRef.current = false; setLoadingHistory(false); }
  }

  async function createConversation() {
    const response = await fetch("/api/conversations", { method: "POST" });
    if (!response.ok) throw new Error(await responseMessage(response, "新的对话没有创建成功，请重试。"));
    const result = await response.json();
    const conversation: ConversationMeta = { ...result.conversation, messageCount: 0 };
    setData((current) => current ? { ...current, conversations: [conversation, ...current.conversations] } : current);
    storePage(conversation.id, EMPTY_PAGE);
    await selectConversation(conversation.id);
    setMobileMenu(null);
  }

  async function renameConversation(conversation: ConversationMeta, nextTitle: string) {
    const title = nextTitle.trim();
    if (!title || title === conversation.title) return true;
    try {
      const response = await fetch(`/api/conversations/${conversation.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title }),
      });
      if (!response.ok) {
        showToast(await responseMessage(response, "标题没有修改成功，请重试。"));
        return false;
      }
      setData((current) => current ? { ...current, conversations: current.conversations.map((item) => item.id === conversation.id ? { ...item, title, titleSource: "manual", titleLocked: true } : item) } : current);
      return true;
    } catch {
      showToast("标题没有修改成功，请检查网络后重试。");
      return false;
    }
  }

  async function sendMessage(content: string) {
    const text = content.trim();
    if (!text || abortRef.current) return;
    const abort = new AbortController();
    abortRef.current = abort;
    setStreaming(true);
    let conversationId = activeIdRef.current;
    try {
      if (!conversationId) {
        const response = await fetch("/api/conversations", { method: "POST", signal: abort.signal });
        if (!response.ok) throw new Error(await responseMessage(response, "无法创建新的对话，请重试。"));
        const created = await response.json();
        conversationId = created.conversation.id;
        setData((current) => current ? { ...current, conversations: [{ ...created.conversation, messageCount: 0 }, ...current.conversations] } : current);
      }
      if (!conversationId) throw new Error("无法创建新的对话");
      activeIdRef.current = conversationId;
      setActiveId(conversationId);
      const userMessage: ChatMessage = { id: crypto.randomUUID(), role: "user", content: text, createdAt: new Date().toISOString() };
      const assistantTemp: ChatMessage = { id: crypto.randomUUID(), role: "assistant", content: "", createdAt: new Date().toISOString(), metadata: { streaming: true } };
      await runTurn({ conversationId, user: userMessage, assistant: assistantTemp }, abort);
    } catch (error) {
      if (!abort.signal.aborted) showToast(error instanceof Error ? error.message : "这句话没有送达，请重试。");
      if (abortRef.current === abort) { abortRef.current = null; setStreaming(false); }
    }
  }

  async function retryMessage(assistantId: string) {
    const conversationId = activeIdRef.current;
    const messages = conversationId ? pagesRef.current.get(conversationId)?.messages ?? [] : [];
    if (!conversationId || abortRef.current || messages.at(-1)?.id !== assistantId) return;
    const previous = [...messages.slice(0, -1)].reverse().find((message) => message.role === "user");
    if (!previous) return;
    const abort = new AbortController();
    abortRef.current = abort;
    setStreaming(true);
    const assistant: ChatMessage = { id: crypto.randomUUID(), role: "assistant", content: "", createdAt: new Date().toISOString(), metadata: { streaming: true } };
    await runTurn({ conversationId, user: previous, assistant, retryOf: assistantId }, abort);
  }

  async function runTurn(turn: InflightTurn, abort: AbortController) {
    const { conversationId } = turn;
    inflightRef.current = turn;
    followLatestRef.current = true;
    forceScrollRef.current = true;
    setShowJumpToLatest(false);
    storePage(conversationId, mergeInflightTurn(pagesRef.current.get(conversationId) ?? EMPTY_PAGE, turn));
    setInput("");
    let completed = false;
    let started = false;
    const textBuffer = createTextFrameBuffer((delta) => {
      if (abortRef.current !== abort) return;
      turn.assistant = { ...turn.assistant, content: turn.assistant.content + delta };
      updateConversationMessages(conversationId, (messages) => messages.map((message) => message.id === turn.assistant.id ? turn.assistant : message));
    });
    const finishStreaming = () => {
      if (abortRef.current !== abort) return;
      abortRef.current = null;
      inflightRef.current = null;
      setStreaming(false);
    };
    const updateStatus = (status: string, metadata: Record<string, unknown> = {}) => {
      turn.assistant = { ...turn.assistant, metadata: { ...turn.assistant.metadata, ...metadata, streaming: false, status } };
      updateConversationMessages(conversationId, (messages) => messages.map((message) => message.id === turn.assistant.id ? turn.assistant : message));
    };
    try {
      const url = turn.retryOf ? `/api/conversations/${conversationId}/messages/${turn.retryOf}/retry` : `/api/conversations/${conversationId}/messages`;
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(turn.retryOf ? {} : { content: turn.user.content, clientRequestId: turn.user.id }),
        signal: abort.signal,
      });
      if (!response.ok) throw new Error(await responseMessage(response, "这句话没能送达，请再试一次。"));
      await readSseStream(response, (event) => {
        if (abortRef.current !== abort) return;
        if (event.type === "message.started") {
          started = true;
          const temporaryUserId = turn.user.id;
          const temporaryAssistantId = turn.assistant.id;
          if (event.userMessage) turn.user = event.userMessage;
          turn.assistant = { ...turn.assistant, id: event.messageId, metadata: { traceId: event.traceId, streaming: true } };
          updateConversationMessages(conversationId, (messages) => messages.map((message) => message.id === temporaryUserId ? turn.user : message.id === temporaryAssistantId ? turn.assistant : message));
        }
        if (event.type === "text.delta") {
          textBuffer.push(event.delta);
        }
        if (event.type === "phase") {
          turn.assistant = { ...turn.assistant, metadata: { ...turn.assistant.metadata, phase: event.message, phaseStage: event.stage, phaseStartedAt: event.startedAt } };
          updateConversationMessages(conversationId, (messages) => messages.map((message) => message.id === turn.assistant.id ? turn.assistant : message));
        }
        if (event.type === "message.completed") {
          completed = true;
          textBuffer.flush();
          updateStatus(event.status ?? "completed", { sources: event.sources ?? [] });
          finishStreaming();
        }
        if (event.type === "error") {
          throw new Error(event.message);
        }
      });
    } catch (error) {
      if (abortRef.current === abort && !abort.signal.aborted) showToast(error instanceof Error ? error.message : "回复中断了，可以重试。");
    } finally {
      textBuffer.flush();
      textBuffer.dispose();
      if (!completed && abortRef.current === abort) updateStatus(abort.signal.aborted ? "stopped" : "interrupted");
      finishStreaming();
      // If the request failed before the server acknowledged it, reconcile once;
      // the response may have been persisted even when the network disconnected.
      if (!started) await fetchConversationPage(conversationId);
      if (!started && !turn.retryOf && activeIdRef.current === conversationId && !abortRef.current
        && !pagesRef.current.get(conversationId)?.messages.some((message) => message.id === turn.user.id || message.metadata?.clientRequestId === turn.user.id)) setInput(turn.user.content);
    }
  }

  function updateConversationMessages(conversationId: string, updater: (messages: ChatMessage[]) => ChatMessage[]) {
    const page = pagesRef.current.get(conversationId) ?? EMPTY_PAGE;
    storePage(conversationId, { ...page, messages: updater(page.messages) });
  }

  async function feedback(messageId: string, value: "understood" | "not-me", reason?: string) {
    const response = await fetch("/api/feedback", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messageId, value, reason }) });
    if (!response.ok) throw new Error(await responseMessage(response, "这次反馈没有保存成功，请重试。"));
    showToast(value === "understood" ? "谢谢你告诉我，我会留意这种相处方式。" : "谢谢你纠正我，我会重新调整。");
  }

  async function updateSettings(settings: Record<string, boolean>) {
    const response = await fetch("/api/settings", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(settings) });
    if (!response.ok) throw new Error(await responseMessage(response, "设置没有保存成功，请重试。"));
    const result = await response.json();
    setData((current) => current ? { ...current, user: { ...current.user, settings: result.settings ?? { ...current.user.settings, ...settings } } } : current);
    if (result.warning) {
      showToast(result.warning);
    }
  }

  async function withdrawMemory(memoryId: string, versionId: string) {
    const response = await fetch(`/api/memories/${memoryId}/withdraw`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ versionId, reason: "用户在画像界面主动撤回" }),
    });
    if (response.status === 409) {
      showToast("这条认识刚刚发生了变化，已为你刷新。");
      await refreshInsights();
      return;
    }
    if (!response.ok) throw new Error(await responseMessage(response, "这条认识没有撤回成功，请重试。"));
    showToast("这条认识已撤回，之后不会再用于回答。");
    await refreshInsights();
  }

  async function deleteAllData(confirmation: string) {
    const response = await fetch("/api/user/data", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmation }),
    });
    if (!response.ok) throw new Error(await responseMessage(response, "数据删除没有完成；你的数据仍然保留。"));
    window.location.replace("/");
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
    if (container.scrollTop < 100 && !nearBottom) void loadOlderMessages();
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

  function openSettings() {
    setMobileMenu(null);
    setSettingsMode(true);
  }

  function closeSettings() {
    setSettingsMode(false);
    window.requestAnimationFrame(() => {
      const returnTarget = window.innerWidth < 900 ? mobileNavRef.current : settingsTriggerRef.current;
      if (document.activeElement === document.body) returnTarget?.focus();
    });
  }

  function closeAbout() {
    setAboutOpen(false);
    window.requestAnimationFrame(() => {
      const returnTarget = window.innerWidth < 900 ? mobileNavRef.current : aboutTriggerRef.current;
      if (document.activeElement === document.body) returnTarget?.focus();
    });
  }

  return (
    <main className={insightOpen ? "app-shell" : "app-shell insight-closed"}>
      <aside className={`conversation-sidebar ${mobileMenu === "conversations" ? "mobile-open" : ""}`}>
        <div className="sidebar-brand"><span>知微</span><button className="mobile-close" onClick={() => setMobileMenu(null)}><X size={18} /></button></div>
        <Button variant="secondary" className="new-chat-button" onClick={() => void createConversation().catch((error) => showToast(error.message))}><Plus size={17} /> 新的对话</Button>
        <nav className="conversation-list">
          {data.conversations.map((conversation) => <div className={conversation.id === activeId ? "conversation-row active" : "conversation-row"} key={conversation.id}><button className="conversation-open" onClick={() => void selectConversation(conversation.id)}><MessageCircleMore size={16} /><span>{conversation.title}</span></button><button className="conversation-more" onClick={() => setRenameTarget(conversation)} aria-label={`管理对话：${conversation.title}`} aria-haspopup="dialog"><MoreHorizontal size={16} /></button></div>)}
        </nav>
        <div className="sidebar-footer">
          <button ref={settingsTriggerRef} onClick={openSettings}><Settings2 size={16} /><span>设置</span></button>
          <button ref={aboutTriggerRef} onClick={openAbout}><Info size={16} /><span>关于</span></button>
          {data.developerModeAvailable ? <button onClick={() => setDeveloperMode(true)}><Code2 size={16} /><span>开发者模式</span></button> : null}
          <div className="adapter-badge"><i />{data.modelModeLabel}</div>
        </div>
      </aside>

      <section className="chat-column">
        <header className="chat-header">
          <button ref={mobileNavRef} className="mobile-nav-button" onClick={() => setMobileMenu("conversations")}><Menu size={19} /></button>
          <div><strong>{active?.title ?? "新的对话"}</strong><span>记忆会在授权后用于个性化对话；AI 生成内容请注意核查</span></div>
          <button className="insight-toggle" onClick={() => { if (window.innerWidth < 900) setMobileMenu("insights"); else setInsightOpen(!insightOpen); }} aria-label="打开或收起洞察栏">{insightOpen ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}</button>
        </header>

        <div className="message-scroll" ref={messageScrollRef} onScroll={handleMessageScroll}>
          {loadingConversation ? <div className="conversation-loading" role="status">正在读取这段对话…</div> : null}
          {active?.hasMore ? <button className="load-older-messages" onClick={() => void loadOlderMessages()} disabled={loadingHistory}>{loadingHistory ? "正在读取更早的消息…" : "查看更早的消息"}</button> : null}
          {data.returnNote ? <button className="return-note" onClick={() => setInput(data.returnNote!.content)}><span>上次说到这里</span><p>{data.returnNote.content}</p><ChevronRight size={17} /></button> : null}
          {!active?.messages.length && !loadingConversation ? (
            <div className="empty-conversation"><div className="empty-word">知微</div><h1>现在，你想从哪里聊起？</h1><p>可以是一件具体的事，也可以只是此刻说不清楚的心情。</p><div>{["最近脑子有点乱", "我有件事拿不定主意", "只是想找个人说说话"].map((prompt) => <button key={prompt} onClick={() => setInput(prompt)}>{prompt}</button>)}</div></div>
          ) : (
            <div className="messages">
              {(active?.messages ?? []).map((message, index, messages) => (
                <Message
                  key={message.id}
                  message={message}
                  receipt={receipts[message.id] ?? (typeof message.metadata?.memoryReceipt === "string" ? message.metadata.memoryReceipt : undefined)}
                  onFeedback={handleFeedback}
                  onRetry={message.role === "assistant" && index === messages.length - 1 && !streaming ? handleRetry : undefined}
                  onError={showToast}
                />
              ))}
            </div>
          )}
        </div>

        {showJumpToLatest ? <button className="jump-to-latest" onClick={scrollToLatest}><ArrowDown size={15} /><span>回到最新</span></button> : null}

        <Composer draft={draft} initialDraft={draftValueRef.current} streaming={streaming} onDraftChange={handleDraftChange} onSend={handleSend} onStop={handleStop} />
      </section>

      <div className={`insight-drawer ${mobileMenu === "insights" ? "mobile-open" : ""}`}>
        <button className="mobile-insight-close" onClick={() => setMobileMenu(null)}><ChevronLeft size={18} /> 返回对话</button>
        <InsightPanel
          data={data}
          onMemoryCorrect={handleMemoryCorrection}
          onWithdraw={handleWithdraw}
          accountBusy={streaming}
          onAccountUpdated={async () => {
            // Drop old in-flight insight responses; retain chat pages and the current draft.
            for (const key of ["memories", "profile", "mood"] as const) ++insightRequestRef.current[key];
            await load();
          }}
        />
      </div>
      {mobileMenu ? <button className="mobile-scrim" onClick={() => setMobileMenu(null)} aria-label="关闭面板" /> : null}
      {aboutOpen ? <AboutDialog onClose={closeAbout} /> : null}
      {renameTarget ? <RenameConversationDialog conversation={renameTarget} onClose={() => setRenameTarget(null)} onSave={async (title) => {
        const saved = await renameConversation(renameTarget, title);
        if (saved) setRenameTarget(null);
        return saved;
      }} /> : null}
      <ToastNotice toast={toast} />
    </main>
  );
}

function ToastNotice({ toast }: { toast: ReturnType<typeof useToast>["toast"] }) {
  return toast ? <div className={`toast${toast.fading ? " toast-leaving" : ""}`} role="status" aria-live="polite"><Check size={16} />{toast.message}</div> : null;
}

function InitialLoading({ error, onRetry }: { error: string | null; onRetry: () => void }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => { const timer = setTimeout(() => setSlow(true), 6_000); return () => clearTimeout(timer); }, []);
  return <div className="app-loading"><div className="loading-mark">知微</div><span role="status">{error ?? (slow ? "加载比平时久一点，仍在读取你的对话…" : "正在准备一段安静的对话…")}</span>{error ? <button onClick={onRetry}>重新加载</button> : null}</div>;
}

const Composer = memo(function Composer({ draft, initialDraft, streaming, onDraftChange, onSend, onStop }: { draft: { value: string; revision: number }; initialDraft: string; streaming: boolean; onDraftChange: (content: string) => void; onSend: (content: string) => void; onStop: () => void }) {
  const [input, setInput] = useState(initialDraft);
  const appliedDraftRef = useRef(draft.revision);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const composingRef = useRef(false);
  useEffect(() => {
    if (appliedDraftRef.current === draft.revision) return;
    appliedDraftRef.current = draft.revision;
    setInput(draft.value);
  }, [draft]);
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(180, Math.max(38, textarea.scrollHeight))}px`;
    textarea.style.overflowY = textarea.scrollHeight > 180 ? "auto" : "hidden";
  }, [input]);
  function send() { if (input.trim() && !streaming) onSend(input); }
  return <div className="composer-wrap"><div className="chat-composer">
    <textarea ref={textareaRef} value={input} onChange={(event) => { setInput(event.target.value); onDraftChange(event.target.value); }} onCompositionStart={() => { composingRef.current = true; }} onCompositionEnd={() => { composingRef.current = false; }} onKeyDown={(event) => { if (shouldSubmitOnEnter(event, composingRef.current)) { event.preventDefault(); send(); } }} rows={1} placeholder="和知微说点什么…" aria-label="消息内容" />
    {streaming ? <Button size="icon" variant="primary" onClick={onStop} aria-label="停止回复"><Square size={15} fill="currentColor" /></Button> : <Button size="icon" variant="primary" onClick={send} disabled={!input.trim()} aria-label="发送消息"><ArrowUp size={18} /></Button>}
  </div><small>按 Enter 发送 · 按 Shift + Enter 换行</small></div>;
});

function RenameConversationDialog({ conversation, onClose, onSave }: { conversation: ConversationMeta; onClose: () => void; onSave: (title: string) => Promise<boolean> }) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const [title, setTitle] = useState(conversation.title);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextTitle = title.trim();
    if (!nextTitle || saving) return;
    setSaving(true);
    const saved = await onSave(nextTitle);
    if (!saved) setSaving(false);
  }

  return (
    <dialog ref={dialogRef} className="rename-dialog" aria-labelledby="rename-dialog-title" onCancel={(event) => { event.preventDefault(); onClose(); }} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <form className="rename-dialog-card" onSubmit={submit}>
        <div className="rename-dialog-heading"><span><Pencil size={16} /></span><div><h2 id="rename-dialog-title">修改对话名称</h2><p>手动修改后，知微不会再自动覆盖这个标题。</p></div></div>
        <label htmlFor="conversation-title">对话名称</label>
        <input id="conversation-title" value={title} onChange={(event) => setTitle(event.target.value)} onFocus={(event) => event.currentTarget.select()} maxLength={36} autoFocus />
        <div className="rename-dialog-actions"><button type="button" onClick={onClose} disabled={saving}>取消</button><button type="submit" disabled={!title.trim() || saving}>{saving ? "正在保存…" : "保存"}</button></div>
      </form>
    </dialog>
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

          <section className="about-cloud">
            <h3>我们如何使用阿里云相关技术</h3>
            <p>知微以阿里云作为模型能力与云端运行底座，对话生成、结构化理解、记忆提炼和事实查证等智能任务均由阿里云相关模型服务支持。应用现已部署在阿里云服务器上，开发过程完全使用 Qoder，覆盖需求拆解、代码实现、调试测试与持续迭代。</p>
          </section>

          <div className="about-team">
            <section>
              <h3>团队负责人、主要开发者</h3>
              <div className="about-lead-profile">
                <strong>张正明</strong>
                <div><span>东南大学化学化工学院25级本科生</span><span>Datawhale 成员</span><span>ModelScope 社区开发者</span></div>
              </div>
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

const Message = memo(function Message({ message, receipt, onFeedback, onRetry, onError }: { message: ChatMessage; receipt?: string; onFeedback: (id: string, value: "understood" | "not-me", reason?: string) => Promise<void>; onRetry?: (id: string) => void; onError: (message: string) => void }) {
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const assistant = message.role === "assistant";
  return (
    <article className={assistant ? "message assistant" : "message user"}>
      <div className="message-content">{message.content || (message.metadata?.streaming ? <WaitingReply phase={typeof message.metadata.phase === "string" ? message.metadata.phase : undefined} stage={typeof message.metadata.phaseStage === "string" ? message.metadata.phaseStage : undefined} startedAt={typeof message.metadata.phaseStartedAt === "string" ? message.metadata.phaseStartedAt : undefined} /> : null)}</div>
      {message.metadata?.status === "interrupted" ? <div className="message-status">回复中断了，可以重试。</div> : null}
      {message.metadata?.status === "stopped" ? <div className="message-status">已停止</div> : null}
      {Array.isArray(message.metadata?.sources) && message.metadata.sources.length ? <details className="message-sources"><summary>查看事实来源（{message.metadata.sources.length}）</summary>{message.metadata.sources.map((source: any) => <a key={source.url} href={source.url} target="_blank" rel="noreferrer"><span>{source.title}</span>{source.siteName ? <small>{source.siteName}</small> : null}</a>)}</details> : null}
      <footer>
        <time>{formatTime(message.createdAt)}</time>
        {assistant && (message.content || onRetry) ? <div className={`message-actions${!message.content ? " message-actions-visible" : ""}`}>
          {message.content ? <><button onClick={() => void navigator.clipboard.writeText(message.content).catch(() => onError("复制没有成功，请重试。"))} aria-label="复制"><Clipboard size={14} /></button><button onClick={() => void onFeedback(message.id, "understood").catch((error) => onError(error.message))} aria-label="有被懂到"><ThumbsUp size={14} /></button><button onClick={() => setFeedbackOpen(!feedbackOpen)} aria-label="不太像我"><ThumbsDown size={14} /></button></> : null}
          {onRetry ? <button onClick={() => onRetry(message.id)} aria-label={message.metadata?.status === "completed" ? "重新生成" : "重试"}><RotateCcw size={14} /></button> : null}
        </div> : null}
      </footer>
      {feedbackOpen ? <div className="feedback-reasons"><span>哪里不太像你？</span>{["语气不对", "记错了", "建议不贴合", "太像模板"].map((reason) => <button key={reason} onClick={() => { void onFeedback(message.id, "not-me", reason).catch((error) => onError(error.message)); setFeedbackOpen(false); }}>{reason}</button>)}</div> : null}
      {assistant && receipt ? <div className="memory-receipt"><SparkleDot />{receipt}</div> : null}
    </article>
  );
});

function SparkleDot() { return <span className="sparkle-dot" />; }

async function responseMessage(response: Response, fallback: string) {
  try {
    const body = await response.json();
    return typeof body.error === "string" ? body.error : fallback;
  } catch {
    return fallback;
  }
}
