import type { ChatMessage } from "@zhiwei/core/client";
import type { MessagePage } from "./client-types";

export type ConversationCache = Map<string, MessagePage>;
export type InflightTurn = { conversationId: string; user: ChatMessage; assistant: ChatMessage; retryOf?: string };

export function cacheConversation(cache: ConversationCache, id: string, page: MessagePage, protectedId?: string | null, inflightId?: string | null): ConversationCache {
  const next = new Map(cache);
  next.delete(id);
  next.set(id, page);
  while (next.size > 3) {
    const oldest = [...next.keys()].find((key) => key !== protectedId && key !== inflightId && key !== id);
    if (!oldest) break;
    next.delete(oldest);
  }
  return next;
}

export function mergeInflightTurn(page: MessagePage, turn: InflightTurn | null): MessagePage {
  if (!turn) return page;
  const protectedIds = new Set([turn.user.id, turn.assistant.id, turn.retryOf].filter(Boolean));
  return { ...page, messages: [...page.messages.filter((message) => !protectedIds.has(message.id)), turn.user, turn.assistant] };
}

export function prependMessagePage(current: MessagePage, older: MessagePage): MessagePage {
  const existing = new Set(current.messages.map((message) => message.id));
  return { ...older, messages: [...older.messages.filter((message) => !existing.has(message.id)), ...current.messages] };
}
