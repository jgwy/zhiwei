import type { ConversationView } from "@/lib/client-types";

export function resolveProfileReceiptMessageId(conversations: readonly ConversationView[], payload: Record<string, unknown>) {
  const assistantMessageId = typeof payload.assistantMessageId === "string" ? payload.assistantMessageId : typeof payload.assistant_message_id === "string" ? payload.assistant_message_id : null;
  if (assistantMessageId) {
    const exists = conversations.some((conversation) => conversation.messages.some((message) => message.id === assistantMessageId && message.role === "assistant"));
    if (exists) return assistantMessageId;
  }

  const traceId = typeof payload.traceId === "string" ? payload.traceId : typeof payload.trace_id === "string" ? payload.trace_id : null;
  if (traceId) {
    for (const conversation of conversations) {
      const match = conversation.messages.find((message) => message.role === "assistant" && message.metadata?.traceId === traceId);
      if (match) return match.id;
    }
  }

  const sourceMessageId = typeof payload.sourceMessageId === "string" ? payload.sourceMessageId : typeof payload.source_message_id === "string" ? payload.source_message_id : null;
  if (!sourceMessageId) return null;
  for (const conversation of conversations) {
    const sourceIndex = conversation.messages.findIndex((message) => message.id === sourceMessageId);
    if (sourceIndex < 0) continue;
    const source = conversation.messages[sourceIndex];
    if (!source) continue;
    if (source.role === "assistant") return source.id;
    return conversation.messages.slice(sourceIndex + 1).find((message) => message.role === "assistant")?.id ?? null;
  }
  return null;
}
